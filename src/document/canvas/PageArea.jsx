// The canvas page area (docs/plans/engine/plan.md section 1, viewport-design.md section 4): while the Canvas engine switch is on,
// the open Document shows here as pages the engine paints, over the editor area and in its place in the layout (direction.md
// section 6: the ribbon, panes and status bar stay as they are). It is the Documents host of a Viewport (src/engine/view): the
// pages are placements in a scrolling column with the DOM editor's page gap and shadow, the engine paints them as tiles, and the
// zoom is the app's in both directions (the zoom commands and Multiple Pages set the camera; Ctrl+wheel sets the app's zoom).
// Scrolling and zooming never wait on the engine: a page without tiles yet shows its paper, a zoomed one its stretched old tiles.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { canvasOpen, setZoom } from '../../app/actions.js';
import { keyAmong } from '../../app/keybinds.js';
import { chordOf, DEFS, isMac } from '../../app/keys.mjs';
import { getState, setState, subscribe, useStore } from '../../app/store.js';
import { keyCommand, keyHolds } from '../../tooling/registry.js';
import { flows, pageInput, readerOf, readPages, READ_BAR, SIDE_BAR, windowOf } from '../wp/views/canvas.mjs';
import { CanvasLineFocus, CanvasSideBar, useCanvasSide } from '../wp/views/CanvasViews.jsx';
import { setMove, sideways } from '../wp/views/state.js';
import { wordChords } from '../word/keys.js';
import { wordSettings } from '../word/settings.mjs';
import { PROOFING } from './proofing.mjs';
import { attachA11y } from '../../engine/a11y/index.js';
import { engineHost } from '../../engine/client.js';
import { createKeymap } from '../../engine/input/keys.mjs';
import { pointerOptions } from '../../engine/input/pointer.js';
import { inputOnViewport } from '../../engine/input/viewport.js';
import { screenRow, screenStart, spread } from '../../engine/view/arrange.mjs';
import { kOf } from '../../engine/view/camera.mjs';
import { nearest } from '../../engine/view/placements.mjs';
import { useViewport, Viewport } from '../../engine/view/Viewport.jsx';
import { fitZoom, GAP, PAD, placePages } from './layout.mjs';
import { BoxFrame } from './boxes.jsx';
import { adopt } from './overlay.jsx';
import { insertFiles, insertHtml, isPost, postWindow } from './post.js';
import { areaOpens, hooks, useEngine } from './session.js';
import { canSplit, onSplit, setSplit, splitAt } from './split.mjs';
import { pageOverlays } from './tools/overlays.jsx';
import { watchTableTool } from './tools/tables.js';

const SLOT = { background: '#ffffff', boxShadow: 'var(--pg-shadow, 0 0 0 1px rgb(0 0 0 / 0.06), 0 2px 6px rgb(0 0 0 / 0.18))' };
// A forum post is one rounded card (page.css .page, radius 6 px), its paper the post theme's (view.postTheme): the values here
// show until the surface's own paper arrives.
const postSlot = (light) => ({ background: light ? '#ffffff' : '#303039', borderRadius: 6, minHeight: '60vh' });
// Read Mode, Web Layout, Draft and the Reader show no page edges: their text sits on the paper colour across the view.
const FLAT = { background: '#ffffff' };
const isFlat = (s) => s.word?.view === 'read' || flows(s.word?.view);
const ZOOM_EPS = 1e-4; // the app keeps its zoom to 0.01 %: closer than that is the same zoom
const NONE = [];
const THUMB = 0.16; // Side to Side's thumbnails' zoom, as the DOM path's copies
// A Document's keys, from the app's keybinds (the user's overrides count), Word's through the tool registry; the copy goes
// through the app's clipboard bridge, which takes RTF too, where there is one.
export const KEYMAP = createKeymap({ defs: DEFS, among: keyAmong, chordOf, isMac, tool: keyCommand, holds: keyHolds });
export const CLIPBOARD = typeof window !== 'undefined' ? window.api?.word?.clipboard : undefined;
// A drag's Word option, read at each press: Options > Advanced "When selecting, automatically select entire word".
pointerOptions.autoWordSelect = () => wordSettings(getState().settings ?? {}).editing?.autoWordSelect === true;

