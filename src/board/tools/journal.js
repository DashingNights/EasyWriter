// bd-journal fills this tool (docs/plans/board/design.md section 7): the journal is the board's undo across sessions. It is
// built here, hears the store's steps, and takes the board session's undo and redo so keys, the ribbon and an agent all reach it.
// The app modules that save and show the line are loaded only where the board runs: a node test loading the tools never calls them.
import { getState } from '../../app/store.js';
import { Journal } from '../journal.mjs';

/** The draft title of a session id: instances are opened under their draft id, and their own view names a board or item one. */
function titleOf(session) {
  const id = String(session).replace(/^(?:board|item):/, '');
  return (getState().drafts ?? []).find((draft) => draft.id === id)?.title ?? '';
}

const saveBoard = () => import('../../app/actions.js').then(({ saveNow }) => saveNow());
const showLine = (line) => import('../../app/components/Notices.jsx').then(({ notify }) => notify({ text: line }));

export default {
  mount(ctx) {
    const journal = new Journal({
      store: ctx.store,
      clients: () => null, // instance clients register themselves through watch
      titleOf,
      say: showLine,
      save: saveBoard,
      // The area's own saveOnce path for a document instance, read when it is needed (bd-instance supplies it). Without it a
      // document part is refused once instances exist: its removal must not run on a record never saved (bd-instance).
      saveDoc: (session) => (ctx.saveDoc ? ctx.saveDoc(session) : !ctx.instances),
      // A document step, or an undo of one, changes Undo and Redo without a store change: the chrome hears it from here.
      changed: () => ctx.api?._changed(),
    });
    ctx.journal = journal;
    if (ctx.api) ctx.api.journal = journal;
    journal.watch(ctx.client);
    const off = ctx.store.subscribe(({ step }) => journal.noteBoard(step));
    return () => {
      off();
      journal.dispose();
    };
  },
  methods: {
    undo() {
      return this.journal ? this.journal.undo() : false;
    },
    redo() {
      return this.journal ? this.journal.redo() : false;
    },
    canUndo() {
      return !!this.journal?.canUndo();
    },
    canRedo() {
      return !!this.journal?.canRedo();
    },
  },
  // The key and every other caller go through the journal, so a press with nothing to undo does not fall back to the store.
  undo(ctx) {
    Promise.resolve(ctx.journal?.undo()).catch(() => {});
    return true;
  },
  redo(ctx) {
    Promise.resolve(ctx.journal?.redo()).catch(() => {});
    return true;
  },
};
