const EventEmitter = require("events");

const KEY = "queue";
const INTERVAL = 200;

class PriorityQueue extends EventEmitter {
  constructor(options) {
    super();
    this._cache = options.cache;
    this._maxConcurrency = options.maxConcurrency || Infinity;
    this._isPaused = false;
    this._pendingCount = 0;
    this._resolveIdle = () => {};
  }

  init() {
    this._watch();
  }

  end() {
    this._unwatch();
  }

  async push(...args) {
    const priority = args.pop();
    await this._cache.enqueue(KEY, args, priority);
    this._pull();
  }

  pause() {
    this._isPaused = true;
    this._unwatch();
    this._resolveIdle();
  }

  resume() {
    if (!this._isPaused) return;
    this._isPaused = false;
    this._watch();
    this._pull();
  }

  isPaused() {
    return this._isPaused;
  }

  pending() {
    return this._pendingCount;
  }

  size() {
    return this._cache.size(KEY);
  }

  onIdle() {
    return new Promise(resolve => {
      this._resolveIdle = resolve;
    });
  }

  emitAsync(event, ...args) {
    const promises = [];
    this.listeners(event).forEach(listener => {
      promises.push(listener(...args));
    });
    return Promise.all(promises);
  }

  async _pull() {
    if (this._isPaused) return;
    if (this._pendingCount >= this._maxConcurrency) return;
    this._pendingCount += 1;
    const args = await this._cache.dequeue(KEY);
    if (!args) {
      this._pendingCount -= 1;
      if (this._pendingCount === 0) this._resolveIdle();
      return;
    }
    await this.emitAsync("pull", ...args);
    this._pendingCount -= 1;
    this._pull();
  }

  _watch() {
    this._unwatch();
    this._interval = setInterval(() => {
      this._pull();
    }, INTERVAL);
  }

  _unwatch() {
    clearInterval(this._interval);
  }
}

module.exports = PriorityQueue;
