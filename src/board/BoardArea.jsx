// The board over the editor area (docs/plans/board/design.md sections 3 and 4, briefs/bd-area.md): one Viewport on the pan driver
// shows the board's items, each a surface of a board session whose stamp the worker paints. Items live in draft.board through
// BoardStore; the camera lives in settings.boardViews, never in the draft.
import { useEffect, useRef, useState } from 'react';
import { engineHost } from '../engine/client.js';
import { bounds } from '../engine/view/placements.mjs';
import { fitRect } from '../engine/view/camera.mjs';
import { panDriver } from '../engine/view/pan.js';
import { Viewport } from '../engine/view/Viewport.jsx';
import { attachBoardCamera, attachCanvas, markDirty, saveNow, saveSettings, setZoom } from '../app/actions.js';
import { getState, useStore } from '../app/store.js';
import { resolveBg, setPlaneBoard } from '../whiteboard.js';
import { PlaneBoard } from './api.js';
import { blankModel } from './model.mjs';
import { boardPointer } from './pointer.js';
import { PaperLayer } from './PaperLayer.jsx';
import { BoardSelection, createSelection } from './Selection.jsx';
import { BoardStore, blankBoard, newId } from './store.mjs';
import { createSurfaces, mediaOf, mergeMedia, placementsOf, ruleOf } from './surfaces.mjs';
import { modules } from './tools/index.js';

const HINT = 'Press B for a box, T for text, or drop a file here.';

let boardClient = null; // the app's client id (settings.boardClient), made once

/** A session id → the promise of the view that held it letting go, so a quick reopen of one board never shares its session. */
const closing = new Map();

/** The board client's id for every board's store: read from settings, or made and saved. */
function clientId() {
  if (boardClient) return boardClient;
  boardClient = getState().settings?.boardClient || newId();
  if (!getState().settings?.boardClient) saveSettings({ boardClient });
  return boardClient;
}

/** An empty board's one line, centred in the view and never scaled by the camera. */
function EmptyHint() {
  return <div data-board-hint="" style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'flex', alignItems: 'center',
    justifyContent: 'center', pointerEvents: 'none', font: '13px system-ui, sans-serif', color: 'var(--muted-foreground, #6b6b6b)' }}>{HINT}</div>;
}

/** The board of `draft` (format 'board'), mounted once per draft id: its item store, its board and item sessions, the surfaces
 * they paint and the viewport that places them. */