const live = { current: null }; // the mounted page area, for the harness hooks below

/** What the page area says when the engine cannot open the draft: form.mjs sourceOf's reason for a canvas record this build
 * cannot read (a newer form, a picture still syncing), else a plain line. */
const whyNot = (e) => (/^This document cannot open/.test(e?.message ?? '') ? e.message : 'The canvas engine could not open this draft.');


/** How the page area arranges the pages for store view `view` and page movement `move`: a scrolling column of them ('column':
 * Print Layout, Focus and Outline, and the one surface of Web Layout, Draft and the Reader), Multiple Pages' grid ('multi'), Side to
 * Side's screens ('side') and their thumbnails ('thumbs'), or Read Mode's screens ('read'). */
function arrangementOf(view, move) {
  if (view === 'read') return 'read';
  if (view !== 'print' && view !== 'focus') return 'column';
  if (move?.kind === 'side') return move.thumbs ? 'thumbs' : 'side';
  return move?.kind === 'multi' ? 'multi' : 'column';
}

/** The Documents host inside the Viewport: the pages' placements for the view's width and zoom and for the View tab's views
 * (engine-gaps-views), the zoom kept in step with the app's, the per-page layout versions the frames follow, the room the
 * engine's continuous views flow to, input and the tools' focus. */
function Pages({ eng, client, second = false }) {
  const vp = useViewport();
  const pct = useStore((s) => (typeof s.zoom === 'number' ? s.zoom : s.zoomPct)) || 100;
  const move = useStore((s) => s.viewsMove);
  const view = useStore((s) => s.word?.view ?? 'print');
  const word = useStore((s) => wordSettings(s.settings ?? {}));
  const readN = useStore((s) => s.word?.readScreen?.n ?? 1);
  // A post's page is one card in a column at the app's zoom, whatever Word's view settings say: it has no pages to arrange.
  const post = useStore((s) => isPost(s.draft, s.settings));
  const theme = useStore((s) => s.settings?.theme);
  const arr = post ? 'column' : arrangementOf(view, move);
  const multi = arr === 'multi';
  const pages = eng.pages ?? NONE;
  const [paper, setPaper] = useState(null);
  const [per, setPer] = useState(1); // pages a screen shows in Side to Side and Read Mode, as the last placing fitted them
  const now = useRef(null);
  const more = eng.settled === false;
  now.current = { pages, arr, view, word, readN, first: move?.first ?? 0, cols: multi ? move.grid.cols : word.onePageRow ? 1 : 0, rows: multi ? move.grid.rows : 1,
    zoom: pct / 100, paper, more, post };
  const asked = useRef(1); // the zoom this host last gave the camera: any other came from the user (Ctrl+wheel)
  const changed = useRef([]); // page → the layout version that last changed it, so its frames are read again
  const place = useRef(null);
  const retag = useRef(null); // gives the placements of the pages a layout changed its version
  const typing = useRef(null); // inputOnViewport's handle: its `input` has the caret

  // A layout's pages take its version, so their frames and page tools read again; the pages it did not change keep their
  // placements. A change of the page list places them all (the layout effect below).
  useEffect(() => client.on('layout', (e) => {
    for (let i = e.from; i < e.to; i++) changed.current[i] = e.version;
    retag.current?.();
  }), [client]);
  // The paper colour shows round the pages of Read Mode, Web Layout, Draft and the Reader too, so it is read again when the
  // Reader's page colour changes.
  const reader = readerOf(view, word);
  useEffect(() => {
    let dead = false;
    const k = setTimeout(() => Promise.resolve(client.call('surfaces')).then((s) => !dead && setPaper(s?.list?.[0]?.paper ?? null), () => {}), 150);
    return () => {
      dead = true;
      clearTimeout(k);
    };
  }, [client, view, reader.pageColor]);

  // The engine's view follows the store's (tracking/engine.js followView); here it gets the room its continuous views flow to and
  // Read Mode's and the Reader's text options, sent when they change (a resize waits until it stops for 100 ms).
  const sent = useRef({});
  const sendWindow = useRef(null);
  useEffect(() => {
    if (second) return undefined;
    let t = 0;
    sendWindow.current = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const n = now.current;
        const args = n.post ? postWindow(getState().settings, getState().draft) : windowOf(vp.size, n.arr === 'column' ? n.zoom : 1, n.word);
        const key = JSON.stringify(args);
        if (sent.current.window === key) return;
        sent.current.window = key;
        Promise.resolve(client.exec('view.window', args)).catch(() => {});
      }, sent.current.window ? 100 : 0);
    };
    return () => clearTimeout(t);
  }, [vp, client]);
  useEffect(() => {
    if (second) return undefined;
    sendWindow.current?.();
    const calls = [['view.readPageColor', { value: reader.pageColor }], ['view.readerSpacing', { value: reader.spacing }],
      ['view.readerSyllables', { value: reader.syllables }]];
    // A post's model is saved in the dark palette: the light theme is the engine's paint remap of it (A5's view.postTheme).
    if (post) calls.push(['view.postTheme', { light: theme === 'light' }]);
    for (const [id, args] of calls) {
      // Again on a view change: entering Read Mode sets the engine's page colour back to None.
      const key = `${view}:${JSON.stringify(args)}`;
      if (sent.current[id] === key) continue;
      sent.current[id] = key;
      Promise.resolve(client.exec(id, args)).catch(() => {});
    }
  }, [client, view, word, pct, reader.pageColor, reader.spacing, reader.syllables, post, theme]);

  useLayoutEffect(() => {
    let last = null;
    // A draft opens at the app's zoom with its first page at the top.
    const first = now.current;
    asked.current = first.arr === 'column' ? first.zoom : vp.camera.zoom;
    if (first.arr === 'column' && Math.abs(first.zoom - vp.camera.zoom) > ZOOM_EPS) vp.setCamera({ x: 0, y: 0, zoom: first.zoom });
    let depth = 0;
    let given = null; // the extent and band last given with the placements
    // A fitted zoom sets the camera, whose event places the pages again: a few levels deep at most. ponytail: a fit that never
    // settles (a scroll bar coming and going with it) stops there rather than overflow the stack.
    place.current = () => {
      if (depth > 3) return;
      depth++;
      try {
        placeNow();
      } finally {
        depth--;
      }
    };
    // engine-main-thread-2: a typed letter placed all 959 pages of the Word fixture again, and every Surface on screen rendered.
    retag.current = () => {
      let any = false;
      const list = vp.placements.map((p) => {
        const v = changed.current[p.surface] ?? 0;
        if (p.version === v) return p;
        any = true;
        return { ...p, version: v };
      });
      if (any && given) vp.setPlacements(list, given);
    };
    /** Swaps each placement of `list` equal to the one shown before (its place, size, paper and layout version) for that one, so
     * a page that did not move or change keeps its placement and its Surface does not render again. */
    const keep = (list) => {
      const had = new Map(vp.placements.map((p) => [p.key, p]));
      list.forEach((p, i) => {
        const o = had.get(p.key);
        if (o && o.x === p.x && o.y === p.y && o.w === p.w && o.h === p.h && o.paper === p.paper && o.version === p.version) list[i] = o;
      });
    };
    const placeNow = () => {
      const n = now.current;
      const z = vp.camera.zoom;
      const size = vp.size;
      const side = n.arr === 'side' && spread(n.pages, size, { gap: GAP, pad: PAD, top: SIDE_BAR });
      const read = n.arr === 'read' && readPages(size, n.word.readMode);
      // The zoom each arrangement fits: Multiple Pages' grid, Side to Side's pages to the window (its zoom is off, Word's),
      // the thumbnails', Read Mode's 100 %; the column takes the app's.
      const fixed = n.arr === 'multi' ? fitZoom(n.pages, size.w, size.h, n.cols, n.rows)
        : side ? side.zoom : n.arr === 'thumbs' ? THUMB : read ? 1 : null;
      if (Math.abs(z - asked.current) > ZOOM_EPS && (n.arr === 'column' || n.arr === 'multi')) {
        // The user's zoom (or the column clamp) goes to the app, out of Multiple Pages, as the DOM editor's wheel zoom does.
        asked.current = z;
        if (n.arr === 'multi') setMove('vertical');
        setZoom(z * 100);
      } else if (fixed != null && Math.abs(fixed - z) > ZOOM_EPS) {
        asked.current = fixed;
        return vp.setCamera(n.arr === 'multi' ? { zoom: fixed } : { x: 0, y: 0, zoom: fixed }); // its camera event places the pages
      }
      // Side to Side's fit shows in the status bar as the zoom, as the DOM editor's does; Vertical puts the zoom back (state.js).
      if (side && sideways() && Math.abs(getState().zoom - Math.round(z * 10000) / 100) > 0.01) setZoom(Math.round(z * 10000) / 100);
      const count = side ? side.cols : read ? read.count : 1;
      const from = side ? screenStart(n.first, count, n.pages.length) : read ? (n.readN - 1) * count : 0;
      const key = { z, w: size.w, h: n.arr === 'column' || n.arr === 'thumbs' ? 0 : size.h, arr: n.arr, cols: n.cols, from, count,
        pages: n.pages, paper: n.paper, more: n.more };
      if (last && Object.keys(key).every((k) => key[k] === last[k])) return;
      last = key;
      setPer(count);
      const { placements, extent } = side ? screenRow(n.pages, { first: from, count, zoom: z, view: size, gap: GAP, top: SIDE_BAR, session: client.id })
        : read ? screenRow(n.pages, { first: from, count, zoom: 1, view: size, top: READ_BAR, session: client.id })
          : n.arr === 'thumbs' ? below(placePages(n.pages, z, size.w, 0, client.id), SIDE_BAR / kOf(z))
            : placePages(n.pages, z, size.w, key.cols, client.id);
      for (const p of placements) {
        p.paper = key.paper ?? undefined;
        p.version = changed.current[p.surface] ?? 0;
      }
      keep(placements);
      // While the engine lays out the pages after these (engine-open), the scroll range ends in a band that says so.
      given = { extent, more: key.more && (n.arr === 'column' || n.arr === 'multi') && 'Laying out the rest of the document' };
      vp.setPlacements(placements, given);
      sendWindow.current?.();
    };
    place.current();
    if (second && live.current?.vp) vp.setCamera({ x: live.current.vp.camera.x, y: live.current.vp.camera.y });
    return vp.subscribe('camera', () => place.current());
  }, [vp, client]);

  // The app's zoom (the zoom commands, One Page, Page Width, the status bar) moves the camera about the view's centre.
  useLayoutEffect(() => {
    if (arr === 'column' && Math.abs(pct / 100 - asked.current) > ZOOM_EPS) {
      asked.current = pct / 100;
      vp.setCamera({ zoom: pct / 100 });
    } else {
      place.current();
    }
  }, [vp, pct, arr, move?.grid?.cols, move?.grid?.rows, move?.first, readN, word, pages, paper, more]);

  // Read Mode's "Screen n of m": the screens these pages make, kept in the store for the status bar and the Reader's turns.
  const screens = arr === 'read' ? Math.max(1, Math.ceil(pages.length / per)) : 0;
  useEffect(() => {
    if (!screens) return;
    const w = getState().word;
    const n = Math.min(Math.max(1, w.readScreen?.n ?? 1), screens);
    if (w.readScreen?.n !== n || w.readScreen?.m !== screens) setState({ word: { ...w, readScreen: { n, m: screens } } });
  }, [screens, readN]);

  // Typing, keys, pointer and clipboard go to the viewport's focused session (src/engine/input/viewport.js). A forum post's
  // HTML and files are pasted through the post host, which filters the HTML to the kit and makes its pictures and media.
  useEffect(() => {
    const postDraft = isPost(getState().draft, getState().settings);
    const off = inputOnViewport(vp, { clientOf: (id) => (id === client.id ? client : null), keymap: KEYMAP, clipboard: CLIPBOARD,
      ...(postDraft && { pasteHtml: (html, opts) => insertHtml(client, html, opts), pasteFiles: (files) => insertFiles(client, files) }) });
    typing.current = off;
    if (!second) pageInput.current = off;
    return () => {
      typing.current = null;
      if (!second && pageInput.current === off) pageInput.current = null;
      off();
    };
  }, [vp, client]);
  const input = useCallback(() => typing.current?.input ?? null, []);
  useCanvasSide(vp, client, { arr, first: screenStart(move?.first ?? 0, per, pages.length), per, count: pages.length, input });
  // Immersive Reader's Line Focus over the caret.
  const focusLines = view === 'immersive' ? word.immersive?.lineFocus || 0 : 0;
  useEffect(() => {
    if (!focusLines) return undefined;
    vp.overlays.register('views-line-focus', (p) => <CanvasLineFocus {...p} input={input()} session={client.id} />, { plane: 'screen' });
    return () => vp.overlays.register('views-line-focus', null);
  }, [vp, client, focusLines, input]);
  // The paper colour fills the view round the text of Read Mode, Web Layout, Draft and the Reader (PageArea's FLAT).
  useEffect(() => vp.root.style.setProperty('--canvas-paper', paper ?? '#ffffff'), [vp, paper]);

  // The tools follow this draft while its page area shows (section 4.7): the area takes the focus on mount, so its session is
  // the focus target, mirrored into the store's focusedSession, until it closes. A ribbon click's blur keeps it.
  useEffect(() => {
    vp.setFocus({ session: client.id, mode: 'text' });
    return () => vp.setFocus(null);
  }, [vp, client]);
  // When the first tile landed, for the Reopen time (viewport-design.md section 12) the harness reads from state().times; an
  // opening card ends then.
  useEffect(() => {
    const times = eng.times;
    if (second || !times || times.painted) return undefined;
    let raf = 0;
    const look = () => {
      if (vp.tiles?.stats().paints.length) {
        times.painted = performance.now();
        canvasOpen(getState().draft, 'painted');
      } else raf = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(raf);
  }, [vp, eng.times]);
  // The marks, frame kinds and overlays other packages give the page area (index.js's exports) draw on this viewport.
  useEffect(() => {
    const off = adopt(vp, client.id);
    if (second) vp.overlays.register('comments', null);
    return off;
  }, [vp, client, second]);
  // A post's plan chart is sized by its measured height (box.fill); a Document's layout sizes its own charts, so its frames
  // leave them alone.
  useEffect(() => {
    const Box = (p) => <BoxFrame {...p} fill={post} vp={vp} />;
    vp.frameKinds.register('box', Box);
    return () => vp.frameKinds.register('box', null);
  }, [vp, client, post]);
  // The drawing grid, the table gridlines and the stencil ruler over the pages, and the table tools following the store's
  // word.tableTool (tools/, engine-page-tools).
  useEffect(() => pageOverlays(vp, client), [vp, client]);
  useEffect(() => watchTableTool(client), [client]);
  // The accessibility copy screen readers read, laid over the painted lines, spelling as you type and forced colours.
  useEffect(() => attachA11y(vp, { clientOf: (s) => (s === client.id ? client : null), title: () => getState().draft?.title || 'Document',
    proofing: PROOFING, subscribe }).destroy, [vp, client]);
  if (arr !== 'side' && arr !== 'thumbs') return null;
  return <CanvasSideBar thumbs={arr === 'thumbs'} first={screenStart(move?.first ?? 0, per, pages.length)} per={per} count={pages.length} />;
}

