// proofing's dialogs (docs/plans/word briefs/proofing.md, probe/dialogs/word-count.json and language.json): Word Count, Readability
// Statistics, Set Proofing Language (dialog language) and Language Preferences. Each root holds data-proofing-dialog for harness cases.
import { useEffect, useId, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '../../../app/actions.js';
import { Check, Fieldset, ListPick, Pick, Radio, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { Help } from '../../../app/components/Tip.jsx';
import { saveWord } from '../../word/settings.mjs';
import { countDoc } from '../../model/count.mjs';
import { isEastAsian, languageList, langName, TAGS } from './languages.mjs';
import { linesOf, pagesOf } from './measure.js';
import { availableLangs, dictLangs, docLang, refreshLanguages, spellApi } from './spell.js';

const fmt = (n) => Number(n).toLocaleString('en-GB');

/** A statistics row: the label left, the number right. */
const Stat = ({ label, value, id }) => (
  <div className="flex justify-between gap-4" data-count={id}>
    <span>{label}</span>
    <span data-value="" className="tabular-nums">{value}</span>
  </div>
);

/** The editor Word Count reads: the open Document's main editor. */
const mainEditor = () => ctxOf().ed;

/** Word Count's numbers for editor `ed` (the selection when there is one) with notes and text boxes `notes` on or off. */
export function wordCount(ed, notes) {
  const { state, view } = ed;
  const { from, to, empty } = state.selection;
  const node = empty ? state.doc : state.doc.cut(from, to);
  const c = countDoc(node, { notes });
  const lines = view.dom.isConnected ? linesOf(view, empty ? 0 : from, empty ? state.doc.content.size : to, { notes }) : 0;
  return { ...c, pages: empty ? pagesOf(state) : pagesOf(state, from, to), lines, selection: !empty };
}

/** A canvas draft's counts: the engine's review.wordCount (the selection's when text is selected), as the DOM count's fields. */
function useEngineCount(session, notes) {
  const [c, setC] = useState(null);
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    Promise.resolve(session.query('review.wordCount', { includeTextBoxes: notes })).then((r) => {
      const v = r?.ok ? r.value : null;
      if (live && v) setC({ pages: v.pages, words: v.words, chars: v.characters, charsSp: v.charactersWithSpaces, paras: v.paragraphs, lines: v.lines, farEast: 0, korean: 0 });
    }, () => {});
    return () => {
      live = false;
    };
  }, [session, notes]);
  return c;
}

export function WordCountDialog({ onClose }) {
  const ctx = ctxOf();
  const ed = ctx.engine ? null : mainEditor();
  const [notes, setNotes] = useState(ctx.settings?.word?.proofing?.countNotes ?? true);
  const dom = useMemo(() => (ed ? wordCount(ed, notes) : null), [ed, notes]);
  const engine = useEngineCount(ctx.engine, notes);
  const c = dom ?? engine;
  const asian = !!c && (c.farEast > 0 || c.korean > 0 || (ctx.settings?.word?.proofing?.languages ?? []).some(isEastAsian));
  const keep = (v) => {
    setNotes(v);
    saveWord({ proofing: { countNotes: v } }).catch(() => {});
  };
  return (
    <WordDialog title="Word Count" size="sm" okText="Close" cancelText={null} onClose={onClose} result={() => true}>
      <div data-proofing-dialog="wordCount" className="flex flex-col gap-3">
        {c && (
          <Fieldset legend="Statistics:">
            <Stat id="pages" label="Pages" value={fmt(c.pages)} />
            <Stat id="words" label="Words" value={fmt(c.words)} />
            <Stat id="chars" label="Characters (no spaces)" value={fmt(c.chars)} />
            <Stat id="charsSp" label="Characters (with spaces)" value={fmt(c.charsSp)} />
            <Stat id="paras" label="Paragraphs" value={fmt(c.paras)} />
            <Stat id="lines" label="Lines" value={fmt(c.lines)} />
            {asian && <Stat id="nonAsian" label="Non-Asian words" value={fmt(c.nonAsian)} />}
            {asian && <Stat id="farEast" label="Asian characters, Korean words" value={fmt(c.farEast + c.korean)} />}
          </Fieldset>
        )}
        <Check label="Include textboxes, &footnotes and endnotes" checked={notes} onChange={keep} />
      </div>
    </WordDialog>
  );
}