export function BoardArea({ draft }) {
  const [host] = useState(engineHost);
  const vp = useRef(null);
  const face = useRef(null); // {client, item, surfaces, ctx} once the sessions are open
  const offView = useRef(null);
  const cam = useRef(null); // the camera last shown, for the settings save on the way out
  const pending = useRef(new Set()); // changes that came before the sessions opened
  const timer = useRef(0);
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = new BoardStore(draft.board ?? blankBoard(), { client: clientId() });
  const store = storeRef.current;
  const selectionRef = useRef(null);
  if (!selectionRef.current) selectionRef.current = createSelection();
  const selection = selectionRef.current;
  const mediaRef = useRef(null);
  if (!mediaRef.current) {
    mediaRef.current = mediaOf(store.board.media);
    // A record's pictures come back as data URLs from the images store (file-family inline), so the same save wrote their files:
    // the board sends the stored reference form from here on, and no save carries a picture's bytes again.
    for (const [key, url] of Object.entries(store.board.media)) {
      const m = /^data:(image|video)\/([a-z0-9.+-]+);base64,/i.exec(String(url).slice(0, 80));
      if (m && /^[a-f0-9]{64}\.[a-z0-9.+-]+$/.test(key)) store.board.media[key] = `data:${m[1].toLowerCase()}/${m[2].toLowerCase()};sha256,${key.split('.')[0]}`;
    }
  }
  const media = mediaRef.current;
  const theme = useStore((s) => s.settings?.theme);
  const [bg, setBg] = useState(store.board.bg ?? 'canvas');
  const [empty, setEmpty] = useState(() => store.live().length === 0);

  /** Saves the camera as this board's view, unless it is the one stored already or the draft is gone (its view goes with it). */
  const writeView = (camera) => {
    const settings = getState().settings ?? {};
    if (!(getState().drafts ?? []).some((d) => d.id === draft.id)) return;
    const was = settings.boardViews?.[draft.id];
    if (was && was.x === camera.x && was.y === camera.y && was.zoom === camera.zoom) return;
    saveSettings({ boardViews: { ...(settings.boardViews ?? {}), [draft.id]: { x: camera.x, y: camera.y, zoom: camera.zoom } } });
  };

  const fitAll = (v) => {
    const b = bounds(v.placements);
    if (b) v.setCamera(fitRect(b, v.size, 48));
  };

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !e.shiftKey) return;
    // A tool editing text on the board (a text item, a label) and any field of it keep their keys.
    if (face.current?.ctx.api?.editing) return;
    const target = e.target;
    if (target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    const v = vp.current;
    if (!v) return;
    if (e.code === 'Digit1') fitAll(v);
    else if (e.code === 'Digit0') v.setCamera({ zoom: 1 }); // the view's centre holds
    else return;
    e.preventDefault();
  };

  const place = () => {
    const v = vp.current;
    const f = face.current;
    if (v && f) v.setPlacements(placementsOf(store, f.surfaces, f.client.id, f.ctx));
  };

  // The board session and the item session: the item session's blank document is the base every item's model is made from.
  useEffect(() => {
    const boardId = 'board:' + draft.id;
    const itemId = 'item:' + draft.id;
    // A tool's open edit goes into the written board (`flushEdits`: a text being typed lives in the item session until it
    // ends), so switching drafts or saving never drops it.
    let mine = null;
    const save = async () => {
      const board = store.toJSON();
      for (const [id, fields] of (await mine?.flushEdits?.()) ?? []) {
        if (board.items[id]) board.items[id] = { ...board.items[id], ...fields };
      }
      const reply = await window.api.drafts.save(JSON.stringify({ ...draft, board }));
      // The save moved the pictures it carried into the images store: their references go back into the board, so a later save
      // (a move, a crop) sends no picture bytes and main hashes none.
      for (const [key, value] of Object.entries(reply?.media ?? {})) if (store.board.media[key] !== undefined) store.board.media[key] = value;
      return { id: reply.id, updated: reply.updated };
    };
    const detach = attachCanvas(draft, save);
    let dead = false;
    let client = null;
    let item = null;
    let api = null;
    let offPointer = null;
    let offs = [];
    (async () => {
      // A quick reopen of this board waits for the view before it to let go (closing), so one session never has two views.
      await Promise.all([closing.get(boardId), closing.get(itemId)]);
      if (dead) return;
      client = host.session(boardId);
      item = host.session(itemId);
      await client.call('boardInit');
      if (dead) return;
      await item.call('boardInit');
      if (dead) return;
      const saved = await item.save('engine');
      if (dead) return;
      const surfaces = createSurfaces({ apply: (list) => {
        const transfer = list.filter((e) => e.model).map((e) => e.model.buffer);
        return client.call('boardApply', [list], transfer);
      }, base: blankModel(saved), media });
      const ctx = { api: null, store, selection, client, item, surfaces, draft, journal: null, media, save, dirty: markDirty, place };
      mine = ctx;
      Object.defineProperty(ctx, 'vp', { get: () => vp.current, enumerable: true });
      // The chrome's board (rail, item ribbon, board menu, commands): Board's names over this board's store and view.
      api = new PlaneBoard({ store, selection, vp: () => vp.current, surfaces, client, draft });
      ctx.api = api;
      face.current = { client, item, surfaces, ctx };
      window.__board = ctx;
      setPlaneBoard(api);
      // Tools mount once every part of the context exists; the selection overlay draws above the items.
      offs = modules.map((module) => module.mount?.(ctx)).filter((off) => typeof off === 'function');
      offPointer = boardPointer(ctx);
      vp.current?.overlays.register('board-selection', () => <BoardSelection ctx={ctx} />, { plane: 'screen' });
      const ids = new Set(Object.keys(store.board.items));
      for (const id of pending.current) ids.add(id);
      pending.current.clear();
      await surfaces.sync(store, ids);
      if (!dead) place();
    })().catch((e) => console.warn('The board did not open', e));
    return () => {
      dead = true;
      if (window.__board === face.current?.ctx) window.__board = null;
      face.current = null;
      if (api) {
        setPlaneBoard(null); // it never published one if the area went before its sessions opened
        api.destroy();
        api = null;
      }
      offPointer?.();
      for (const off of offs) off();
      offs = [];
      vp.current?.overlays.register('board-selection', null);
      // Edits not saved yet are saved first, while the sessions are still open.
      const dirty = getState().draft === draft && getState().dirty;
      const done = (dirty ? saveNow() : Promise.resolve(false)).catch(() => false).finally(() => {
        detach();
        client?.release();
        item?.release();
      });
      for (const id of [boardId, itemId]) {
        closing.set(id, done);
        done.finally(() => {
          if (closing.get(id) === done) closing.delete(id);
        });
      }
    };
  }, []);

  // Every change to the board: repaint what it changed (a picture that arrived included), reroute what names it, place the items,
  // and mark the draft dirty.
  useEffect(() => store.subscribe(({ ids }) => {
    if (ids.has(null)) setBg(store.board.bg ?? 'canvas');
    setEmpty(store.live().length === 0);
    const set = new Set(ids);
    // A picture's bytes may come in with a change of another field (a peer's merge, a paste): the map takes them here, and the
    // items that name them stamp again with their picture.
    const added = mergeMedia(media, store.board.media);
    if (added.length) {
      const keys = new Set(added);
      for (const item of store.live()) if (item.media != null && keys.has(item.media) && !set.has(item.id)) set.add(item.id);
    }
    const f = face.current;
    if (!f) {
      for (const id of set) pending.current.add(id);
      markDirty();
      return;
    }
    for (const item of store.live()) {
      if (set.has(item.id)) continue;
      const deps = ruleOf(item.type)?.dependsOn?.(item);
      if (deps?.some((d) => set.has(d))) set.add(item.id);
    }
    f.surfaces.sync(store, set).then(place);
    markDirty();
  }), [store]);

  const onViewport = (v) => {
    offView.current?.();
    offView.current = null;
    vp.current = v;
    if (!v) return;
    const saved = getState().settings?.boardViews?.[draft.id];
    if (saved && Number.isFinite(saved.zoom)) v.setCamera(saved);
    const show = () => {
      cam.current = v.camera;
      const want = Math.round(v.camera.zoom * 10000) / 100;
      if (typeof getState().zoom !== 'number' || Math.abs(getState().zoom - want) > 0.01) setZoom(want);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => writeView(v.camera), 1000);
    };
    const offCam = v.subscribe('camera', show);
    v.root.addEventListener('keydown', onKey);
    const offZoom = attachBoardCamera({ setCamera: (c) => v.setCamera(c), fit: () => fitAll(v) });
    offView.current = () => {
      offCam();
      offZoom();
      v.root.removeEventListener('keydown', onKey);
      clearTimeout(timer.current);
      if (cam.current) writeView(cam.current); // a camera moved in the last second
      vp.current = null;
    };
    show(); // the status bar shows this board's zoom, and its slider drives it
    place();
  };

  // No DOM selection on the plane: a drag left a Range behind, and the next press dragged it natively (dragstart, pointercancel),
  // which ended the board's drag after one step.
  return (
    <Viewport host={host} driver={panDriver} zoomRange={{ min: 0.02, max: 8 }} pressFocus={false} spacePan={() => !face.current?.ctx.api?.editing}
      label={draft.title} data-board="" style={{ position: 'absolute', inset: 0, background: resolveBg(bg, theme), userSelect: 'none' }}
      onViewport={onViewport}>
      {/* The paper of a draft's pages too small for a tile: before the sizer, so below every slot. */}
      <PaperLayer ctx={() => face.current?.ctx ?? null} />
      {empty && <EmptyHint />}
    </Viewport>
  );
}
