/** The app's version, from package.json at the app's root: the engine writes it beside the name EasyWriter in the generator,
 * producer and application fields of the files it makes (ew-doc's app.rs). Empty when package.json cannot be read, and the
 * files then say EasyWriter alone. worker.js and helper.js hand it to their instance before its first session. */
export const appVersion = () =>
  fetch(new URL('../../package.json', import.meta.url)).then((r) => r.json()).then((p) => String(p.version ?? '')).catch(() => '');
