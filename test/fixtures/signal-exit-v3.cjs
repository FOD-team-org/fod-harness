// Minimal single-module signal-exit 3.0.7 contract for hosts without Pi's dependency.
// Only the count / listener equality / unload / re-signal path is reproduced.
const { EventEmitter } = require('node:events');
const emitter = process.__signal_exit_emitter__ ??= Object.assign(new EventEmitter(), { count: 0 });
const callbacks = new Set();
const handlers = new Map();
let loaded = false;
function unload() {
  if (!loaded) return;
  loaded = false;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  handlers.clear();
  emitter.count--;
}
module.exports = function onExit(callback) {
  callbacks.add(callback);
  if (!loaded) {
    loaded = true;
    emitter.count++;
    for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
      const handler = () => {
        if (process.listeners(signal).length !== emitter.count) return;
        unload();
        for (const callback of callbacks) callback(null, signal);
        process.kill(process.pid, signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  return () => { callbacks.delete(callback); if (!callbacks.size) unload(); };
};
