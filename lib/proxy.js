const MitmProxy = require("http-mitm-proxy");
const { promisify } = require("util");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");

const utils = require("./utils");

const execPromise = promisify(exec);

const isMac = os.platform() === "darwin";

const UNIQUE_ID = `inhuman-${new Date().getTime()}`;

// https://intoli.com/blog/making-chrome-headless-undetectable/
const INJECTION = `
<script type="text/javascript">
// GUID: ${UNIQUE_ID}
// overwrite the languages property to use a custom getter
Object.defineProperty(navigator, 'languages', {
  get: function() {
    return ['en-US', 'en'];
  },
});

// overwrite the plugins property to use a custom getter
Object.defineProperty(navigator, 'plugins', {
  get: function() {
    // this just needs to have length> 0, but we could mock the plugins too
    return [1, 2, 3, 4, 5];
  },
});

const getParameter = WebGLRenderingContext.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  // UNMASKED_VENDOR_WEBGL
  if (parameter === 37445) {
    return 'Intel Open Source Technology Center';
  }
  // UNMASKED_RENDERER_WEBGL
  if (parameter === 37446) {
    return 'Mesa DRI Intel(R) Ivybridge Mobile ';
  }
  if (parameter === WebGLRenderingContext.prototype.VENDOR) {
    return 'WebKit';
  }
  if (parameter === WebGLRenderingContext.prototype.RENDERER) {
    return 'WebKit WebGL';
  }
  return getParameter.call(this, parameter);
};

['height', 'width'].forEach(property => {
  // store the existing descriptor
  const imageDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, property);

  // redefine the property with a patched descriptor
  Object.defineProperty(HTMLImageElement.prototype, property, {
    ...imageDescriptor,
    get: function() {
      // return an arbitrary non-zero dimension if the image failed to load
      if (this.complete && this.naturalHeight == 0) {
        return 20;
      }
      // otherwise, return the actual dimension
      return imageDescriptor.get.apply(this);
    },
  });
});

// store the existing descriptor
const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

// redefine the property with a patched descriptor
Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
  ...elementDescriptor,
  get: function() {
    if (this.id === 'modernizr') {
        return 1;
    }
    return elementDescriptor.get.apply(this);
  },
});
</script>
`;

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
          let chunkStr = chunk.toString();
          if (
            chunkStr.indexOf(this.dsn) === -1 &&
            chunkStr.indexOf("<body") !== -1
          ) {
            chunk = new Buffer(
              chunkStr.replace(
                /(<body[^>]*?>)/g,
                `$1${this.getSentryBinding()}`
              )
            );
          }

          if (
            chunkStr.indexOf(UNIQUE_ID) === -1 &&
            chunkStr.indexOf("<head") !== -1
          ) {
            chunk = new Buffer(
              chunkStr.replace(/(<head[^>]*?>)/g, `$1${INJECTION}`)
            );
          }
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
    if (!isMac) {
      const nssDbPath = os.homedir() + "/.pki/nssdb";
      try {
        fs.statSync(nssDbPath);
      } catch (err) {
        fs.mkdirSync(nssDbPath, { recursive: true });
        await execPromise(
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
          await execPromise(
            "openssl x509 -outform der -in ./.http-mitm-proxy/certs/ca.pem -out ./.http-mitm-proxy/certs/ca.crt"
          );
          try {
            await execPromise(
              "security add-certificate ./.http-mitm-proxy/certs/ca.crt"
            );
            console.info(
              "Adding certificate to trust chain.. you may be prompted to sudo."
            );
            await execPromise(
              "security add-trusted-cert ./.http-mitm-proxy/certs/ca.crt"
            );
          } catch (err) {}
        } else {
          await execPromise(
            'certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n mitm-ca -i ./.http-mitm-proxy/certs/ca.pem'
          );
        }
        resolve(proxy);
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
