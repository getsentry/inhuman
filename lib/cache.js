const utils = require("./utils");

class SessionCache {
  init() {
    this._storage = new Map();
    return Promise.resolve();
  }

  clear() {
    if (this._storage) {
      this._storage.clear();
    }
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }

  get(key) {
    return Promise.resolve(this._storage.get(key) || null);
  }

  set(key, value) {
    this._storage.set(key, value);
    return Promise.resolve();
  }

  enqueue(key, value, priority) {
    const queue = this._storage.get(key) || [];
    const item = { value, priority };
    if (queue.length && queue[queue.length - 1].priority >= priority) {
      queue.push(item);
      this._storage.set(key, queue);
      return Promise.resolve();
    }
    const index = utils.lowerBound(
      queue,
      item,
      (a, b) => b.priority - a.priority
    );
    queue.splice(index, 0, item);
    this._storage.set(key, queue);
    return Promise.resolve();
  }

  dequeue(key) {
    const queue = this._storage.get(key) || [];
    this._storage.set(key, queue);
    const item = queue.shift();
    if (!item) return Promise.resolve(null);
    return Promise.resolve(item.value);
  }

  size(key) {
    const queue = this._storage.get(key);
    if (!queue) return Promise.resolve(0);
    return Promise.resolve(queue.length);
  }

  remove(key) {
    this._storage.delete(key);
    return Promise.resolve();
  }
}

module.exports = SessionCache;
