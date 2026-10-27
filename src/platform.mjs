// The operating system the app runs on. Node (main.js, the tests) reads process.platform; a page reads navigator.platform, which is
// "MacIntel" on every Mac. Pure and import-free, so keys.mjs, the renderer and the Node tests can all import it.
export const MAC = typeof process !== 'undefined' && process.platform ? process.platform === 'darwin' : typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);