/** `l` ({placements, extent}) moved `dy` points down, under a bar over the page area. */
function below(l, dy) {
  for (const p of l.placements) p.y += dy;
  return { placements: l.placements, extent: { ...l.extent, h: l.extent.h + dy } };
}

// Word's chords in the page area belong to the draft, as in the DOM editor's text (word/keys.js WordKeys): main.js leaves the
// developer tools' chord (Ctrl+Shift+I, Word's Italic) to the text while preload.js's docText says the text has the focus.
const docTextOn = () => window.docText?.(true, wordChords());
const docTextOff = () => window.docText?.(false);

function PageArea() {
  const eng = useEngine();
  const client = eng?.client ?? null;
  const clientNow = useRef(null);
  clientNow.current = client;
  const [host] = useState(engineHost);
  const ref = useRef(null);
  // A forum post is one rounded card of its own paper, never a page of a view with its edges hidden.
  const post = useStore((s) => isPost(s.draft, s.settings));
  const light = useStore((s) => s.settings?.theme === 'light');
  const flat = useStore(isFlat) && !post;
  // Side to Side and Read Mode fit their screen to the view and turn screens: no scroll bars, so the fit cannot move them.
  const screen = useStore((s) => ['side', 'read'].includes(arrangementOf(s.word?.view, s.viewsMove)));
  const focusView = useStore((s) => s.word?.view === 'focus'); // Focus shows the pages on a dark background, as the DOM path's
  const at = useSyncExternalStore(onSplit, splitAt);
  const can = useStore((s) => canSplit(s.word?.view, s.viewsMove));
  const box = useRef(null);
  const split = can && client && at != null ? at : null;
  useEffect(() => { if (!can) setSplit(null); }, [can]);
  useEffect(() => () => setSplit(null), []); // a split belongs to the open draft
  // The ribbon's Split/Remove Split label follows the split: setState({}) re-renders the tools' readers, as draw/index.js bumps.
  useEffect(() => {
    let was = splitAt() != null;
    return onSplit(() => {
      const on = splitAt() != null;
      if (on !== was) setState({});
      was = on;
    });
  }, []);
  const was = useRef(null);
  useEffect(() => {
    if (was.current != null && split == null) {
      const root = ref.current?.root;
      root?.focus({ preventScroll: true });
      // The upper pane's input handle went with it: the main pane claims focusedInput again, as a focusin would (a focused root
      // fires none), so Ctrl+Alt+PageUp and PageDown still find the view.
      root?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }
    was.current = split;
  }, [split]);

  useLayoutEffect(() => {
    live.current = { eng, vp: ref.current };
  });
  useEffect(() => () => {
    live.current = null;
  }, []);

  // A page's frames, read again with each of its layout versions: the same frames come back as the list the page has, so a key
  // that left its text boxes and pictures where they were draws the page's Surface again only once (engine-main-thread-2).
  // They are the client's they were read from: another draft's or client's pages start a cache of their own.
  const frames = useRef({ client: null, map: new Map() }); // map: surface → [json, list]
  const framesOf = (p) => {
    const c = clientNow.current;
    return Promise.resolve(c?.frames(p.surface)).then((list) => {
      if (frames.current.client !== c) frames.current = { client: c, map: new Map() };
      const { map } = frames.current;
      const json = JSON.stringify(list ?? null);
      const had = map.get(p.surface);
      if (had?.[0] === json) return had[1];
      map.set(p.surface, [json, list]);
      return list;
    });
  };

  const onViewport = (vp) => {
    ref.current = vp;
    if (vp) {
      vp.root.addEventListener('focusin', docTextOn);
      vp.root.addEventListener('focusout', docTextOff);
    }
    vp?.root.focus({ preventScroll: true }); // keys stop reaching the DOM editor underneath
  };
  // The upper pane's callback never touches ref or takes the focus on mount.
  const onSecond = (vp) => {
    if (!vp) return;
    vp.root.addEventListener('focusin', docTextOn);
    vp.root.addEventListener('focusout', docTextOff);
  };
  useEffect(() => () => {
    if (ref.current?.root.contains(document.activeElement)) docTextOff(); // no focusout comes from a removed area
  }, []);
  // The store holds the focused draft's SessionClient (src/tooling/surface.js reads it); a focus left on a closed area clears.
  const onFocus = (f) => {
    const c = f.session != null ? clientNow.current : null;
    if (c || getState().focusedSession === clientNow.current) setState({ focusedSession: c });
  };
  const pane = { host, slotStyle: post ? postSlot(light) : flat ? FLAT : SLOT, frames: framesOf, 'data-canvas-pages': '', 'data-flat-pages': flat ? '' : undefined,
    'aria-busy': !client || eng?.settled === false, className: 'pointer-events-auto z-[5]',
    style: { position: 'absolute', inset: 0, background: flat ? 'var(--canvas-paper, #ffffff)' : focusView ? '#1a1a1a' : 'var(--pg-bg)', overflow: screen ? 'hidden' : 'auto' } };
  return (
    <div ref={box} data-split-box="" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div key="main" style={{ position: 'relative', order: 2, flex: '1 1 0', minHeight: 0 }}>
        <Viewport {...pane} label="Document pages" onViewport={onViewport} onFocus={onFocus}>
          {!client && (
            <p className="absolute inset-x-0 top-1/3 text-center text-sm text-muted-foreground">
              {eng?.error ? whyNot(eng.error) : 'Opening the draft in the canvas engine'}
            </p>
          )}
          {client && <Pages key={client.id} eng={eng} client={client} />}
        </Viewport>
      </div>
      {split != null && <SplitBar box={box} />}
      {split != null && (
        <div key="second" style={{ position: 'relative', order: 0, flex: `0 0 ${split * 100}%`, minHeight: 0 }}>
          <Viewport {...pane} label="Document pages, upper pane" data-viewport={undefined} data-split-pane="" onViewport={onSecond}>
            <Pages key={client.id} eng={eng} client={client} second />
          </Viewport>
        </div>
      )}
    </div>
  );
}