/** Readability Statistics after a spelling check: props.stats from readability.mjs. Passive Sentences needs a grammar checker. */
export function ReadabilityDialog({ stats: r, onClose }) {
  return (
    <WordDialog title="Readability Statistics" size="sm" cancelText={null} onClose={onClose} result={() => true}>
      <div data-proofing-dialog="readabilityStatistics" className="flex flex-col gap-3">
        <Fieldset legend="Counts">
          <Stat id="words" label="Words" value={fmt(r.words)} />
          <Stat id="chars" label="Characters" value={fmt(r.chars)} />
          <Stat id="paras" label="Paragraphs" value={fmt(r.paras)} />
          <Stat id="sentences" label="Sentences" value={fmt(r.sentences)} />
        </Fieldset>
        <Fieldset legend="Averages">
          <Stat id="sentencesPerPara" label="Sentences per Paragraph" value={r.sentencesPerPara.toFixed(1)} />
          <Stat id="wordsPerSentence" label="Words per Sentence" value={r.wordsPerSentence.toFixed(1)} />
          <Stat id="charsPerWord" label="Characters per Word" value={r.charsPerWord.toFixed(1)} />
        </Fieldset>
        <Fieldset legend="Readability">
          <Stat id="ease" label="Flesch Reading Ease" value={r.ease.toFixed(1)} />
          <Stat id="grade" label="Flesch-Kincaid Grade Level" value={r.grade.toFixed(1)} />
        </Fieldset>
      </div>
    </WordDialog>
  );
}

const markOf = (node, name) => node?.marks?.find((m) => m.type.name === name) ?? null;

/** The selection's run language and noProof in editor `ed` → {tag, noProof}. */
function selectionLang(ed) {
  const { state } = ed;
  const { $from, empty } = state.selection;
  const node = empty ? null : state.doc.nodeAt(state.selection.from);
  const marks = node?.isText ? node.marks : state.storedMarks ?? $from.marks();
  const style = marks.find((m) => m.type.name === 'textStyle')?.attrs ?? markOf(node, 'textStyle')?.attrs;
  return { tag: style?.lang?.val ?? docLang(state.doc) ?? 'en-US', noProof: !!style?.noProof };
}

/** Set Proofing Language (dialog language): the selection's or the whole document's language and Do not check spelling or grammar.
 * Value mode ({mode: 'value', value}) returns {lang, noProof} without applying (find's Format menu). */
