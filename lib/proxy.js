const MitmProxy = require("http-mitm-proxy");
const { promisify } = require("util");
const { exec } = require("child_process");

const utils = require("./utils");

const execPromise = promisify(exec);

class Proxy {
  constructor(options) {
    this.url = options.url;
    this.dsn = options.dsn;
    this.buildId = options.buildId;
    this.port = options.port || 8063;
    this.sentryVersion = options.sentryVersion || "5.4.3";
    this.domains = options.domains || [];

    this._process = null;
  }

  async init() {
    this._server = await this.makeProxy();
    this._server.onError((ctx, err, errorKind) => {
      var url =
        ctx && ctx.clientToProxyRequest ? ctx.clientToProxyRequest.url : "";
      console.error(errorKind + " on " + url + ":", err);
    });

    this._server.onRequest((ctx, callback) => {
      if (
        utils.isLinkAllowed(
          `http${ctx.isSSL ? "s" : ""}://${
            ctx.clientToProxyRequest.headers.host
          }/${ctx.clientToProxyRequest.url}`,
          this.domains
        )
      ) {
        ctx.onResponseData((ctx, chunk, callback) => {
          chunk = new Buffer(
            chunk
              .toString()
              .replace(/(<body[^>]+)>/g, `$1${this.getSentryBinding()}`)
          );
          // console.log(chunk.toString());
          return callback(null, chunk);
        });
      }
      return callback();
    });
  }

  async close() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  async makeProxy() {
    // LINUX
    // const nssDbPath = os.homedir() + '/.pki/nssdb';
    // try {
    //   fs.statSync(nssDbPath);
    // } catch (err) {
    //   fs.mkdirSync(nssDbPath, {recursive: true});
    //   await execPromise('certutil -d sql:$HOME/.pki/nssdb -N --empty-password');
    // }

    const proxy = MitmProxy();
    proxy.use(MitmProxy.wildcard);
    proxy.use(MitmProxy.gunzip);
    return new Promise((resolve, reject) => {
      proxy.listen({ port: this.port, silent: !this.debug }, async err => {
        if (err) return reject(err);
        // Add CA certificate to chromium and return initialize proxy object
        await execPromise(
          "openssl x509 -outform der -in ./.http-mitm-proxy/certs/ca.pem -out ./.http-mitm-proxy/certs/ca.crt"
        );
        await execPromise(
          "security add-certificate ./.http-mitm-proxy/certs/ca.crt || exit 0"
        );
        await execPromise(
          "security add-trusted-cert ./.http-mitm-proxy/certs/ca.crt || exit 0"
        );
        resolve(proxy);
        // LINUX
        // execPromise(
        //   'certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n mitm-ca -i ./.http-mitm-proxy/certs/ca.pem'
        // )
        //   .then(() => resolve(proxy))
        //   .catch(reject);
      });
    });
  }

  getSentryBinding() {
    return `
  <script src="https://browser.sentry-cdn.com/${
    this.sentryVersion
  }/bundle.min.js" crossorigin="anonymous"></script>
  <script>
  Sentry.init({
    dsn: ${JSON.stringify(this.dsn)},
    environment: 'test'
  });
  Sentry.configureScope(function(scope) {
    scope.setContext("build", {
      id: ${JSON.stringify(this.buildId)}
    });
  });
  </script>
  `;
  }

  address() {
    return `localhost:${this.port}`;
  }
}

module.exports = Proxy;