/** The bar between the panes: drag to move it, drop it near an edge or double-click it to remove the split, Up and Down to move it. */
function SplitBar({ box }) {
  const share = (e) => {
    const r = box.current.getBoundingClientRect();
    return (e.clientY - r.top) / r.height;
  };
  const drag = (e) => {
    e.preventDefault();
    const move = (ev) => setSplit(share(ev));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = share(ev);
      if (f < 0.05 || f > 0.95) setSplit(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const key = (e) => {
    if (e.key === 'ArrowUp') setSplit(splitAt() - 0.02);
    else if (e.key === 'ArrowDown') setSplit(splitAt() + 0.02);
    else if (e.key === 'Delete' || e.key === 'Enter') setSplit(null);
    else return;
    e.preventDefault();
  };
  return (
    <div data-split-bar="" role="separator" aria-orientation="horizontal" aria-label="Split bar" tabIndex={0} onPointerDown={drag} onDoubleClick={() => setSplit(null)} onKeyDown={key}
      className="pointer-events-auto z-[6] shrink-0 cursor-row-resize bg-border" style={{ order: 1, height: 6 }} />
  );
}

/** The views' viewport slot: the page area for an open Document in the editor view while the switch is on, or for a canvas
 * draft, one per draft. A new draft waits for its first save: the page area saves a draft by its id. */
export function CanvasSlot() {
  const on = useStore(areaOpens);
  const draft = useStore((s) => s.draft?.id);
  return on && draft ? <PageArea key={draft} /> : null;
}

// For the harness cases (engine-viewport, engine-view): the area's state, the page point under a client point, the engine client
// and the hooks.
if (typeof window !== 'undefined') {
  window.__canvasEngine = {
    hooks,
    state() {
      const a = live.current;
      const vp = a?.vp;
      if (!vp) return null;
      const list = vp.placements;
      const t = vp.tiles?.stats() ?? { paints: [], unpainted: [] };
      const el = vp.root;
      return {
        ready: !!a.eng?.client, error: a.eng?.error ? String(a.eng.error) : null, pages: a.eng?.pages?.length ?? 0, zoom: vp.camera.zoom,
        k: kOf(vp.camera.zoom), firstRow: list.filter((p) => p.y === list[0]?.y).length, mounted: el.querySelectorAll('[data-surface]').length,
        canvases: el.querySelectorAll('[data-surface] canvas').length, version: a.eng?.latest?.version ?? a.eng?.version ?? 0, failed: 0, paints: t.paints,
        unpainted: t.unpainted, tiles: t, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, viewH: el.clientHeight, times: a.eng?.times ?? null,
        settled: a.eng?.settled ?? null,
      };
    },
    pointAt(cx, cy) {
      const vp = live.current?.vp;
      const t = vp && nearest(vp.placements, vp.fromClient(cx, cy).world);
      return t && { page: t.surface, x: t.x, y: t.y };
    },
    client: () => live.current?.eng?.client ?? null,
    viewport: () => live.current?.vp ?? null,
  };
}
