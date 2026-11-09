// The Thesaurus pane (docs/plans/word/briefs/ph-misc-2.md §5, probe/dialogs.md thesaurus-pane; pane id thesaurus, right): the word
// under the caret or selection, its senses and antonyms from the WordNet list (thesaurus-en.txt), Back through the words browsed,
// and a word's Insert and Copy. Opening it (Shift+F7, right-click Synonyms) reads the engine's selection.
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Pick } from '../../../tooling/kit/controls.jsx';
import { reviewApp } from '../../canvas/rows/review.mjs';
import { insertWord, wordHere } from './canvas.js';
import { indexOf, lookup, matchCase } from './thesaurus.mjs';

// The list is beside the source and ships with it (package.json build.files has src/**): a bundled renderer's import.meta.url is
// empty, so it is fetched from the page's own root, as the engine worker and its data are.
let data = null;
const load = () => (data ??= fetch(new URL('src/document/wp/proofing/thesaurus-en.txt', document.baseURI)).then((r) => r.text()).then(indexOf));

/** The pane: the props of panes.jsx PaneSpec.Component. */
export function ThesaurusPane({ ctx, props }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState(null);
  const [back, setBack] = useState([]);
  const [at, setAt] = useState(null);
  const [source, setSource] = useState('');

  const look = (word) => load().then((index) => setFound(lookup(index, word)));

  useEffect(() => {
    let live = true;
    (async () => {
      const here = ctx.engine ? await wordHere(ctx.engine) : null;
      const index = await load();
      if (!live) return;
      setText(here?.word ?? '');
      setAt(here);
      setSource(here?.word ?? '');
      setBack([]);
      setFound(here ? lookup(index, here.word) : null);
    })();
    return () => { live = false; };
  }, [ctx.engine, props.n]);

  const go = (word) => {
    setBack([...back, text]);
    setText(word);
    look(word);
  };
  const goBack = () => {
    if (!back.length) return;
    const word = back.at(-1);
    setBack(back.slice(0, -1));
    setText(word);
    look(word);
  };
  const insert = async (word) => {
    const out = matchCase(source ?? text, word);
    await insertWord(ctx.engine, at, out);
    setAt(at && { ...at, end: at.start + out.length });
    setSource(out);
  };

  const foreign = at?.lang && !at.lang.startsWith('en');
  return (
    <div data-thesaurus-pane="" className="flex h-full flex-col gap-3 p-2">
      <div className="flex items-center gap-1.5">
        <Button size="icon-sm" variant="outline" aria-label="Back" data-thes-back="" disabled={!back.length} onClick={goBack}>
          <ArrowLeft />
        </Button>
        <Input aria-label="Source word" data-thes-input="" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') look(text); }} className="h-7 min-w-0 flex-1" />
        <Button size="icon-sm" variant="outline" aria-label="Search" data-thes-search="" onClick={() => look(text)}>
          <Search />
        </Button>
      </div>
      <div role="tree" aria-label="Synonyms" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {foreign ? <p>The thesaurus has English words only.</p> : <>
          {found?.senses.map((sense) => (
            <div role="group" key={sense.heading}>
              <div data-thes-sense="" className="text-xs font-medium text-muted-foreground">{sense.heading}</div>
              {sense.words.map((word) => <Row key={word} word={word} go={go} insert={insert} />)}
            </div>
          ))}
          {!!found?.antonyms.length && (
            <div role="group">
              <div className="text-xs font-medium text-muted-foreground">Antonyms</div>
              {found.antonyms.map((word) => <Row key={word} word={word} go={go} insert={insert} />)}
            </div>
          )}
          {!found && text.trim() && <p data-thes-none="">No results found.</p>}
        </>}
      </div>
      <Pick aria-label="Language" value="en-US" options={[['en-US', 'English (United States)']]} onChange={() => {}} disabled />
    </div>
  );
}

/** A result word: its button looks the word up, its chevron menu inserts it into the document or copies it. */
function Row({ word, go, insert }) {
  return (
    <div data-thes-word={word} className="flex items-center gap-1">
      <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-accent" onClick={() => go(word)}>{word}</button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label="Insert or copy"><ChevronDown /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => insert(word)}>Insert</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => reviewApp.copyText(word)}>Copy</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