export function LanguageDialog({ mode, value, onClose }) {
  const ctx = ctxOf();
  const engine = ctx.engine; // a canvas draft: review.language marks the text (format.state gives the selection's language)
  const ed = engine ? null : ctx.target;
  const fmt = engine ? ctx.stateOf?.('format.state')?.value : null;
  const start = mode === 'value' ? { tag: value?.lang?.val ?? 'en-US', noProof: !!value?.noProof } : ed ? selectionLang(ed)
    : { tag: fmt?.lang ?? 'en-US', noProof: !!fmt?.noProof };
  const [scope, setScope] = useState('selection');
  const [tag, setTag] = useState(start.tag);
  const [noProof, setNoProof] = useState(start.noProof);
  const [detect, setDetect] = useState(ctx.settings?.word?.proofing?.detectLanguage ?? true);
  const listId = useId();
  const dicts = availableLangs() ?? dictLangs() ?? [];
  const items = useMemo(() => languageList(dicts, [start.tag]).map(([t, name, has]) => [t, has ? `${name} ✓` : name]), [dicts, start.tag]);

  const setDefault = async () => {
    const name = langName(tag);
    if (engine) {
      if (await confirmDialog({ title: 'Set as default', description: `Make ${name} the default proofing language of this document?`, confirmText: 'Set as default' })) {
        await engine.exec('review.language', { lang: tag, default: true });
      }
      return;
    }
    if (!ed || !await confirmDialog({ title: 'Set as default', description: `Make ${name} the default proofing language of this document?`, confirmText: 'Set as default' })) return;
    const { state } = ed;
    const styles = state.doc.attrs.styles ?? {};
    const run = styles.defaults?.run ?? {};
    ed.view.dispatch(state.tr.setDocAttribute('styles', { ...styles, defaults: { ...styles.defaults, run: { ...run, lang: { ...run.lang, val: tag } } } }));
  };

  const result = () => {
    if (detect !== (ctx.settings?.word?.proofing?.detectLanguage ?? true)) saveWord({ proofing: { detectLanguage: detect } }).catch(() => {});
    if (mode === 'value') return { lang: { val: tag }, noProof };
    if (engine) {
      const args = { lang: tag, noProof };
      if (scope !== 'document') engine.exec('review.language', args);
      else {
        // The whole document as one undo step, the selection put back after it.
        Promise.resolve(engine.selection()).then((sel) => engine.execMany([['select.all', {}], ['review.language', args],
          ...(sel ? [['select.range', { anchor: sel.anchor, focus: sel.head ?? sel.anchor }]] : [])]));
      }
      return true;
    }
    if (!ed) return true;
    const patch = { lang: { val: tag }, noProof: noProof || null };
    if (scope === 'document') {
      const { from, to } = ed.state.selection;
      ed.chain().focus().selectAll().setRunProps(patch).setTextSelection({ from, to }).run();
    } else ed.chain().focus().setRunProps(patch).run();
    return true;
  };

  return (
    <WordDialog title="Language" size="sm" onClose={onClose} result={result} left={mode === 'value' ? [] : [{ label: 'Set As &Default', onClick: setDefault }]}>
      <div data-proofing-dialog="language" className="flex flex-col gap-3">
        {mode !== 'value' && (
          <Fieldset legend="Change proofing language for:">
            <Radio name="langScope" value={scope} onChange={setScope} options={[['selection', '&Selected text'], ['document', '&Current Document']]} />
          </Fieldset>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={listId} {...accessProps('&Mark selected text as:')}><AccessText label="&Mark selected text as:" /></label>
          <ListPick id={listId} aria-label="Mark selected text as:" items={items} value={tag} onChange={setTag} height="10rem" />
        </div>
        <Help className="self-end">The speller and other proofing tools automatically use dictionaries of the selected language, if available.</Help>
        <Check label="Do &not check spelling or grammar" checked={noProof} onChange={setNoProof} />
        <Check label="D&etect language automatically" checked={detect} onChange={setDetect} />
      </div>
    </WordDialog>
  );
}

/** Language Preferences: the editing languages (settings.word.proofing.languages), each marked with whether a dictionary exists;
 * Add, Remove and Set as Preferred; OK saves them and turns their dictionaries on. */
export function LanguagePreferencesDialog({ onClose }) {
  const ctx = ctxOf();
  const [list, setList] = useState(ctx.settings?.word?.proofing?.languages ?? ['en-US']);
  const [sel, setSel] = useState(list[0] ?? null);
  const [add, setAdd] = useState(TAGS.find((t) => !list.includes(t)) ?? 'en-GB');
  const avail = availableLangs();
  const has = (t) => !avail || avail.some((d) => d.toLowerCase() === t.toLowerCase());
  const others = TAGS.filter((t) => !list.includes(t)).map((t) => [t, langName(t)]).sort((a, b) => a[1].localeCompare(b[1]));
  const result = () => {
    saveWord({ proofing: { languages: list } }).catch(() => {});
    Promise.resolve(spellApi()?.setLanguages?.(list)).then(refreshLanguages, () => {});
    return list;
  };
  const move = (t) => setList([t, ...list.filter((x) => x !== t)]);
  return (
    <WordDialog title="Language Preferences" size="sm" onClose={onClose} result={result} validate={() => (list.length ? null : 'Keep at least one editing language.')}>
      <div data-proofing-dialog="languagePreferences" className="flex flex-col gap-3">
        <Fieldset legend="Editing languages">
          <div role="listbox" aria-label="Editing languages" className="flex h-32 flex-col overflow-auto rounded-md border border-input bg-background text-xs">
            {list.map((t, i) => (
              <div key={t} role="option" aria-selected={t === sel} data-lang={t} onClick={() => setSel(t)}
                className={cn('flex cursor-default justify-between gap-2 px-1.5 py-0.5', rowClass(t === sel))}>
                <span>{langName(t)}{i === 0 ? ' (preferred)' : ''}</span>
                <span>{has(t) ? 'Dictionary' : 'No dictionary'}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" disabled={!sel || list.length < 2} onClick={() => { setList(list.filter((x) => x !== sel)); setSel(null); }}>Remove</Button>
            <Button size="xs" variant="outline" disabled={!sel || list[0] === sel} onClick={() => move(sel)}>Set as Preferred</Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Pick aria-label="Add a language" value={add} options={others} onChange={setAdd} width="14rem" />
            <Button size="xs" variant="outline" disabled={!add || list.includes(add)} onClick={() => { setList([...list, add]); setSel(add); }}>Add</Button>
          </div>
        </Fieldset>
      </div>
    </WordDialog>
  );
}
