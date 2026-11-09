// Grid and Guides (dialog gridSettings; docs/plans/word probe/dialogs/grid-settings.json): the alignment guide and snapping
// settings (settings.word.guides) and the drawing grid (doc settings grid, plan.md §1.8). float-layout's drag reads both. On a
// canvas draft the grid (its spacing, origin and every-n lines) is the engine's document setting (layout.drawingGrid).
import { useEffect, useState } from 'react';
import { useStore } from '../../../app/store.js';
import { Check, Fieldset, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { activeSurface } from '../../../tooling/surface.js';
import { wordSettings } from '../../word/settings.mjs';
import { saveGuides } from './grid.js';
import { GRID_DEFAULTS } from './order.mjs';

/** → {guides, grid} after applying them, or null on Cancel. */
export function GridDialog({ onClose }) {
  const settings = useStore((s) => s.settings);
  const surface = activeSurface();
  const engine = surface?.session ?? null;
  const editor = engine ? null : surface?.editor;
  const [g, setG] = useState(() => wordSettings(settings).guides);
  const [grid, setGrid] = useState(() => ({ ...GRID_DEFAULTS, ...editor?.state.doc.attrs.settings?.grid }));
  useEffect(() => {
    if (!engine) return;
    Promise.resolve(engine.query('document.settings', {})).then((r) => r?.value && setGrid((o) => ({ ...o, ...r.value.gridShow, h: r.value.gridH, v: r.value.gridV })),
      () => {});
  }, [engine]);
  const guide = (key) => (v) => setG((o) => ({ ...o, [key]: v }));
  const cell = (key) => (v) => setGrid((o) => ({ ...o, [key]: v }));
  const apply = () => {
    // The grid object is patched, so keys a newer build wrote stay (plan.md §1.8).
    if (engine) {
      const { h, v, useMargins, x, y, everyH, everyV } = grid;
      engine.exec('layout.drawingGrid', { h, v, useMargins, x, y, everyH, everyV });
    }
    else if (editor) editor.commands.setDocSettings({ grid: { ...editor.state.doc.attrs.settings?.grid, ...grid } });
    saveGuides(g);
    return { guides: g, grid };
  };
  // ponytail: Set As Default keeps the guide settings only; spacing, origin and every-n need a settings.word grid key first.
  const SPACING = [0.36, 1584];
  return (
    <WordDialog title="Grid and Guides" size="sm" onClose={onClose} result={apply}
      left={[{ label: 'S&et As Default', onClick: () => saveGuides(g) }]}>
      <div className="flex flex-col gap-3">
        <Fieldset legend="Alignment Guides">
          <Check label="&Display alignment guides" checked={g.display} onChange={guide('display')} />
          <div className="flex flex-col gap-1 pl-6">
            <Check label="&Page guides" checked={g.page} disabled={!g.display} onChange={guide('page')} />
            <Check label="M&argin guides" checked={g.margin} disabled={!g.display} onChange={guide('margin')} />
            <Check label="Para&graph guides" checked={g.paragraph} disabled={!g.display} onChange={guide('paragraph')} />
          </div>
        </Fieldset>
        <Fieldset legend="Object Snapping">
          <Check label="S&nap objects to other objects" checked={g.snapObjects} onChange={guide('snapObjects')} />
        </Fieldset>
        <Fieldset legend="Grid settings">
          <Spin label="Hori&zontal spacing:" value={grid.h} onChange={cell('h')} unit="len" min={SPACING[0]} max={SPACING[1]} />
          <Spin label="&Vertical spacing:" value={grid.v} onChange={cell('v')} unit="len" min={SPACING[0]} max={SPACING[1]} />
        </Fieldset>
        <Fieldset legend="Grid origin">
          <Check label="Use &margins" checked={grid.useMargins} onChange={cell('useMargins')} />
          {/* A disabled fieldset disables the origin boxes while the margins are the origin, as Word does. */}
          <fieldset disabled={grid.useMargins} className="flex flex-col gap-1 disabled:opacity-50">
            <Spin label="H&orizontal origin:" value={grid.x} onChange={cell('x')} unit="len" min={0} max={1584} />
            <Spin label="Ve&rtical origin:" value={grid.y} onChange={cell('y')} unit="len" min={0} max={1584} />
          </fieldset>
        </Fieldset>
        <Fieldset legend="Show grid">
          <Check label="Disp&lay gridlines on screen" checked={g.gridlines} onChange={guide('gridlines')} />
          <fieldset disabled={!g.gridlines} className="flex flex-col gap-1 pl-6 disabled:opacity-50">
            <div className="flex items-center gap-2">
              <Check label="Ver&tical every:" checked={grid.everyV > 0} onChange={(on) => cell('everyV')(on ? 1 : 0)} />
              <fieldset disabled={!grid.everyV} className="disabled:opacity-50">
                <Spin label={null} value={grid.everyV || 1} onChange={cell('everyV')} unit="int" min={1} max={99} width="4rem" />
              </fieldset>
            </div>
            <Spin label="&Horizontal every:" value={grid.everyH} onChange={cell('everyH')} unit="int" min={1} max={99} width="4rem" />
          </fieldset>
          <Check label="&Snap objects to grid when the gridlines are not displayed" checked={g.snapGrid} onChange={guide('snapGrid')} />
        </Fieldset>
      </div>
    </WordDialog>
  );
}
