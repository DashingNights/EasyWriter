// A gallery provider or panel that serves a canvas draft too. registry.js galleryOf and panelOf keep only those flagged
// `engine: true` on a canvas draft, so one helper sets the flag and picks the reading per editor. Pure, with no imports, so any
// module can use it on load (no import cycle reaches it).

/** `eng(ctx)` on a canvas draft (it reads the engine through ctx.read or ctx.engineState), `dom(ctx)` on the DOM editor; given
 * one function, that function itself flagged, for a provider or panel that reads alike in both (a panel is a component, so it
 * keeps its own identity). */
export const both = (dom, eng) => (eng ? Object.assign((ctx) => (ctx?.engine ? eng(ctx) : dom(ctx)), { engine: true }) : Object.assign(dom, { engine: true }));
