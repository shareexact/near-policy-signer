// Minimal browser stand-in for Node's `process` (used by the util polyfill and a few near-js deps).
export const process = { env: { NODE_ENV: "production" }, browser: true, versions: {}, version: "", pid: 1,
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)) };
