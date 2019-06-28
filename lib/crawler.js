#!/usr/bin/env node

const puppeteer = require("puppeteer");
const URL = require("url").URL;

const SessionCache = require("./cache");
const PriorityQueue = require("./queue");
const utils = require("./utils");

const PAGE_OPTIONS = {
  timeout: 60000,
  waitUntil: "networkidle0"
};

const DEFAULT_ARGS = [
  "--disable-setuid-sandbox",
  "--no-sandbox",
  "--blink-settings=imagesEnabled=false",
  "--proxy-bypass-list=browser.sentry-cdn.com;sentry.io"
];

const BLOCKED_RESOURCE_TYPES = [
  "image",
  "media",
  "font",
  "texttrack",
  "object",
  "beacon",
  "imageset"
];

const SKIPPED_RESOURCES = [
  "quantserve",
  "adzerk",
  "doubleclick",
  "adition",
  "exelator",
  "sharethrough",
  "cdn.api.twitter",
  "google-analytics",
  // "googletagmanager",
  // "google",
  // "fontawesome",
  "facebook",
  "analytics",
  "optimizely",
  "clicktale",
  "mixpanel",
  "zedo",
  "clicksor",
  // "tiqcdn",
  "favicon.ico",
  // queue currently infinitely spins due to bugs
  // GOOD JOB HUMANS
  "/manage/queue/"
];

class Crawler {
  constructor(options) {
    this.domains = options.domains || [];
    this.screenshots = options.screenshots || null;
    this.proxy = options.proxy || null;
    this.headless = options.headless !== false;
    this.verbose = options.verbose || false;

    this._browser = null;
    this._errors = [];
    this._cache = new SessionCache();
    this._queue = new PriorityQueue({
      cache: this._cache,
      maxConcurrency: options.maxConcurrency || 5
    });
    this._count = 0;
    this._visited = new Set();
    this._queue.on("pull", (_options, previousUrl) =>
      this._request(_options, previousUrl)
    );
    this._formConfigs = options.formConfigs || [];
  }

  async init() {
    await this._cache.init();
    this._queue.init();
  }

  async getBrowser() {
    if (this._browser) return this._browser;
    let args = [...DEFAULT_ARGS];
    if (this.proxy) {
      args.push(`--proxy-server=${this.proxy}`);
    }
    this._browser = await puppeteer.launch({
      args: args,
      headless: this.headless,
      ignoreHTTPSErrors: true
    });
    return this._browser;
  }

  async close() {
    this._queue.end();
    await this._cache.clear();
    await this._cache.close();
    if (!this._browser) return;
    await this._browser.close();
    this._browser = null;
  }

  async queue(url, options = {}) {
    this._visited.add(url);
    this._queue.push(url, options, 0);
  }

  async _processPage(page, initialUrl) {
    // ideally at this point we'd invalidate visited links *if* cookies
    // have changed

    const url = initialUrl || page.url();

    if (this.screenshots) {
      let fileName = new URL(url).pathname.replace(/(\.|\/|:|%|#)/g, "_");
      if (fileName.length > 100) {
        fileName = fileName.substring(0, 100);
      }
      await page.screenshot({
        path: `${this.screenshots}/${fileName}.jpeg`,
        fullPage: true
      });
    }

    await this._discoverLinks(page);
    await this._emulateScrolling(page);

    const formData = this._formConfigs.find(x => url.match(x.url));
    if (formData) {
      console.info("  -> Doing the human thing with form data");
      await Promise.all(
        Object.keys(formData.fields).map(fieldName => {
          page.$eval(
            fieldName,
            (el, fieldValue) => (el.value = fieldValue),
            formData.fields[fieldName]
          );
        })
      );
      // https://github.com/GoogleChrome/puppeteer/issues/1412
      page.click(formData.submitElement);
      await page.waitForNavigation({ ...PAGE_OPTIONS });
      this._count += 1;
      console.log(`${this._count}. ${page.url()}`);
      await this._processPage(page);
    }
  }

  async _emulateScrolling(page) {
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        var totalHeight = 0;
        var distance = 200;
        var maxScrollTime = 60; // seconds
        var start = new Date().getTime();
        var timer = setInterval(() => {
          var scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (
            totalHeight >= scrollHeight ||
            (start - new Date().getTime()) / 1000 > maxScrollTime
          ) {
            clearInterval(timer);
            resolve();
          }
        }, 400);
      });
    });
  }

  async _request(url, options) {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    await page.setUserAgent(this.pickUserAgent());

    page.on("request", request => {
      const requestUrl = request._url.split("?")[0].split("#")[0];
      if (this._isSentryResource(requestUrl)) {
        request.continue();
      } else if (
        BLOCKED_RESOURCE_TYPES.indexOf(request.resourceType()) !== -1 ||
        SKIPPED_RESOURCES.some(r => requestUrl.indexOf(r) !== -1)
      ) {
        this.verbose &&
          console.warn(`Forbidden (${request.resourceType()}): ${requestUrl}`);
        request.abort();
      } else if (
        request.resourceType() === "document" &&
        !this._isLinkAllowed(requestUrl)
      ) {
        this.verbose &&
          console.warn(`Forbidden (${request.resourceType()}): ${requestUrl}`);
        request.abort();
      } else {
        request.continue();
      }
    });

    try {
      this._count += 1;
      console.log(`${this._count}. ${url}`);
      await page.goto(url, { ...PAGE_OPTIONS });
      await page.setViewport({
        width: 1200,
        height: 800
      });
      await this._processPage(page, url);
    } catch (err) {
      // TODO(dcramer): if this throws a ERR_PROXY_CONNECTION_FAILED error we need to abort
      this._errors.push([url, err]);
      console.error(`An error occured on url: ${url}`, err);
    } finally {
      await page.close();
    }
  }

  async onIdle() {
    await this._queue.onIdle();
  }

  pickUserAgent() {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3239.108 Safari/537.36";
  }

  errors() {
    return this._errors;
  }

  hasErrors() {
    return !!this._errors.length;
  }

  async _discoverLinks(page) {
    const links = await page.$$eval("a", nodes => nodes.map(n => n.href));
    links.forEach(link => {
      if (!link) return;
      link = link.split("#")[0];
      if (
        this._isLinkAllowed(link) &&
        !this._visited.has(link) &&
        !SKIPPED_RESOURCES.some(r => link.indexOf(r) !== -1)
      ) {
        this.queue(link);
      }
    });
  }

  _isSentryResource(url) {
    if (url.indexOf("https://browser.sentry-cdn.com") === 0) return true;
    if (url.indexOf("https://sentry.io/api/") === 0) return true;
    return false;
  }

  _isLinkAllowed(link) {
    return utils.isLinkAllowed(link, this.domains);
  }
}

module.exports = Crawler;
