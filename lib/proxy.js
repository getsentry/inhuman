const MitmProxy = require("http-mitm-proxy");
const os = require("os");
const fs = require("fs");

const utils = require("./utils");

const isMac = os.platform() === "darwin";

class Proxy {
  constructor(options) {
    this.url = options.url;
    this.dsn = options.dsn;
    this.buildId = options.buildId;
    this.port = options.port || 8063;
    this.sentryVersion = options.sentryVersion || "5.4.3";
    this.domains = options.domains || [];
    this.verbose = options.verbose || false;

    this._process = null;
  }

  async init() {
    this._server = await this.makeProxy();
    this._server.onError((ctx, err, errorKind) => {
      var url =
        ctx && ctx.clientToProxyRequest ? ctx.clientToProxyRequest.url : "";
      console.error(errorKind + " on " + url + ":", err);
    });

    if (this.hasSentry()) {
      this._server.onRequest((ctx, callback) => {
        const requestUrl = `http${ctx.isSSL ? "s" : ""}://${
          ctx.clientToProxyRequest.headers.host
        }${ctx.clientToProxyRequest.url}`;
        if (utils.isLinkAllowed(requestUrl, this.domains)) {
          ctx.onResponseData((ctx, chunk, callback) => {
            const contentType =
              ctx.serverToProxyResponse.headers["content-type"] || "";
            if (contentType.indexOf("text/html") === 0) {
              let chunkStr = chunk.toString();
              if (
                chunkStr.indexOf(this.dsn) === -1 &&
                chunkStr.indexOf("<head") !== -1
              ) {
                this.verbose &&
                  console.debug(`Injecting Sentry into ${requestUrl}`);
                chunk = new Buffer(
                  chunkStr.replace(
                    /(<head[^>]*?>)/g,
                    `$1${this.getSentryBinding()}`
                  )
                );
              }
            }
            return callback(null, chunk);
          });
        }
        return callback();
      });
    }
  }

  async close() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  async makeProxy() {
    if (!isMac) {
      const nssDbPath = os.homedir() + "/.pki/nssdb";
      try {
        fs.statSync(nssDbPath);
      } catch (err) {
        await utils.execPromise("mkdir -p $HOME/.pki/nssdb");
        await utils.execPromise(
          "certutil -d sql:$HOME/.pki/nssdb -N --empty-password"
        );
      }
    }

    const proxy = MitmProxy();
    proxy.use(MitmProxy.wildcard);
    proxy.use(MitmProxy.gunzip);
    return new Promise((resolve, reject) => {
      proxy.listen({ port: this.port, silent: !this.debug }, async err => {
        if (err) return reject(err);
        // Add CA certificate to chromium and return initialize proxy object
        if (isMac) {
          await utils.execPromise(
            "openssl x509 -outform der -in ./.http-mitm-proxy/certs/ca.pem -out ./.http-mitm-proxy/certs/ca.crt"
          );
          try {
            await utils.execPromise(
              "security add-certificate ./.http-mitm-proxy/certs/ca.crt"
            );
            console.info(
              "Adding certificate to trust chain.. you may be prompted to sudo."
            );
            await utils.execPromise(
              "security add-trusted-cert ./.http-mitm-proxy/certs/ca.crt"
            );
          } catch (err) {}
        } else {
          await utils.execPromise(
            'certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n mitm-ca -i ./.http-mitm-proxy/certs/ca.pem'
          );
        }
        resolve(proxy);
      });
    });
  }

  hasSentry() {
    return !!this.dsn;
  }

  getSentryBinding() {
    return `
  <script src="https://browser.sentry-cdn.com/${
    this.sentryVersion
  }/bundle.min.js" crossorigin="anonymous"></script>
  <script>
  Sentry.init({
    dsn: ${JSON.stringify(this.dsn)},
    environment: 'test',
    debug: true,
    integrations(integrations) {
      return integrations.filter(
        integration => integration.name !== "InboundFilters"
      );
    }
  });
  Sentry.configureScope((scope) => {
    scope.setUser({
      id: 'inhuman',
    });
  });
  ${
    !!this.buildId
      ? `Sentry.configureScope(function(scope) {
    scope.setContext("build", {
      id: ${JSON.stringify(this.buildId)}
    });
  });`
      : ""
  }
  </script>
  `;
  }

  address() {
    return `localhost:${this.port}`;
  }
}

module.exports = Proxy;
