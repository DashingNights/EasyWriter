// Work package backstage (docs/plans/word/plan.md §3 backstage; briefs/backstage.md): the File backstage pages mapped onto drafts,
// the Document Inspector, and Word's window keys Ctrl+O, F12 and Ctrl+W. Word's Open, Save As and Close act on files; here they
// act on drafts (recorded deviations): Open lists drafts, Save As copies the draft, Close opens the most recently updated other
// draft because EasyWriter always shows one. F12 opens the Save As page where Word opens the system Save dialog.
import { getState } from '../../../app/store.js';
import { openDraft, saveNow, toast } from '../../../app/actions.js';
import { openBackstage } from '../../ribbon/Backstage.jsx';
import { Inspector } from './Inspector.jsx';
import { Export, Home, Info, New, Open, SaveAs } from './pages.jsx';
import { byUpdated } from './recent.mjs';
import { browseWordFile, saveDocx } from '../../docx/files.js';

const page = (id) => ({ run: () => openBackstage(id) });

/** Close (Ctrl+W, Ctrl+F4): saves, then opens the most recently updated other draft; with none, a toast and nothing more. */
async function closeDraft() {
  const { draft, drafts } = getState();
  if (!(await saveNow())) return false;
  const next = byUpdated(drafts).find((d) => d.id !== draft?.id);
  if (!next) {
    toast('There is no other draft to switch to.');
    return false;
  }
  if (!(await openDraft(next.id))) return false;
  getState().editor?.commands.focus();
  return true;
}

export default {
  id: 'backstage',
  backstage: { 'file.home': Home, 'file.new': New, 'file.open': Open, 'file.info': Info, 'file.saveAs': SaveAs, 'file.export': Export },
  dialogs: { documentInspector: Inspector },
  // file.new stays base's command: Ctrl+N keeps the New draft dialog (plan.md §1.13).
  commands: {
    'file.home': page('file.home'),
    'file.open': page('file.open'),
    'file.info': page('file.info'),
    'file.saveAs': page('file.saveAs'),
    'file.saveAs.saveAsCopy': page('file.saveAs'),
    'file.export': page('file.export'),
    'file.info.inspectDocument': { run: (ctx) => ctx.dialog('documentInspector') },
    'file.close': { run: () => closeDraft() },
    // Word files (src/document/docx): Open's Browse and Ctrl+F12 open one as a new Document; Change File Type saves a .docx.
    'file.open.dialog': { run: () => browseWordFile() },
    'window.openDialog': { run: () => browseWordFile() },
    'file.export.changeFileType': { run: () => saveDocx(getState().draft?.title) },
  },
  implements: ['file.back', 'file.new.templates', 'file.info.manageDocument', 'window.saveAsKey', 'window.closeWindow', 'window.newDocument'],
};
