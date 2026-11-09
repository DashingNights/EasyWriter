# Where the engine came from, and EasyWriter's changes

The engine started from WordCraft (https://github.com/storytold/wordcraft) at commit 1be606de0341e1482b9b5a1be4a1793b217b0573
(2026-10-29 22:41:10 -0400, version 0.12.0): the crates geom, doc, fonts, layout, render, pdf, engine, docx, docbin, formats, proof
and metafile, under MIT OR Apache-2.0. LICENSE-MIT, LICENSE-APACHE, NOTICE and ATTRIBUTION.md stay as that licence requires. The
code is EasyWriter's now and follows no upstream (docs/plans/engine/plan.md section 1). Everything below differs from WordCraft at
that commit.

## Names (engine-move, 2026-10-31)

The tree moved from src/vendor/wordcraft to engine/ (docs/plans/engine/viewport-design.md section 9). The sections below name the
crates by their WordCraft folders. Packages and folders now:

| WordCraft folder | Folder | Package | Library (WordCraft's) | Library since engine-rename |
|---|---|---|---|---|
| crates/geom, doc, fonts, metafile, proof, pdf, docx, docbin, formats | the same | ew-geom, ew-doc, and so on | wordcraft_geom, wordcraft_doc, and so on | ew_geom, ew_doc, and so on |
| crates/layout | crates/doc-layout | ew-doc-layout | wordcraft_layout | ew_doc_layout |
| crates/engine | crates/doc-edit | ew-doc-edit | wordcraft_engine | ew_doc_edit |
| crates/render | crates/scene | ew-scene | wordcraft_render | ew_scene |
| ew (EasyWriter's) | crates/wasm | ew-wasm | ew | ew |

The libraries and the workspace keys kept their old names through the move, so no source file changed with it. The identifier
rename (P7, below) renamed them. PIN and CHANGES.md became this file.

## Our names (engine-rename, P7, 2026-11-01)

scripts/engine-rename.mjs renamed WordCraft's identifiers from one table: each library has its package's name, the workspace keys
are the package names and the `[lib] name` lines are gone; `WORDCRAFT_*` environment variables are `EW_*` (`EW_REGION`,
`EW_DICTIONARIES`, `EW_SPEECH`, `EW_TEST_KAI_FONT`, `EW_DOCBIN_FIXTURES`), and temporary files, folders and the recovery thread
start `easywriter-` (a safe save's `.easywriter-save-*.tmp`). The script also converts a branch's patch from before the rename.
test/word-engine-rename.test.mjs fails on any WordCraft name, or WordCraft in code or a string, outside this file, the licence
files, ATTRIBUTION.md and the old values the readers still take. A comment in engine/ calls the engine EasyWriter; one that
credits WordCraft (code from it, its stored form, its tools) takes a form the script's CREDIT lists.

Text and values that say EasyWriter now:

- The files the engine writes: the generator of .html (`<meta name="generator">`), .odt (`meta:generator`, `EasyWriter/<version>`)
  and .rtf (`\*\generator`), the comment that opens a .tex, the PDF's creator and producer, all with the app's version
  (ew-doc's app.rs, which the wasm host's `setAppVersion` sets from package.json), and a .docx's `Application` (Word keeps its own
  version form in `AppVersion`, so none is written there).
- A new document's creator (sample.rs) and a session's default author, `EasyWriter User`; the error messages of opening, safe
  saving and decrypting; the notes on charts and SmartArt made elsewhere and on Researcher; two .doc reader warnings; the paste
  format alias `easywriter` (was `wordcraft`).
- The .docx reader's bookkeeping keys in `passthrough` start `easywriter:`; byte_store.rs (`current_key`) reads `wordcraft:` keys from
  records and undo histories written before, an undo step's list of the keys it lacks included (history_file.rs), and the stored form
  is version 8 (no field changed), so a build at 7 refuses it instead of missing them. The canvas turn's `a:ext` URI is `urn:easywriter:canvas-xfrm`; a .docx with `urn:wordcraft:canvas-xfrm` still
  reads its turn.
- A native build of proof's hunspell.rs no longer looks in `WordCraft\dictionaries` under `%LOCALAPPDATA%` and `%APPDATA%`: the
  app hands the engine its dictionaries, and EasyWriter's own folder there is its profile.
- The crates' descriptions say EasyWriter, and the `repository` fields that pointed at WordCraft are gone.

## The copy

- Only the crates the document engine builds (docs/plans/engine/plan.md section 1): geom, doc, fonts, layout, render, pdf, engine,
  docx, docbin, formats, proof and metafile. Left out: ui-egui, mcp, control-key, zotero, the apps, xtask, docs and packaging.
- `assets/`: the files the crates compile in. The fonts (Source Sans 3, Source Serif 4, Inter, JetBrains Mono) are all under the
  SIL Open Font License 1.1, so all are kept, each with its OFL file. The hyphenation patterns and word lists keep the licences
  ATTRIBUTION.md and NOTICE give them.
- `Cargo.toml`: the workspace reduced to these crates and `ew`; the dependencies only the left-out crates used, their
  `[patch.crates-io]` entries and the release profile's notes went with them. `Cargo.lock` is WordCraft's, pruned by cargo to
  what these crates use. Built offline, cargo took two Unix-only packages at the versions in its local cache: libc 0.2.186
  (WordCraft: 0.2.191) and rustix 1.1.4 (1.1.5). Neither is in the WebAssembly build.
- `ew/`: EasyWriter's wrapper crate (the engine API of plan.md section 3 through wasm-bindgen, and a WebAssembly allocator that
  grows memory 32 MiB at a time). It is EasyWriter's code, not WordCraft's.

## metafile

The crate was vendored on its own first (src/vendor/wordcraft-metafile, now only its binding) and moved here with its code as it was
and WordCraft's own Cargo.toml back. Its changes
are listed in src/vendor/wordcraft-metafile/README.md: WMF and EMF ANSI text, `Text::ansi` for code pages the reader has no table
for, ETO_CLIPPED, and clip boxes (`Picture::clips`, a `clip` on each `PlacedItem`), with tests in `crates/metafile/src/tests.rs`.

## render and pdf

`crates/render/src/media.rs` and `crates/pdf/src/picture.rs` match `PlacedItem` with `..`, so they build with the metafile
crate's new `clip` field. They do not apply the clip yet: a metafile drawn on a page or in a PDF is unclipped, as before.

## fonts and layout: fonts that arrive after the first layout

In the browser the engine starts with only its bundled faces, and the app's font provider (src/engine/fonts) adds a document's
fonts as their bytes come in. These changes let a font that arrives lay out again only the paragraphs that use it.

- `crates/fonts/src/fontdb/changes.rs` (new): `FontDb::family_generation(family)`, the font generation a family last changed at;
  `take_missing_families()` (families `word::resolve` drew with a stand-in, each once until their own faces arrive, as
  `MissingFamily {family, stand_in, stand_ins}`: the font drawn in now and the list `word::stand_ins` picks from, so the app
  loads the stand-in the engine would choose instead of choosing one itself),
  `take_missing_scripts()` (ISO 15924 codes of characters no loaded face covers) and `missing_families()`; `track_families(f)`,
  which returns the families `f` asked the database about, with `FALLBACK_USE` for a character fallback. Tests in the same file.
- `catalog.rs`: `add_font` and `add_document_fonts` move the generation forward and record the families they added. The native
  lazy load of installed fonts keeps `add_fonts`, which records nothing, so desktop WordCraft behaves as before.
- `lookup.rs` (`has_family`), `word.rs` (`resolve`, `stand_in` and the public `stand_ins`) and `fallback.rs` note what a
  paragraph asks about. Layout's missing roman font (`para/chars.rs` `lookup_family`) is reported with Cambria as its stand-in. A missing
  family changes only when its own faces arrive or its stand-in becomes another font.
- `crates/layout/src/cache.rs`, `ctx.rs` and `pass.rs`: the layout cache keeps the families each paragraph layout and measure
  asked about and the generation it was made at, and drops it when one of them changed since. Test in
  `crates/layout/src/font_tests.rs`.
- `crates/engine/src/session/layout.rs`: `Session::fonts_changed`.
- `ew`: `addFont` relays out through the cache, and `takeMissingFonts` and `missingFonts` feed the worker's `fonts.missing` event.

## doc: pictures in the native JSON as data URLs

`crates/doc/src/byte_store.rs` writes a `media` or `passthrough` part whose name ends in a picture extension as
`data:image/<ext>;base64,...` instead of bare base64, and reads either. EasyWriter stores a canvas draft as this JSON
(docs/plans/engine/model.md), and its draft store keeps data URL pictures once in `images/` rather than in every save. The `ew`
crate's `save('engine')` writes the JSON compact.

## Incremental layout (engine-incremental)

An edit lays out only what it changes, and comes out as a whole layout does (ew/tests/incremental.rs checks random edits
against a whole layout, on small documents and on the Word fixture).

- `crates/layout/src/pass.rs`: a pass in the print view records marks (the pagination state where each page's first
  block starts and at each section's top: `cache::Mark`) and leaves them with its layout (`DocLayout::resume`, a
  `cache::Resume` with the document and options it was laid out from and the inputs of its pass). `relayout(doc, cache,
  opts, prev)` (exported from lib.rs) takes the layout before an edit, finds the body blocks the edit changed by pointer
  (blocks are shared until edited), starts from the last mark before what they can reach (the paragraph before reads the
  next one's properties; a chain kept with the next measures its lines), lays out until the pagination is back in a
  mark's state, and takes the old pages from there (inside the page being filled when it can: top-aligned, not turned,
  not mirrored, nothing put behind its text later). It lays the whole document out instead when anything outside the body
  changed (but a footnote's or a text box's text, which lays out the paragraph showing it; an endnote, drawn at the
  section or document end, lays it all out), when the view's options did, when
  note references or section breaks were added or taken away, or when the floats placed above their anchors, the pages of
  footnotes numbered on each page, or the page totals the body shows came out different. Headers and footers are laid out
  on the pages laid out again (on all of them when the totals or a PAGEREF's page changed; from there on with STYLEREF).
  The line index is patched (rebuilt when blocks were added or taken away). `walk_sections` is the section loop of
  `layout_pass`, shared by both; `finish_pages` turns only the pages laid out again; `uncovered_floats` no longer drains
  `Ctx::floats_above` (the record keeps it).
- `crates/layout/src/cache.rs`: `Resume`, `Mark`, `PbState` (the page builder's state as plain values, one field list for
  saving, loading and comparing), the block shifting of pages and marks after an edit that added or took away blocks, and
  `Totals::count` (the raw counts `Totals::of` evens out).
- `crates/layout/src/lib.rs`: `DocLayout::resume` and the `relayout` export. `crates/layout/src/headers.rs`:
  `headers_footers` takes the range of pages to lay out. `crates/doc/src/numbering.rs`: `Counters` (and `LevelFlags`)
  derive `PartialEq`, so a mark compares list counters.
- `crates/engine/src/session`: `layout_with` lays the layout last made for the same view out again with `relayout` (taken
  out of its slot, so its pages are reused rather than copied), and `Session::take_layout_change` gives the pages laid out
  again since it was last asked (all of them for another document or view). The `layout_changed` field joins the
  session's field lists.
- `ew/`: the layout event's `from` and new `to` come from `take_layout_change` (the layout shown before is no longer kept
  to compare pages), and the pages' sizes are turned into JSON only when they change. `ew/examples/keystroke.rs` times
  typed letters natively; `ew/tests/incremental.rs` is the randomised check.
- Not done: a change that moves every page after it (a line more at the top of a document without page breaks) still lays
  out to the end; with the engine's own spelling marks on (`LayoutOptions::proofing`; the app turns them off), moving the
  word being typed lays out everything between the old and the new word; a layout still held elsewhere when the next one
  is made (its Arc shared) is laid out whole.

## engine-fidelity: Word's rules measured on the Word fixture

Each change is marked `EasyWriter:` in the code and has a test. The measurements are in docs/plans/engine/fidelity.md and
docs/plans/engine/page-walk-findings.md.

layout:
- `para/lines.rs`: a picture that sets its line's height stands for Single, and Multiple spacing adds its share of the text's
  single line under it; a line of only pictures leaves no descent under them (Word probes and the fixture's Shapes and Crop
  pages). Two WordCraft tests (`line_spacing_does_not_scale_pictures`, `list_label_does_not_inflate_an_inline_picture_floor`)
  now expect Word's rule; `a_picture_beside_text_keeps_the_descent_and_the_multiples_share` is new.
- `flow.rs`: keep with next counts the kept paragraph's space after (it did further down a chain), and the next paragraph's
  last counted line reaches to its text's bottom under Multiple spacing, as `fit_height` fits it at the bottom margin; a
  keep-lines paragraph ending the page fits to its last line's text the same way (`keep_together`).
- `para/builder.rs` (`word_line`): an East Asian font (OS/2 code pages) takes 1.3 times its Windows ascent plus descent, the
  extra split evenly. Adds `skrifa` (already a workspace dependency) to the crate.
- `para/model.rs` (`effect_room`): shadow, glow and reflection grow their run's line box by Word's measured room.
- `boxes.rs` (`line_room`): a paragraph border takes the room its style draws (double 3w, triple 5w, wave 3 or 3.75 pt,
  the thin-thick styles w + 1.5 to 2w + 3, 3-D w + 1.5 or w + 3, double wave 5.25 pt); `table.rs` gives cell borders the
  same room above the cell's text. `display/page.rs` draws the thin-thick styles as double or triple lines. The pdf crate's
  `triple_borders_export_three_lines` now expects the triple line's centre 2 widths lower than a single line's.
- `para/eq_field.rs` (new) and `para/paragraph.rs`: EQ fields (fractions, roots, arrays, brackets, integrals, lists, scripts,
  boxes) lay out as equations in display style; they were drawn only for `\o`. `ParaLayout::eq_fields` holds them apart from
  `maths`, which hit testing edits.
- `para/barcode.rs` (new), `para/paragraph.rs`, `display/lines.rs`: DISPLAYBARCODE fields draw their symbol (QR at level Q,
  Code 128 and 39, EAN-8 and 13, UPC-A and E, ITF-14, CASE, NW-7, Japan Post), ported from the DOM editor's
  `src/document/wp/fields-draw/` with Word's sizes; the line holds it as a picture. `ParaLayout::barcodes` holds them.
- `page.rs`, `headers.rs`: page borders measured from the text (`w:offsetFrom="text"`, around the header and footer distances)
  or from the page edge (the line's outer edge at its distance), shown on the pages `w:display` names; those measured from
  the text move with it on mirrored even pages (`mirror_even_pages`).
- `display/lines.rs`: automatic text on a highlight keeps its colour (Word's black-on-black hides it; shading still turns it
  white); emphasis marks (`w:em`) are drawn.
- `display/objects.rs`, `display/page.rs` (`uncropped`): a negative crop leaves blank space beside the picture instead of
  stretching it; a preset drawn from its definition draws its freeform (below); a picture cropped to a shape is clipped to
  its outline (`cropped_to_shape`). `display.rs`: `Draw::Clip` has a `path` (empty: the rectangle only), which
  `render/src/lib.rs` and `pdf/src/exporter/draw.rs` clip to; `placed.rs`: `Placed::Image::shape`.
- `tests/fixture_pages.rs` (new, ignored by default): lays out the Word fixture and writes each page's text and line baselines
  for `.smoke-data/word/fixture/walk/geoalign.py`. `wordcraft-docx` is a dev-dependency for it.

docx:
- `read/story/vml.rs` (`watermark_everywhere`): Word's watermark becomes the document's watermark only when every header holds
  it; otherwise it stays a shape in the headers that do (the fixture's was drawn on 931 pages, Word draws it on 2).
- `read/props.rs`: a border's `w:space` wraps at 32 pt as Word's does; `w:eastAsiaTheme` names the theme's `a:ea` font or its
  font for the script of `w:themeFontLang/@w:eastAsia`; `w:em` is read; `w:pgBorders` keeps `w:offsetFrom`, `w:display` and
  `w:zOrder`. `read/parts.rs` reads the theme's `a:ea` fonts and the East Asian language.
- `read/preset_geom.rs` (new): presets no shape kind draws exactly are evaluated from the shape pool's vendored
  `src/vendor/ooxml-presets/presetShapeDefinitions.xml` (Apache-2.0, compiled in with `include_str!`) into the shape's
  freeform; the kind stays the nearest one.
- `read/story/drawing.rs`: keeps the preset and its adjust values and the `wps:bodyPr` attributes in `ShapeExtra`; keeps
  negative crops (to -1000 %); a picture's own preset other than `rect` (Crop to Shape) becomes `Float::crop_shape`.
  `read/freeform.rs`'s `bezier` is shared with `read/preset_geom.rs`.
- `write/story/drawing.rs`, `write/story/section.rs`, `write/props.rs`: write those back (the preset, the text body's
  attributes beside the model's, negative crops, page border placement, `w:em`, a picture's crop shape).

doc (wiring for the above):
- `section.rs`: `SectionProps::page_border_place` (`PageBorderPlace`).
- `connector.rs`: `ShapeExtra::preset` and `ShapeExtra::body_attrs`.
- `props/char_props.rs`, `props.rs`, `resolve.rs`: `EmphasisMark`, `CharProps::em`, `ResolvedChar::em`.
- `props/para_props.rs`: `BorderStyle` keeps Word's thin-thick, 3-D, double-wave, dashSmallGap, dotDotDash, dashDotStroked,
  inset and outset styles (they were read as single, dashed, dotDash and wave) and saves them under their names.
  `formats/src/rtf/export.rs` writes their RTF control words and `formats/src/rtf/word.rs` reads them.
- `para/float.rs`: `Float::crop_shape` (`CropShape`: the preset, its adjust values and its outline).

fonts:
- `fontdb/fallback.rs` (`load_rtl_preferred`): right-to-left text loads the `RTL_FALLBACKS` families in order up to the first
  installed one that covers it before choosing among loaded faces. The choice ranked loaded faces by that list but loaded a
  font only when none covered the text, so Hebrew fell back to Arial once anything had loaded Arial and to Segoe UI
  otherwise: one document laid out two ways in one process, and the pdf crate's
  `right_to_left_glyphs_stay_where_layout_put_them` failed when its tests ran in parallel. Test
  `right_to_left_fallback_does_not_depend_on_load_order`.

## engine-fidelity-2: the rest of the Word fixture

Measured on Word's PDF of the fixture (docs/plans/engine/fidelity.md, its engine-fidelity-2 section). Each change is marked
`EasyWriter:` in the code; the tests are in `doc-layout/src/tests/fidelity.rs`, the docx crate's `easywriter_fidelity` module
and `doc/src/section.rs`.

doc:
- `props/para_props.rs`: `BorderStyle::Art(BorderArt)`, a page art border by name (`ART_BORDERS`, ST_Border's 166 art values),
  its width in points; it reads and writes as `{"art": "<name>"}`. `formats/src/rtf/export.rs` writes it as a single line.
- `section.rs`: `NumFormat` draws Word's hebrew1, hebrew2, hindiVowels, hindiConsonants, hindiNumbers, hindiCounting,
  thaiLetters, thaiNumbers, thaiCounting and vietnameseCounting labels (they were decimal), ported from the DOM editor.
- `resolve.rs`: `ResolvedChar::lang_ea`, the East Asian language (a Chinese text's emphasis dots go under it).

docx:
- `read/props.rs`: an art border's `w:sz` is read in points; a `w:cstheme` font is the theme's (`bidi_theme_font`), as the
  other theme slots were. `write/props.rs` writes an art border's width in points.

layout:
- `para/symbol.rs` (new), `para/paragraph.rs`: SYMBOL fields draw their character in their font and size (`\f`, `\s`, `\u`,
  ANSI below 256); `\h` keeps the line as tall as its text (`ParaLayout::flat`). `\j` draws nothing.
- `para/eq_box.rs` (new, replaces `para/eq_field.rs`): EQ fields in Word's geometry, ported from the DOM editor's eqbox.mjs
  and eq.mjs; a code Word cannot read shows its bold "Error!". `para/lines.rs`: an EQ field's box adds what it reaches past
  the line's text unscaled.
- `para/lines.rs`: a DISPLAYBARCODE symbol's line is m·h + D under Multiple spacing. `para/barcode.rs`, `display/lines.rs`:
  `\t` draws the data under a linear symbol in Arial; `field_args` is the switch reader DISPLAYBARCODE and SYMBOL share.
- `para/builder.rs`: East Asian characters a Simplified Chinese font lacks fall back to Microsoft YaHei (`chinese_fallback`);
  enclosed numbers and letters (U+2460 to U+24FF, U+3200 to U+32FF) take the run's East Asian font; punctuation after
  complex-script text keeps that text's font.
- `boxes.rs` (`border_lines`, `push_rules`), `page.rs`: paragraph and page borders draw Word's lines for the triple,
  thin-thick and 3-D styles, nested at a box's corners. `display/page.rs`: dashSmallGap and dotDotDash draw Word's dashes
  as solid rules, dashDotStroked 3 pt wide, an art border as grey squares of its width. The pdf crate's
  `triple_borders_export_three_lines` expects Word's triple (lines 2 widths apart).
- `table.rs`: every cell's text starts below its row's widest top border (`CellBox::band_t`).
- `para/model.rs` (`EM_ROOM`), `display/lines.rs`: an emphasis mark adds 0.292 of its size under the line, and the marks are
  drawn where and as big as Word draws them.
- `tests.rs`: `justified_lines` lays its text out in the bundled Source Sans 3 (the machine's Aptos fitted both modes in 35
  lines). `tests/fixture_pages.rs`: lines drawn outside the page are left out of the page text, as Word's PDF leaves them out.

## A typed letter's edit path (engine-edit-path)

A letter typed into an open typing step costs the same anywhere in the document: it changes the caret's paragraph and nothing
else, so the command keeps that paragraph instead of a copy of the whole document, and skips the walks over the whole
document after it. ew/tests/edit_path.rs runs random edits (typing, deleting, splitting and joining paragraphs, styles,
formatting at the caret, selections typed over, undo and redo) in two sessions, one with light edits and one without, and
compares the document, the selection and the undo and redo steps after every command, on small documents with tables, a
footnote, a text box and content controls, and on the Word fixture.

- `crates/engine/src/session/edit_path.rs` (new): `Session::light_edit` decides whether a mutating command is a light edit:
  `text.insert` of text without a paragraph break and without an AutoCorrect trigger (unless `raw`), into the open typing
  step, at a collapsed caret, with no undo join pending, no equation, no column selection, no overtype, no Track Changes and
  no protection, in a paragraph no content control reaches. The content controls come from an index of the top-level blocks
  each story's controls reach (a marker or wrap inside, or between a control's start and end), made once for the document's
  id and revision and carried to the revision each light edit leaves. `set_light_edits`, `light_edits` and `history_steps`
  are for the test.
- `crates/engine/src/session/run.rs`: a light edit keeps `Light` (the paragraph, the selection) instead of `RunSnapshot`;
  a failed one puts them back. Only the light edit that made the index runs `ensure_nonempty` and `prune_text_boxes`
  (text added to a paragraph empties no story and takes no text box's shape away). The no-op check compares the paragraph,
  the selection and the formatting at the caret; the word being typed is noted from the paragraph's text. `note_typing`
  (session/layout.rs) takes whether the text changed instead of the document before.
- `crates/engine/src/cmd/controls.rs`: `prepare_edit` and `refuses_paragraph` look up the control at the caret through
  `typing_control_at`, which answers none without scanning the story while a light edit runs in a paragraph no control
  reaches.
- `crates/engine/src/session.rs`, `documents.rs`, `snapshot.rs`, `lifecycle.rs`: the `edit_path` field joins the session's
  field lists (one index for the session, keyed by document id).
- `ew/src/measure.rs`: the typing measure times `take_layout_change` where it timed ew's removed `first_change`, so the
  measure build compiles again.
- Not done: a space or punctuation (AutoCorrect and AutoFormat may change lists, push their own undo step and copy the
  document), Enter, Backspace and Delete, a selection typed over, the first letter of a typing step (its undo step copies
  the document) take the whole-document path, and the second makes the index and tidies the document. A letter in a table
  cell still copies the table, since the layout shown keeps the table's old copy. Typing in a paragraph that a control
  spanning several paragraphs reaches makes the index again for every letter before it takes the whole-document path.

## The 2D renderer (engine-scene, P6)

docs/plans/engine/viewport-design.md section 3: crates/render (ew-scene) paints display lists of general vector primitives and
never takes a `Document`; product engines only build the lists.

- `crates/render`: `Draw`, `Paint`, `Stroke` and `seg_path` moved here from layout's display.rs (src/draw.rs), and the WordArt
  painting helpers `ArtLayer`, `art_layers`, `glyph_path` and `path_box` from layout's wordart.rs (src/art.rs); layout
  re-exports them, so its builders compile unchanged. The crate no longer depends on layout. `Draw` derives `PartialEq`.
- New primitives (src/draw.rs, vector.rs, effects.rs): `Draw::Vector` (any path, a `FillRule`, a `Pen` with width, join, cap,
  miter and dashes), `Draw::Group` (a transform, a clip with its rule, an opacity, a `Blend` mode and `Effect`s: shadow, glow,
  soft edge, blur, reflection), `Paint::Image` (a picture stretched or repeated) and `Paint::Pattern` (items repeated in a
  cell). A group with effects is drawn into a picture of its own, single-threaded, and its effects are worked out on the
  pixels (three box blurs), the same natively and in the worker; vello_cpu's filters panic in multi-threaded contexts.
- src/list.rs: `DisplayList` (size, paper, `Layer`s with opacity, blend and a backdrop flag; each item's bounds kept),
  `damage` against an older list, and `ListCache`, display lists by owner, surface and layout version within a byte budget.
- src/media.rs: the `Media` trait (the document's media map is one; `NoMedia`) replaces the document in every lookup;
  `draw_page_picture` went (the page picture is a display item now).
- src/lib.rs: `RenderOptions` became `PaintOptions` (no `display`, no `paper`; `greek_below_px` added: glyph runs under it
  draw as grey bars). `render_list`, `render_list_region`, `render_list_area`, `render_items` and `background_at` take a list
  (or items) and a `Media`; `paint_list` paints the paper and the layers, skipping backdrop layers under a reading paper;
  `draw_watermark` went (the watermark is a display item now). Glyph culling reaches three times the size past the visible
  area (it was 100 points left and 200 below, nothing right or above), so a tile draws the part of a large glyph whose pen
  lies outside it: pages 26 and 29 of the Word fixture, each a 1,638 pt letter whose baseline lies below the page, now show
  its upper part where they were blank.
- src/tile.rs: `paint_tile` paints one 512 px tile into a buffer the caller reuses, and returns nothing for a tile no item
  reaches; a transparent surface's pixels are made straight there. src/hit.rs: `bounds`, `DisplayList::hit` (fill by rule,
  stroke by distance, topmost first, through containers), `item` and `outline`.
- The rasteriser's tests that lay a document out moved to layout's src/tests/scene_paint.rs (with color_glyphs.rs); the
  rest stay, with hand-made lists, and src/scene_tests.rs tests the new primitives.
- `crates/layout`: src/display/scene.rs builds a page's `DisplayList` (`page_list`: paper, a backdrop layer with the page
  picture, a layer with the watermark, then the header-and-footer and body layers) and keeps the document-facing shorthand:
  `RenderOptions` (`display` and `paint`), `render_page`, `render_area`, `render_items`, `background_at`.
- `crates/pdf`: the exporter reads pictures through a `Media` (`Exporter::new`), draws `Draw::Vector` and `Draw::Group`
  (a group's effects are left out of PDFs for now) and fills with pictures and patterns through a clip, and `export_lists`
  writes any product's lists as pages.
- `crates/engine`: cmd/file.rs, io_ext.rs and cmd/objects/tests.rs call layout's `render_page`.
- `ew`: src/tiles.rs (`surfaces()`, `paintTile`, `sceneStats`, the `version` getter a tile is labelled with, the worker's list cache of 64 MiB and its one tile buffer;
  `Engine` has an `id` for the cache), measure.rs's imports, and examples/scene_check.rs, the no-change check (with the pdf
  crate's PDF readers as dev-dependencies, since the PDF's bytes differ from run to run).

## One worker for every open draft (engine-host)

The worker holds one session per open draft (viewport-design.md section 8, P4). Sessions share the font database, so a
character a document's fonts lack fell back to whatever another document had loaded, and a family named in another language
(等线 for DengXian) counted as missing although its font was loaded.

fonts:
- `fontdb/scope.rs` (new): a fallback scope per session, entered by the wasm host at every call. While one is current, a
  character fallback looks only at the compiled-in faces, the families the document asked for (`word::resolve` notes them),
  and per script the first loaded family of the app's list for it (`set_script_fonts`); ties go by class and name instead of
  load order. A script whose characters no compiled-in or named face covers is reported once per session, so the app loads
  its font for that document whatever ran before. A family named after a fallback ran makes the host lay out the paragraphs
  that fell back again (`font_scope_grew`, `FontDb::scope_changed`). Natively the scope applies only with the system fallback
  off. Test `fallback_ignores_fonts_other_documents_loaded`.
- `fontdb/fallback.rs`, `fontdb/fallback_data.rs`: the searches and `fallback_order` take the scope; both caches key on it.
- `fontdb/lookup.rs` (`is_loaded`): a family name in any of the name table's languages counts, so the missing-family list
  drops 等线 once DengXian loads.
- `fontdb/changes.rs`: `script_of` for the scope, `queue_script`. `word.rs`: `resolve` notes the family for the scope.

engine (doc-edit):
- `doc_state.rs`, `session/history.rs`: each undo step has an id from one counter for the process, kept when it moves
  between the undo and redo stacks; `top_step_ids`. Typing that joins the open step keeps its id.
- `session/lifecycle.rs`: `Session::with_registry` is public, so the worker builds the command registry once.
- `cmd/paste.rs`: `adopt` is public, so one session's copy pastes into another with its pictures, lists and styles.

## A smaller .wasm (engine-size, P15)

docs/plans/engine/viewport-design.md section 11; the numbers are in docs/plans/word/bench.log.

- `crates/fonts/src/fontdb/face.rs`: `BUNDLED` is empty on wasm32. The .wasm leaves the 13 font files (4.3 MB) out, and the
  worker adds the same files, in the same order, from beside it before its first call (src/engine/fonts/bundled.mjs).
  `names.rs`: `last_resort_face` says so when a host added none, instead of indexing an empty list.
- `crates/proof/src/hyphen.rs`: the hyphenation data (the English word list and five pattern files, 0.93 MB) is read through
  `data(name)`: compiled in natively, handed over at run time on wasm32 (`provide`). A lookup that lacks a file notes it once
  (`take_wanted`) and falls back to the heuristic; `provide` bumps the dictionary generation, so cached layouts made without it
  are dropped. `lib.rs`: the generation's comment says so.
- `ew/src/lib.rs`: `takeWantedData` and `addData`, the whole worker's like `addFont`, and `dataChanged` on a session (the worker
  fetches the files from wasm/data/, then lays out every session again).
- The cuts of viewport-design.md section 9.2 leave the wasm32 build only (cfg), so the native build keeps them: in doc-edit,
  `recovery` with `file.recover`, `file_access` (two checks that pass on wasm32), `keymap` with `tools.customizeKeyboard` and
  `ribbon` with `tools.customizeRibbon` (and the session fields they fill); in fonts, `ui_fallback` and the `face_names`
  re-export it used.
- `Cargo.toml`: the release profile is fat LTO with one codegen unit (was thin and 16). `.cargo/config.toml` (new): `+simd128`
  for wasm32.

## The crates' tests pass on Windows, under load too (engine-green)

`cargo test --workspace` passes on Windows with a release build running beside it. For each test, the side that was wrong:

- fonts, `fontdb/fallback.rs` (engine): `load_rtl_preferred` and the run search's system fallback (`search_run`) hold the
  `searching` lock as `system_search` does. A search that met the preferred right-to-left family marked tried by another
  search still loading it (Segoe UI) went on to a family further down the list that a document had loaded (Tahoma), so text
  laid out beside that load fell back to another face than the same text after it. This was why pdf's
  `right_to_left_glyphs_stay_where_layout_put_them` failed under load: the export's layout and the test's own fell either
  side of another test's font load (different line heights, one glyph more). Test
  `concurrent_right_to_left_fallbacks_wait_for_the_preferred_family`. `load_rtl_preferred` returns before the lock when the first
  installed family is already loaded and covers the text, so only cache misses wait.
- layout, `floats.rs` (engine): `place_objects` works out the left-out objects (a walk of the paragraph's text) only once a
  line of the piece holds an object. Every page of a long paragraph with a floating object walked the whole paragraph, so a
  megabyte-long word beside a float grew about 3.2 times per doubling (1 s for a megabyte, 0.24 s now).
- layout tests: `a_megabyte_long_word_lays_out_quickly` measures the growth from an eighth of a megabyte (`layout_time_ratio`)
  instead of a 15 s clock bound. `justified_lines` lays out in the bundled Source Sans 3: with the installed Aptos on Windows
  mode 15 fitted no more lines than mode 14 in `justified_lines_shrink_spaces_in_word_2013_mode` (35 and 35), where a
  stand-in did.
- pdf tests: `internal_links_export_in_linear_time` uses `cost_ratio` (8x the paragraphs, runs alternating, the small
  document exported 8 times a run) instead of three runs of each size in a row.
- proof, `hunspell.rs` (engine): `read_capped` refuses a path that is not a regular file before opening it: Windows will not
  open a directory as a file (the test's "not a regular file" check got "Access is denied"), opening a Unix pipe with no
  writer never returns, and on Windows `NUL`, `CON`, `\\.\pipe\name`, `\\?\` paths to anything but a drive, a volume (`\\?\Volume{guid}\`) or a share, and
  `\\host\pipe\name` open as files and report themselves as files (`device_path`, through `std::path::absolute`, which
  resolves device names as the system does). The test checks those paths on Windows.
- proof tests: `es::grammar` `many_addresses_before_a_question_are_checked_quickly` measures the growth from an eighth of the
  text with `hyphen::tests::cost_ratio` (now `pub(crate)`) instead of a 75 ms clock bound. `user_dictionary_persists_through_a_file`
  saves the whole process-wide user dictionary and loads it back, so it brought back a word
  `user_dictionary_and_ignore_all_match_both_normalization_forms` had just removed (that test failed under load): it now holds
  `DICTIONARY_TESTS` too.
- doc-edit tests: `copies_with_byte_arrays_written_before_still_restore` expected bare base64 for a picture, which the data URL
  change above replaced. Recovery copies hold any of the three forms (number arrays, bare base64 from WordCraft, data URLs
  now) and the reader (`byte_store`) takes all three: the test now expects the data URL and restores a copy in each older
  form.

## One round of fonts for a missing Chinese font (engine-cases)

- fonts, `word.rs` (EasyWriter): `want(family)` reports a family to the app as missing, as `resolve` does, without making it
  one the document asked for (no paragraph depends on it and it does not join the document's fallback scope).
- layout, `para/builder.rs` (engine-fidelity-2's `chinese_fallback`): Microsoft YaHei is looked up only once the run's
  Simplified Chinese East Asian font (DengXian, 等线) is loaded, so a document that needed both fetched DengXian, laid out,
  reported YaHei, fetched it and laid the whole document out again after the font provider's `ready()` had resolved. While
  that font is missing and named as one of Windows' GB2312 fonts (`simplified_chinese`, a name list), the run reports YaHei
  with it through `want`, so the first report names both. A GB2312 font not on the list still gets YaHei a round later.

## engine-fidelity-3: the fixture pages no package had looked at

docs/plans/engine/fidelity.md (its engine-fidelity-3 section has Word's measurements and the probes).

- `crates/docx/src/read/props.rs`: `text_frame` takes the style's frame as a base; `story/blocks.rs` merges a paragraph's own
  `w:framePr` with its style's one attribute at a time, and keeps the text paragraph's mark when a drop-cap frame paragraph
  merges into it (the mark was the letter's, 64.5 pt and lowered).
- `crates/doc/src/props/para_props.rs`: `ParaProps::collapsed` (`w15:collapsed`, Collapsed by default), read and written after
  the outline level. `styles.rs`: `PartFormat::margins` (`w:tcMar` in a `w:tblStylePr`), read, written, merged and kept for
  every part.
- `crates/doc-layout`: `LayoutOptions::expanded` and `outline::folded` (a page view leaves out what is under a heading collapsed
  by default unless it is expanded; `None` folds nothing); `place_block` skips folded blocks and counts their list numbers.
  `para/paragraph.rs`: a drop-cap letter larger than its text keeps its size and drops its lowering. `para/lines.rs`: a drop
  cap that leaves under 18 pt beside it puts the text below its lines; an EQ field's room comes out of At least spacing's slack.
  `table.rs`: `region_margins` gives cells their table style parts' margins (layout, AutoFit measuring, `cell_margins`).
- `crates/doc-edit/src/session/layout.rs` (outside this package's paths): `expanded: None` in the view's options.
- Review fixes (the pictures, Word 367 to 401, and the probes engine-fidelity-2 left): `para/lines.rs`: a line of only
  pictures ends at the pictures' foot (`text_desc` 0), so only the picture has to fit above the bottom margin; from
  compatibility mode 15 only the text's height (not Multiple spacing's leading) keeps out of a top-and-bottom object; the
  empty last line after a line break keeps out of floating objects. `flow.rs`: in compatibility mode 15 a paragraph whose
  wrapped picture, placed from it or its line, runs past the bottom margin starts the next page (`float_past_bottom`).
  `doc/src/para/float.rs`: `Float::rel_w` and `rel_h` (`wp14:sizeRelH`, `wp14:sizeRelV`), read and written by the docx crate
  (`drawing_close` writes them before closing every anchor); `floats.rs` sizes the relative side from the page area and draws
  a picture at its proportions in the frame's top left. `boxes.rs`: a thin-thick large gap is the width between a 1.5 pt and
  a 0.75 pt line. `para/barcode.rs`: EAN and UPC `\t` digits one by one under their symbol characters, UPC's first and last
  outside the guards (`Barcode::caption` is a list of pieces). `outline.rs`: Collapsed by default set in a style folds.

## Every typing key on the bounded edit path (engine-keys)

engine-edit-path's light edit becomes the bounded edit of every typing key. crates/wasm/tests/edit_path.rs runs the random
edits of engine-edit-path with more keys (AutoCorrect triggers, list labels, border lines, Enter, Backspace and Delete at
characters and paragraph ends, selections deleted or typed over) on small documents that also hold a numbered list, a
section break, a bookmark and a control over two paragraphs, every other one with Enter's heading AutoFormat on, and on the
Word fixture, comparing the document and the undo and redo steps with the whole-document path after every command.

- doc-edit, `session/edit_path.rs`: `Session::light_range` names the blocks of one container (a story or a table cell) a key
  can change: `text.insert` without a paragraph break (AutoCorrect and AutoFormat included, but not a space at a paragraph's
  first three bytes, where a list label adds a list to the numbering), `text.newParagraph` (with the paragraph before where
  its AutoFormat may make that a heading or give it a border), and `text.backspace` and
  `text.delete` of plain text or of a paragraph mark between two paragraphs, at a caret or over a selection in one
  container, a new typing step's first letter included. A deletion holding an object (U+FFFC: a picture, a note
  reference, a field, a text box anchor, a bookmark or comment mark) or a section break on a mark that goes, a join with a
  table, and Backspace at a paragraph's start with a left indent take the whole-document path. `Light` keeps those blocks,
  the container's length and the undo stacks; a failed key splices the blocks back and a key that changed nothing puts the
  stacks back. A bounded edit runs only in a document a command left tidy at its revision (`EditPath::tidy`), so it never
  runs `ensure_nonempty` or `prune_text_boxes`. The content control index (`Reach`) holds the top-level blocks with a
  marker or wrap and each control's span; a key inside a span is bounded when every control spanning it is editable, takes
  typing, shows no placeholder and takes paragraph breaks (the handlers then do what they do with no control). It follows
  the top-level blocks a bounded edit adds or removes (`Reach::moved`), and what the index or the tidy mark learned at a
  revision that a failed or empty command put back is dropped (`edit_path_back_to`).
- doc-edit, `session/run.rs`: the record above in place of the paragraph; the no-op check compares the range, and the word
  being typed is found in the range as it was (`Light::old_para`).
- doc-edit, `cmd/controls.rs`: `check_delete` and `restore_placeholder` take the bounded edit's knowledge too, as
  `prepare_edit` and `refuses_paragraph` did.
- doc, `edit.rs`: `delete_range` looks the following section up only when a section break went with the deletion; the
  lookup walks the body and copied the break's paragraph, which made a far block look changed to the incremental layout.
- doc-layout, `pass.rs`: after an edit that adds or removes body blocks, the line index moves the kept pages' entries
  (`shift_index`) instead of being built again from every page (Enter at 30 % of the fixture: 10 to 14 ms of layout natively
  before, 5 to 7 ms after).
- wasm, `lib.rs`: a composition that began over a selection keeps the id of the undo step it opened, so cancelling it
  drops that step and the selection comes back, as in Word.
- Not done: Enter and a join still move every later page's items, marks and line index entries by one block (the
  layout's paths hold absolute block numbers), 2 to 6 ms more than a letter in the worker at pages 1 to 300 of the
  fixture; a key in a table cell lays the whole table out again; the first key of a new undo step (a new typing step, and
  every Enter, Backspace and Delete, each its own step) copies the document's fields for the step, 0.5 to 1 ms in the
  worker.

## Layout in slices (engine-open)

A layout from the start lays out the view's pages and pauses; the rest follows a slice at a time, and the settled layout is
the whole one (ew/tests/open.rs checks it against whole layouts on small documents and on the Word fixture, with random
edits made while the rest is laid out).

- `crates/doc-layout/src/pass.rs`: `layout_pass` became `walk_pass`, which begins at the start, where a paused pass stopped
  (its last mark, as `relayout` resumes from one), or from a paused pass's mark before an edit; `Track` may stop at a mark
  (`Stop`: more than so many pages, and a time), not inside a section balancing its last page. `Passes` is `layout`'s loop
  (page totals, floats above anchors, footnotes numbered on each page) as a value, so a paused pass and the passes after it
  go on later. `Edit::of` and `resume_mark` take the document and marks they compare with instead of a `Resume`.
- `crates/doc-layout/src/pass/progress.rs` (EasyWriter's): `start` and `advance`, the pages shown while a pass is under way
  (copies of its finished pages with headers, footers and mirrored margins), and an edit made meanwhile.
- `crates/doc-layout/src/lib.rs`: `DocLayout::progress` and `settled()`, `advance`; `layout` lays out ahead when
  `LayoutCache::set_ahead` asked for it (`cache.rs`), else whole. `headers.rs`: `mirror_even_pages_after`.
- `crates/doc-edit/src/session/layout.rs`: `Session::set_layout_ahead` and `advance_layout` (`layout_with` takes the
  slice).
- `crates/wasm`: `setAhead`, `settle`, `settled`, and `settled` in `open`, `pages`, `surfaces` and the layout event; the
  font scope's late families wait until the layout is settled; `layoutDigest` settles first; `selectionEvent(from, to)`
  limits the highlight's rectangles to a view's pages; the slice that settles a layout always brings a layout event.

## engine-fidelity-4: linked pictures, paragraph frames, content controls and what engine-fidelity-3 measured

docs/plans/engine/fidelity.md (its engine-fidelity-4 section has Word's measurements; the probes are
`.smoke-data/word/fixture/walk/ef4_probes_docx.py`).

- `crates/doc/src/para/float.rs`: `Float::link`, the file a linked picture reads. `crates/docx`: `read/parts.rs` `link_for`;
  the VML (`r:href`, or an external `r:id`) and DrawingML (`r:link`) readers keep the link, and a picture linked only keeps
  its size with no data (`media` empty) where it was dropped; `write/story/drawing.rs` writes `r:link` beside `r:embed`, or
  alone. `crates/doc-layout/src/display/objects.rs`: a picture with no data draws Word's white box with a black outline.
- `crates/doc/src/para/inline_object.rs`: `set_size` clears `rel_w` and `rel_h`, so a resized picture sized relative to the
  page gets an absolute size, as in Word. `crates/doc-edit/src/cmd/objects/arrange.rs`: a dropped object is placed on the
  page only when its paragraph would start the next page by `float_past_bottom`'s own condition (`jumps_to_next_page`), not
  whenever its laid-out place differs from the drop.
- `crates/doc-layout/src/flow.rs`: `place_frame` places framed paragraphs in the body flow (no room in the flow, the text after
  wrapping round the box, spacing and borders inside its height, consecutive paragraphs with the same frame in one frame, a
  frame placed from the text that runs past the page's text starting the next page); `page.rs` `PageBuilder::frame`.
  `crates/docx/src/read/props.rs`: a frame without `w:vAnchor` is placed from the margin, as Word places it.
- `crates/doc/src/control.rs` `ContentControl::shows_tags`; `crates/doc-layout/src/para.rs` (`TAG_ROOM`, `tag_width`),
  `para/paragraph.rs` (`tag`, `glue_tags`), `para/lines.rs` and `display/lines.rs` (`control_tag`): Start/End Tag takes
  Word's width and line room and draws its chips; no line breaks between a tag and its text.
- `crates/doc-layout/src/para/builder.rs`: `shape_atomic_pieces` keeps each piece of an object's text in its own face (a
  fallback face's glyphs were drawn with the first face) and lets a FORMTEXT result break at its spaces;
  `para/paragraph.rs` `mark_break_opportunities` never breaks between pieces of one object unless the builder allows it.
- `crates/doc-layout/src/boxes.rs` `three_d_shades`: Word's light, middle and dark shades of coloured 3-D borders.
  `display/lines.rs` `emphasis_glyphs`: the comma and dot emphasis marks as Word's glyphs. `para/symbol.rs`: SYMBOL `\j`
  through encoding_rs's Shift_JIS table (the crate now depends on encoding_rs, which the WebAssembly build linked already).
- `crates/doc-layout/tests/fixture_pages.rs`: a framed paragraph's text comes last on its page, as in Word's PDF.
- Outside this package's paths: `crates/pdf/src/export.rs` and `crates/doc-edit/src/io_ext.rs` pass `expanded: Some(empty)`,
  so the engine's PDF leaves out what is under a heading collapsed by default, as Word's does (its page count follows too).

## The stage-2 scaffold (engine-cmd-scaffold)

docs/plans/engine/stage2.md, "Stage 2.0 scaffold": what the five command packages share, so none edits a shared file.

- doc-edit, `lib.rs`: `CommandSpec.state` (`(checked, value)` read without running the command) and its `.state()` builder.
- doc-edit, `cmd/context.rs` (new): `document.context {pos?}` (what the selection is in: story, cell, object, equation,
  field, content control, comments, revision, link, heading, note, list) and `document.settings` (the Settings without the
  password hash), both pure with a `state`. The state reading looks for fields and controls in the caret's paragraph only
  (0.3 ms a call on the 900-page fixture instead of 5 to 6 ms); the command looks through the story.
- doc-edit, `session/run.rs`: `run_many`, several commands as one undo step; a failing step takes the others back.
- doc-edit, `cmd/objects/specs.rs` split into each file's `specs()`; the `hf.*`, `layout.linkToPrevious`, `table.cellMargins`,
  `table.borderPainter` and `design.effects` specs moved from `cmd/tools/specs.rs` to `cmd/page.rs`, the `select.*` ones to
  `cmd/caret.rs` and the numbering ones to `cmd/lists.rs` (`more_specs`, registered where they were). No behaviour change.
- doc-edit, `cmd/objects/picture.rs`: `picture.data` gives the selected picture's MIME type and base64.
- doc-edit, `view.rs`, and doc-layout, `display/options.rs`: the paint flags `field_shading`, `xml_tags`, `show_bookmarks`,
  `crop_marks`, `text_boundaries`, `edit_regions` (off) and `show_document_text` (on, as today); nothing paints them yet.
- wasm, `lib.rs`: `state` answers from a spec's `state` before its own table; `execMany(steps)`; `query(id, args)` runs a
  pure command only; `save` writes `txt` and `html`.

## engine-pictures-2: SVG pictures stay vector, picture adjustments are settings, exports keep pictures

- scene, `svg.rs` (new): an SVG read into the metafile crate's `Picture` (paths, rects, circles, ellipses, lines, polylines,
  polygons and text in groups with transforms, `use`, a `<style>` sheet of element, class and id rules, the root's viewBox),
  so `media.rs` (`vector_for`, `metafile_size`, `vector_picture`) and the PDF writer draw it as they draw EMF and WMF;
  `svg_png` (the PNG copy Word keeps beside an SVG) and `svg_shapes` (Convert to Shape). No SVG crate: the subset Word's SVG
  pictures and icons use, on kurbo's path parser.
- doc, `adjust.rs` (new) and `para/float.rs` (`adjust`, `layer`, `fallback`): a picture's Recolor, Washout, a:lum,
  Transparency and Set Transparent Color are settings the painter draws (scene `Effect::Adjust`, `picture_look` now takes the
  picture's `Float`); Word 2010's corrections, saturation, tone and artistic effects are drawn into a copy of the original
  (`Float::layer`) at each change, as Word keeps them (a Word probe: Word itself draws `a14:imgEffect` from the blip's pixels).
- docx: `asvg:svgBlip` read and written with its PNG copy; `a:blip`'s effects and `a14:imgProps` read and written; `.wdp`
  (`image/vnd.ms-photo`) kept.
- doc-edit, `cmd/objects/picture.rs`: picture.corrections, picture.color, picture.transparency, picture.transparentColor and
  picture.effects set the settings; picture.reset takes them off; picture.data gives the picture as shown (`stored` as
  stored); picture.change takes an SVG; `drawings_as_pictures` for the HTML export (`io_ext.rs`); `picture_look.rs`:
  `graphic.convertToShape`.
- Outside these paths: doc-layout `display/objects.rs` and `display/page.rs` pass the `Float` to `picture_look`;
  doc-edit `cmd/objects.rs` (re-exports), `cmd/insert/objects.rs` (an inserted SVG's PNG copy) and `io_ext.rs` (HTML).

## Several selections at once (engine-multi-select, stage2.md G22)

- doc-edit, `cmd/multi.rs` (new): `Session::multi` (`doc_state.rs` `Multi`) holds the ranges besides the active one, which
  stays in `Session::sel`, tagged with it so any command that moves the selection drops them. `select.add`, `select.ranges`,
  `select.list` and `select.style` (Select All n Instances); a `keep` param on `select.*` and `caret.*` moves the active range
  and keeps the others (a Ctrl gesture's later calls). The dispatch in front of the column block's: formatting goes to every
  range (`format.rs` `apply` and `resolved`, `cmd.rs` `selected_paths`), Change Case and Clear Formatting run per range,
  Copy and Cut take every range in the order selected, Delete and Backspace remove every range, any other edit acts on the
  active range alone.
- doc-edit, `session/`: the ranges ride in undo steps and a failed command's snapshot, are clamped with the selection, end on
  a document or window switch, and keep typing off the bounded edit path. `select.similar` and `edit.advancedFind` with
  `select` make several ranges.
- wasm, `lib.rs` and `input.rs`: `selection()` gives `ranges` and `set` with several ranges, and the selection event draws
  every range (`ranges`, the count).
