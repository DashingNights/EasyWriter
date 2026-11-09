// Word's Font Substitution (File > Options > Advanced > Show document content > Font Substitution...): the document's fonts this
// computer lacks and what draws each. Word lets the user pick an installed font for a missing one; here the provider decides
// (fonts/provider.mjs): an open font with the same metrics, named first with the font it stands in for in brackets (the user,
// 2026-10-30), or for Aptos Microsoft's own download page, which the app opens and never fetches itself. Below the list, the open
// fonts EasyWriter ships or downloads, each with its licence: the app's font licences list.
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Help } from '../../app/components/Tip.jsx';
import { WordDialog } from '../../tooling/kit/WordDialog.jsx';
import { activeSurface } from '../../tooling/surface.js';
import { fontLabel, fontsKnown, isInstalled, listFonts } from '../fonts.js';
import { BUNDLED, CATALOGUE, docFonts, resolve, standsFor, vendorOf } from './provider.mjs';

/** What a substitute means for the layout, for the row's Help. */
function note(r) {
  if (!r.font) return 'No font on this computer stands in for it, so a default font draws it and lines may break differently from Word.';
  const fits = r.metric ? 'It has the same character widths and line height, so lines break as in Word.'
    : 'Its character widths differ, so lines may break differently from Word.';
  const from = r.kind === 'installed' ? 'It is installed on this computer.' : r.kind === 'download'
    ? `It is downloaded once from its official source when a document needs it (${r.entry.licence}).` : `It ships with EasyWriter (${r.entry.licence}).`;
  return `${fits} ${from}`;
}

export function FontSubstitution({ onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    const doc = activeSurface()?.editor?.state.doc;
    // Without the installed fonts (the query failed) every font would count as missing: say so instead of listing them.
    listFonts().then(() => live && setRows(!fontsKnown() ? 'unknown' : (doc ? docFonts(doc) : []).filter((f) => !isInstalled(f)).sort()
      .map((family) => ({ family, ...resolve(family, isInstalled), vendor: vendorOf(family) }))));
    return () => { live = false; };
  }, []);

  return (
    <WordDialog title="Font Substitution" size="md" onClose={onClose}>
      <div data-font-substitution="" className="flex flex-col gap-3">
        {rows === 'unknown' && <p data-unknown="">EasyWriter cannot tell which fonts are installed on this computer, so it cannot list the missing ones.</p>}
        {Array.isArray(rows) && !rows.length && <p data-none="">Every font this document uses is installed on this computer.</p>}
        {Array.isArray(rows) && rows.length > 0 && (
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="text-muted-foreground">
              <tr className="border-b"><th className="py-1 font-normal">Missing document font</th><th className="py-1 font-normal">Substituted font</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.family} data-font={r.family} data-draws={r.font ?? ''} data-kind={r.kind ?? ''} className="border-b last:border-b-0">
                  <td className="truncate py-1 pr-2">{r.family}</td>
                  <td className="py-1">
                    <span className="flex items-center gap-1">
                      <span className="min-w-0 truncate">{r.font ? fontLabel(r.family) : 'Default'}</span>
                      <Help>{note(r)}</Help>
                      {r.vendor && (
                        <Button asChild variant="outline" size="xs" className="ml-auto shrink-0" data-vendor={r.vendor.url}>
                          <a href={r.vendor.url} target="_blank" rel="noreferrer"><Download />Get from Microsoft</a>
                        </Button>
                      )}
                      {r.vendor && <Help>{`${r.vendor.name} are free from Microsoft but may not be shared, so EasyWriter cannot include them. Install them, then restart EasyWriter.`}</Help>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <FontLicences />
      </div>
    </WordDialog>
  );
}

/** The open fonts EasyWriter ships or downloads: name, version, licence and official source, and the licence text on demand. */
export function FontLicences() {
  const [text, setText] = useState({});
  const show = (e) => {
    if (text[e.family] != null) return setText({ ...text, [e.family]: null });
    const url = e.licenceUrl ?? new URL(BUNDLED + e.licenceFile, document.baseURI).href;
    fetch(url).then((r) => r.text()).catch(() => `The licence could not be read. It is at ${url}`)
      .then((t) => setText((o) => ({ ...o, [e.family]: t })));
  };
  return (
    <section data-font-licences="" className="flex flex-col gap-1">
      <h3 className="text-muted-foreground">Open fonts in EasyWriter</h3>
      <ul className="flex flex-col">
        {CATALOGUE.map((e) => (
          <li key={e.family} data-licence={e.family} className="flex flex-col border-b py-1 last:border-b-0">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{`${e.family} (${e.matches[0] ?? standsFor(e.family)[0]})`}</span>
              <span className="shrink-0 text-muted-foreground">{`${e.version}, ${e.licence}`}</span>
              <Button variant="ghost" size="xs" aria-expanded={text[e.family] != null} onClick={() => show(e)}>Licence</Button>
              <Help>{`${e.copyright}. From ${e.source}${e.kind === 'download' ? `, downloaded when a document first needs it (${Math.round(e.faces[0].bytes / 1e6)} MB)` : ''}. Its licence allows sharing it with the app.`}</Help>
            </span>
            {text[e.family] != null && (
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{text[e.family]}</pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
