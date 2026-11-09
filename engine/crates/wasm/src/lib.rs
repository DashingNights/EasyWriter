//! EasyWriter's document engine: the editing session adapted from WordCraft (`ew_doc_edit::Session`) behind the worker API of
//! docs/plans/engine/plan.md section 3. Every call wraps the session, its command registry or its layout; nothing here edits
//! the document by itself. Positions cross as EasyWriter's own `Pos` in JSON, which the main thread treats as opaque. Lengths
//! are points, page indexes 0-based. Structured results go out as JSON strings: the worker parses them.
//!
//! One `Engine` is one open draft (viewport-design.md section 8, P4): the worker holds one per draft, all sharing the font
//! database, the caches and one command registry. Each call enters the session's font scope first, so a character its fonts
//! lack falls back the same way whatever the other sessions loaded (fonts crate, fontdb/scope.rs).
// ponytail: the class keeps the name `Engine` that the stage-1 tests construct; the identifier rename (P7) can call it Session.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use ew_doc_edit::doc::{Change, Pos};
use ew_doc_edit::layout::{DocLayout, Placed};
use ew_doc_edit::{Registry, Selection, Session};

mod a11y;
mod board;
mod input;
mod save;
#[cfg(feature = "measure")]
pub mod measure;
mod tiles;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// A painted page: straight (not premultiplied) RGBA rows, as ImageData takes them.
#[wasm_bindgen(getter_with_clone)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// A PDF and the font families it draws as outlines, whose text is not selectable (a JSON list), with one line for each
/// face drawn as outlines saying which face and why (a JSON list).
#[wasm_bindgen(getter_with_clone)]
pub struct Pdf {
    pub bytes: Vec<u8>,
    pub outlined: String,
    pub why: String,
}

#[wasm_bindgen]
pub struct Engine {
    /// This session's key in the worker's display-list cache (tiles.rs).
    id: u64,
    s: Session,
    /// This session's font scope (fonts crate, fontdb/scope.rs).
    scope: u64,
    version: u32,
    /// The pages laid out again since the last `layout` event, if any.
    pending: Option<std::ops::Range<usize>>,
    /// The input method's composition: the range its text occupies in the document.
    comp: Option<(Pos, Pos)>,
    /// The undo step the composition opened, when it started at a caret: a cancelled one takes it back.
    comp_step: Option<u64>,
    /// The engine form as last saved, by block (save.rs).
    saved: save::SaveCache,
    /// The undo history as the last record save found it, for `saveHistory` (engine-undo-file).
    history: ew_doc_edit::HistoryWriter,
    /// The pages' sizes and keys and their JSON, kept while they stay the same (a typed letter changes none).
    sizes: (Vec<(f32, f32, usize, String)>, String),
    /// The sizes and keys of the last settled layout of this document (`page_sizes`).
    settled_sizes: Vec<(f32, f32, usize, String)>,
    /// Paragraph id → its story and path as the layout names it (a body path's first index is its block's id), for `posAt`.
    paths: std::collections::HashMap<u32, (ew_doc_edit::doc::StoryRef, ew_doc_edit::doc::Path)>,
    /// Forced colours' (text, paper), which the tiles paint in while set (tiles.rs `setColors`).
    forced: Option<(ew_doc_edit::doc::Rgb, ew_doc_edit::doc::Rgb)>,
    /// The view's paint (tiles.rs `paint_key`) the tiles were last painted with: a page colour or theme change repaints
    /// them all.
    painted: (Option<ew_doc_edit::doc::Rgb>, bool, bool),
    /// An engine form being opened in steps (`openBegin`, engine-open-parse).
    opening: Option<ew_doc_edit::FormSteps>,
    /// The surfaces the views show now (tiles.rs `setView`): a layout event works out damage for those only.
    view: Option<std::ops::Range<usize>>,
    /// This session paints a whiteboard: each surface is an item's stamp (board.rs `boardInit`), not a page.
    board: Option<ew_board::Board>,
    /// This session edits one board item's text (board.rs `itemView`): its tiles have no paper, so the text shows over the board.
    item: bool,
}

/// The most bytes a saved undo history's steps take without their pictures (engine-undo-file): the oldest undo steps go first.
/// Measured on the Word fixture (docs/plans/engine/bench.log, engine-undo-file): a Select All and a format change, then 50 typed
/// steps.
const HISTORY_CAP: usize = 8 << 20;

/// The hash of the sources this build came from, which scripts/build-engine-wasm.mjs passes to cargo; empty for a build made
/// without it. The worker refuses a .wasm whose stamp is not the one in STAMP beside it, so a stale or foreign build cannot
/// run unnoticed.
#[wasm_bindgen(js_name = buildStamp)]
pub fn build_stamp() -> String {
    option_env!("EW_BUILD_STAMP").unwrap_or_default().into()
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn pos(s: &str) -> Result<Pos, JsError> {
    serde_json::from_str(s).map_err(|e| err(format!("not a position: {e}")))
}

thread_local! {
    /// The command registry (648 entries), built once for every session of the worker.
    static REGISTRY: Arc<Registry> = Arc::new(ew_doc_edit::cmd::registry());
}

/// Adds a font file (TTF, OTF or TTC) to the worker's font database: the number of faces added. The worker then calls
/// `fontsChanged` on every session, which lays out again only the paragraphs set in the new families or falling back.
#[wasm_bindgen(js_name = addFont)]
pub fn add_font(bytes: Vec<u8>) -> usize {
    ew_fonts::FontDb::global().add_font(bytes)
}

/// The data files layout asked for and lacked since the last call (hyphenation patterns and the English word list, which the
/// .wasm leaves out), as a JSON list of names, each once, else undefined. The worker fetches them from beside the .wasm.
#[wasm_bindgen(js_name = takeWantedData)]
pub fn take_wanted_data() -> Option<String> {
    let names = ew_doc_edit::proof::hyphen::take_wanted();
    (!names.is_empty()).then(|| json!(names).to_string())
}

/// Hands the worker data file `name` that takeWantedData asked for: whether it was taken. The data is the whole worker's, so
/// the worker then calls `dataChanged` on every session.
#[wasm_bindgen(js_name = addData)]
pub fn add_data(name: &str, bytes: Vec<u8>) -> bool {
    ew_doc_edit::proof::hyphen::provide(name, bytes)
}

/// The app's version (package.json's), which the files the engine writes carry in their generator, producer or application
/// field beside the name EasyWriter. The worker sets it once, before the first session.
#[wasm_bindgen(js_name = setAppVersion)]
pub fn set_app_version(version: &str) {
    ew_doc_edit::doc::app::set_version(version);
}

/// The app's fallback fonts per script, `{code: [family]}` (its font provider's list, first available wins): a session
/// whose own fonts lack a script's characters falls back to the first of them that is loaded, and to no font another
/// session loaded for itself.
#[wasm_bindgen(js_name = setScriptFonts)]
pub fn set_script_fonts(lists: &str) -> Result<(), JsError> {
    let v: std::collections::BTreeMap<String, Vec<String>> = serde_json::from_str(lists).map_err(err)?;
    ew_fonts::set_script_fonts(v.into_iter().collect());
    Ok(())
}

/// `bytes` of `kind` ('docx' or 'doc') as the engine form, read and not laid out: the helper worker's half of an open
/// (viewport-design.md section 8), whose bytes the main worker then opens as 'engine'. The main worker's open gives the ids.
#[wasm_bindgen(js_name = engineForm)]
pub fn engine_form(bytes: &[u8], kind: &str) -> Result<Vec<u8>, JsError> {
    let mut doc = ew_doc_edit::io::open_bytes(file_name(kind)?, bytes).map_err(err)?;
    save::SaveCache::default().save(&mut doc).map_err(err)
}

/// engine-canvas-read (stage2b.md R12, R13, R16): engine form `bytes` (a canvas record's model) as `kind`, read and not laid out:
/// the helper worker's `convert`, so code that needs a draft that is not open (Compare, Version History, mail merge) reads it.
#[wasm_bindgen]
pub fn convert(bytes: &[u8], kind: &str) -> Result<Vec<u8>, JsError> {
    let doc = open_model(bytes)?;
    ew_doc_edit::io::save_bytes(file_name(kind)?, &doc).map_err(err)
}

/// Panics, which traps the WebAssembly instance and ends every session in it: the host's crash restart is tested with it.
#[wasm_bindgen(js_name = forcePanic)]
#[allow(clippy::panic)]
pub fn force_panic() {
    panic!("the engine was stopped on purpose (forcePanic)");
}

#[wasm_bindgen]
impl Engine {
    /// A session on a blank document.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        std::panic::set_hook(Box::new(|info| console_error(&info.to_string())));
        let scope = NEXT.fetch_add(1, Ordering::Relaxed);
        ew_fonts::enter_font_scope(scope);
        let registry = REGISTRY.with(Arc::clone);
        let mut s = Session::with_registry(ew_doc_edit::blank_document(&Default::default()), registry);
        // Spelling marks come from the platform's checker through the overlay (plan section 1), not the engine's own.
        s.view.proofing = false;
        s.reset_ids();
        Engine {
            id: tiles::next_id(),
            s,
            scope,
            version: 0,
            pending: None,
            comp: None,
            comp_step: None,
            saved: Default::default(),
            history: Default::default(),
            sizes: (Vec::new(), "[]".into()),
            settled_sizes: Vec::new(),
            paths: Default::default(),
            forced: None,
            painted: (None, false, false),
            opening: None,
            view: None,
            board: None,
            item: false,
        }
    }

    /// Data files were added to the worker (`addData`): this session lays out again with them.
    #[wasm_bindgen(js_name = dataChanged)]
    pub fn data_changed(&mut self) {
        self.enter();
        self.s.relayout();
    }

    /// Fonts were added to the worker (by any session): this session lays out again the paragraphs they change.
    #[wasm_bindgen(js_name = fontsChanged)]
    pub fn fonts_changed(&mut self) {
        self.enter();
        self.s.fonts_changed();
    }

    /// Pastes what session `source` copied last (its `edit.copy` or `edit.cut`) at this session's selection, as a paste
    /// in the draft it came from would: tables, pictures and formatting arrive as they were, with nothing lost to HTML.
    /// The exec result.
    #[wasm_bindgen(js_name = pasteFrom)]
    pub fn paste_from(&mut self, source: &Engine) -> String {
        self.enter();
        self.comp = None;
        let Some(frag) = source.s.clipboard.clone() else {
            return json!({"ok": false, "changed": false, "error": "nothing copied"}).to_string();
        };
        // The copy names the source document's pictures, lists and styles: EasyWriter's paste of another document brings them
        // over, renumbered. ponytail: they come over before the paste's undo step, so an undone paste leaves them unused.
        let mut src = source.s.doc.clone();
        src.body = frag.blocks.into_iter().map(Arc::new).collect();
        src.parts = frag.parts;
        self.s.clipboard = Some(ew_doc_edit::cmd::paste::adopt(&mut self.s, src));
        self.s.clipboard_text = source.s.clipboard_text.clone();
        self.s.clipboard_html = source.s.clipboard_html.clone();
        self.run("edit.paste", &json!({}))
    }

    /// `[{w, h, layout, display}]`: per page its size and hashes of its laid-out items and of what it draws (the display
    /// list), as text with fonts by name, so two sessions laying out the same document compare equal whatever order their
    /// fonts loaded in. The whole layout: one still being made is settled first.
    #[wasm_bindgen(js_name = layoutDigest)]
    pub fn layout_digest(&mut self) -> String {
        self.settle_all();
        let l = self.laid_out();
        let opts = ew_doc_edit::layout::display::DisplayOptions::default();
        let pages: Vec<Value> = l
            .pages
            .iter()
            .map(|p| {
                let display = ew_doc_edit::layout::display::page_display(&self.s.doc, p, &opts);
                json!({"w": p.w, "h": p.h, "layout": fnv(&format!("{:?}", p.items)), "display": fnv(&format!("{display:?}"))})
            })
            .collect();
        Value::Array(pages).to_string()
    }

    /// Opens `bytes` of `kind` ('docx', 'doc' or 'engine', the engine's own JSON form) with an empty undo history and lays
    /// it out: `{pages, settled}`. After `setAhead` only the first pages are laid out (`settled` false) and `settle` lays out
    /// the rest. An 'engine' model is brought to the current schema version; one of another kind or a newer version is refused
    /// with the reason (docs/plans/engine/viewport-design.md section 10).
    pub fn open(&mut self, bytes: &[u8], kind: &str) -> Result<String, JsError> {
        self.enter();
        let doc = match kind {
            "engine" => open_model(bytes)?,
            _ => ew_doc_edit::io::open_bytes(file_name(kind)?, bytes).map_err(err)?,
        };
        Ok(self.open_document(doc))
    }

    /// engine-open-parse: `open(bytes, 'engine')` in steps, so the worker answers its other drafts' calls between them. This
    /// notes the form; `openStep` reads its body from the start for about `ms` milliseconds a call (at least a block), then the
    /// rest, and says whether all is read; `openEnd` opens what was read as `open` does, or fails with `open`'s error. Until
    /// then the session keeps the document it had.
    #[wasm_bindgen(js_name = openBegin)]
    pub fn open_begin(&mut self, bytes: Vec<u8>) {
        self.opening = Some(ew_doc_edit::FormSteps::new(bytes));
    }

    #[wasm_bindgen(js_name = openStep)]
    pub fn open_step(&mut self, ms: f64) -> bool {
        let end = ew_doc_edit::layout::now_ms() + ms;
        self.opening.as_mut().is_none_or(|o| o.step(&mut || ew_doc_edit::layout::now_ms() < end))
    }

    #[wasm_bindgen(js_name = openEnd)]
    pub fn open_end(&mut self) -> Result<String, JsError> {
        self.enter();
        let mut steps = self.opening.take().ok_or_else(|| err("no open in steps"))?;
        let read = ew_doc_edit::io::open_form(&mut steps);
        let mut doc = read.map_err(|e| err(ew_doc_edit::doc::refusal(steps.bytes()).unwrap_or(e)))?;
        doc.upgrade().map_err(err)?;
        Ok(self.open_document(doc))
    }

    /// engine-open (viewport-design.md section 8): a layout from the start (an open, new fonts, an edit that lays everything
    /// out again) lays out about `pages` pages from the document's start, the view's, and the rest waits for `settle`;
    /// undefined lays the whole document out at once, as a new session does.
    #[wasm_bindgen(js_name = setAhead)]
    pub fn set_ahead(&mut self, pages: Option<usize>) {
        self.s.set_layout_ahead(pages);
    }

    /// Lays out more of a layout still being made, for about `ms` milliseconds (at least a block: a slice may end between the
    /// blocks of a page, engine-repaginate-2), from where it paused:
    /// whether it is settled now. The `layout` event after it names the pages added, and once it settles any the finished
    /// layout draws differently (page totals in headers, say). The slice that settles it always brings a layout event, with
    /// no pages in it when that slice changed none, so a view hears `settled`.
    pub fn settle(&mut self, ms: f64) -> bool {
        self.enter();
        let was = self.settled();
        drop(self.s.advance_layout(ms));
        self.sync();
        let done = self.settled();
        if done && !was && self.pending.is_none() {
            self.pending = Some(usize::MAX..usize::MAX);
        }
        done
    }

    /// engine-repaginate-2: paragraph layouts looked up so far (found in the cache or made), so the worker's marks can count
    /// the layout a slice did.
    #[wasm_bindgen(js_name = paragraphLayouts)]
    pub fn paragraph_layouts(&self) -> f64 {
        self.s.paragraph_layouts() as f64
    }

    /// engine-layout-key: pages laid out so far, so the worker's marks can count the pages a key laid out before its reply.
    #[wasm_bindgen(js_name = pagesLaidOut)]
    pub fn pages_laid_out(&self) -> f64 {
        self.s.pages_laid_out() as f64
    }

    /// engine-keys-final: whether the next `settle` ends a layout pass or begins one (ew_doc_layout's `ends_pass_next`): an
    /// edit would undo that work, so the worker runs it once the typing pauses.
    #[wasm_bindgen(js_name = endsPassNext)]
    pub fn ends_pass_next(&self) -> bool {
        self.s.last_layout().is_some_and(|l| l.ends_pass_next())
    }

    /// Whether the whole document is laid out (see `setAhead`): until then `pages`, `surfaces` and the layout event list the
    /// pages done so far, then any the last settled layout had after them (`page_sizes`), and positions past the pages done
    /// have no caret or rectangles.
    pub fn settled(&mut self) -> bool {
        self.laid_out().settled()
    }

    /// The document's revision number, bumped by every change: the version `execAs`'s `if_rev` is checked against. A read-only
    /// getter that touches no typing, composition or undo state (docs/plans/engine/stage3-forum.md C5: a post's agent reads
    /// take it from here, `document.outline` giving a document's; a forum post's allow list does not grant that, and reading the
    /// rev through any command ends an IME composition and a typing run).
    pub fn rev(&self) -> f64 {
        self.s.rev() as f64
    }

    /// The document as `kind`: 'docx', 'engine', 'txt' or 'html' (EasyWriter writes no .doc). 'engine' is compact JSON, half the size of
    /// EasyWriter's pretty `.json` (docs/plans/engine/model.md), always at the current schema version (ew-doc's schema.rs).
    /// An autosave serialises only the body blocks that changed since the last save (save.rs).
    pub fn save(&mut self, kind: &str) -> Result<Vec<u8>, JsError> {
        self.enter();
        if kind == "engine" {
            return self.saved.save(&mut self.s.doc).map_err(err);
        }
        ew_doc_edit::io::save_bytes(file_name(kind)?, &self.s.doc).map_err(err)
    }

    /// Begins a save of the engine form in steps (save.rs): the worker runs `saveStep` between other calls, so a key never
    /// waits for a whole autosave, and takes the bytes with `saveEnd`. Edits made meanwhile go to the next save. `history`: the
    /// save is the draft's record, whose undo history `saveHistory` writes next, so the history is noted as this save finds it.
    #[wasm_bindgen(js_name = saveBegin)]
    pub fn save_begin(&mut self, history: Option<bool>) -> Result<(), JsError> {
        self.enter();
        if history == Some(true) {
            self.s.note_ids();
            self.history.snap(&self.s);
        }
        self.saved.begin(&mut self.s.doc).map_err(err)
    }

    /// engine-undo-file (docs/plans/engine/stage2b.md decision 3): the undo history as of the last engine save made with
    /// `history` (`saveBegin`), as the JSON of the draft's `<id>.history.json` for the record that save went into, stamped
    /// `stamp`. It keeps at most `limit` undo steps (the app's historyLimit), drops the oldest while the steps take more than
    /// HISTORY_CAP bytes without their pictures, and keeps every redo step → undefined when it keeps none (a limit of 0, no
    /// steps). Throws when no such save came since the last call: a history is never written for another record.
    #[wasm_bindgen(js_name = saveHistory)]
    pub fn save_history(&mut self, stamp: &str, limit: usize) -> Result<Option<Vec<u8>>, JsError> {
        self.enter();
        self.history.export(stamp, limit, HISTORY_CAP).map_err(err)
    }

    /// Takes undo history `bytes` (`saveHistory`'s JSON) for the document this session opened from the record stamped `stamp`
    /// → `{kept, steps}`, `steps` as `steps()` gives them. A history that does not match the document (its form, schema, stamp or
    /// block ids) is dropped without a word and the session keeps the history it had. A layout event follows, so the views hear
    /// the new top steps (Undo's state).
    #[wasm_bindgen(js_name = openHistory)]
    pub fn open_history(&mut self, bytes: &[u8], stamp: &str) -> String {
        self.enter();
        let kept = self.s.import_history(bytes, stamp);
        if kept && self.pending.is_none() {
            self.pending = Some(usize::MAX..usize::MAX);
        }
        format!(r#"{{"kept":{kept},"steps":{}}}"#, self.steps())
    }

    /// Adds about `budget` bytes of body blocks to the save in progress → whether it is complete.
    #[wasm_bindgen(js_name = saveStep)]
    pub fn save_step(&mut self, budget: usize) -> Result<bool, JsError> {
        self.saved.step(budget).map_err(err)
    }

    /// The save in progress's bytes, its remaining steps run now.
    #[wasm_bindgen(js_name = saveEnd)]
    pub fn save_end(&mut self) -> Result<Vec<u8>, JsError> {
        self.saved.finish().map_err(err)
    }

    /// The document as PDF; `options` is a print job as JSON (EasyWriter's `file.printPdf` parameters, `{}` for all pages).
    /// `print: true` makes it a print job's PDF, never saved, in which preview-and-print fonts embed (viewport-design.md
    /// section 8); any other PDF draws them as outlines.
    pub fn pdf(&self, options: &str) -> Result<Vec<u8>, JsError> {
        self.pdf_named(options).map(|p| p.bytes)
    }

    /// `pdf`, with the families it draws as outlines.
    #[wasm_bindgen(js_name = pdfNamed)]
    pub fn pdf_named(&self, options: &str) -> Result<Pdf, JsError> {
        self.enter();
        let v: Value = serde_json::from_str(options).map_err(err)?;
        let job = v.get("print").and_then(Value::as_bool).unwrap_or(false);
        let (pdf, _) = self.s.print_pdf_for(&v, job).map_err(err)?;
        Ok(Pdf { bytes: pdf.bytes, outlined: json!(pdf.outlined).to_string(), why: json!(pdf.why).to_string() })
    }

    /// `{version, pages: [{w, h, section, first}], settled}`: the pages laid out so far while not `settled`, each with its
    /// section key.
    pub fn pages(&mut self) -> String {
        self.enter();
        self.sync();
        let pages = self.page_sizes();
        let settled = self.settled();
        format!(r#"{{"version":{},"pages":{pages},"settled":{settled}}}"#, self.version)
    }

    /// The `layout` event's body `{version, from, to, count, pages, steps, changes, damage, settled}` when the layout changed
    /// since the last one, else undefined: pages `from` to `to` (not included) were laid out again; the others look as they
    /// did. `count` is the number of pages: while not `settled` (`setAhead`), those laid out so far and the last settled layout's after them. `steps` is `{undo, redo}`, the ids of the top undo and redo steps (null when there is none):
    /// typing that joins the open step keeps its id, so a host can tell whether a step is still the top one
    /// (viewport-design.md section 8). `changes` is `{inserted, removed, replaced}`, the stable ids of the blocks changed
    /// since the last event (section 10), or null. `damage` says which parts of those pages changed (tiles.rs `damage`).
    #[wasm_bindgen(js_name = takeLayout)]
    pub fn take_layout(&mut self) -> Option<String> {
        self.enter();
        self.sync();
        let changed = self.pending.take()?;
        let pages = self.page_sizes();
        let count = self.sizes.0.len();
        let to = changed.end.min(count);
        let from = changed.start.min(to);
        let steps = self.steps();
        let c = self.s.take_id_changes();
        let ids = |k| c.of(k).iter().map(u32::to_string).collect::<Vec<_>>();
        let changes = if c.is_empty() {
            Value::Null
        } else {
            json!({"inserted": ids(Change::Inserted), "removed": ids(Change::Removed), "replaced": ids(Change::Replaced)})
        };
        let damage = Value::Array(self.damage(from..to));
        let settled = self.settled();
        Some(format!(
            r#"{{"version":{},"from":{from},"to":{to},"count":{count},"pages":{pages},"steps":{steps},"changes":{changes},"damage":{damage},"settled":{settled}}}"#,
            self.version
        ))
    }

    /// `{undo, redo}`: the ids of the session's top undo and redo steps, or null.
    pub fn steps(&self) -> String {
        let (undo, redo) = self.s.top_step_ids();
        json!({"undo": undo, "redo": redo}).to_string()
    }

    /// Page `page` drawn at `scale` pixels a point (device pixel ratio times zoom).
    pub fn paint(&mut self, page: usize, scale: f32) -> Option<Raster> {
        let l = self.laid_out();
        let p = l.pages.get(page)?;
        let img = ew_doc_edit::layout::display::render_page(&self.s.doc, p, scale, &Default::default());
        Some(Raster { width: img.width, height: img.height, pixels: img.to_straight() })
    }

    /// `{pos}`: the position nearest to (x, y) on `page` in the story being edited, or null.
    pub fn hit(&mut self, page: usize, x: f32, y: f32) -> String {
        let story = self.s.story();
        json!({"pos": self.laid_out().hit(page, x, y, story)}).to_string()
    }

    /// `{page, x, y, h}` of the caret at `pos`, or null where it is not laid out.
    pub fn caret(&mut self, pos_json: &str) -> Result<String, JsError> {
        let p = pos(pos_json)?;
        let hint = self.s.page_hint;
        let c = self.laid_out().caret_on(&p, hint);
        Ok(c.map_or(Value::Null, |c| json!({"page": c.page, "x": c.x, "y": c.top, "h": c.height})).to_string())
    }

    /// `[{page, x, y, w, h}]`: the highlight of `anchor..head`.
    pub fn rects(&mut self, anchor: &str, head: &str) -> Result<String, JsError> {
        let (a, b) = (pos(anchor)?, pos(head)?);
        let (a, b) = if a <= b { (a, b) } else { (b, a) };
        let hint = self.s.page_hint;
        let rects = self.laid_out().selection_rects(&self.s.doc, &a, &b, hint);
        Ok(Value::Array(rects.iter().map(|(p, r)| json!({"page": p, "x": r.x, "y": r.y, "w": r.w, "h": r.h})).collect()).to_string())
    }

    /// `{pos, goalX}`: where the caret at `pos` goes one `unit` ('character', 'word', 'line', 'paragraph', 'page',
    /// 'document') in direction `dir` (-1 or 1), as Word's arrow keys move it (character and word follow the Left and Right
    /// keys, so they run visually in right-to-left text). `goal_x` is the x that up and down keep. The selection stays.
    #[wasm_bindgen(js_name = "move")]
    pub fn move_by(&mut self, pos_json: &str, unit: &str, dir: i32, goal_x: Option<f32>) -> Result<String, JsError> {
        let back = dir < 0;
        let id = match unit {
            "character" => if back { "caret.left" } else { "caret.right" },
            "word" => if back { "caret.wordLeft" } else { "caret.wordRight" },
            "line" => if back { "caret.up" } else { "caret.down" },
            "paragraph" => if back { "caret.paraUp" } else { "caret.paraDown" },
            "page" => if back { "caret.pageUp" } else { "caret.pageDown" },
            "document" => if back { "caret.docStart" } else { "caret.docEnd" },
            _ => return Err(err(format!("unknown unit `{unit}`"))),
        };
        self.enter();
        let p = pos(pos_json)?;
        let saved = (self.s.sel.clone(), self.s.goal_x, self.s.pending.clone(), self.s.page_hint, self.s.multi.take());
        self.s.sel = Selection::caret(p);
        self.s.goal_x = goal_x;
        let r = self.s.run(id, &json!({}));
        let out = json!({"pos": self.s.sel.focus, "goalX": self.s.goal_x}).to_string();
        (self.s.sel, self.s.goal_x, self.s.pending, self.s.page_hint, self.s.multi) = saved;
        r.map(|_| out).map_err(err)
    }

    pub fn select(&mut self, anchor: &str, head: &str) -> Result<(), JsError> {
        self.enter();
        self.comp = None;
        let v = json!({"anchor": pos(anchor)?, "focus": pos(head)?});
        self.s.run("select.range", &v).map(|_| ()).map_err(err)
    }

    /// `{anchor, head}`: the active range. With several ranges selected (a multiple selection, doc-edit's cmd/multi.rs) also
    /// `ranges`, how many, and `set`, which names the set of them, so a new set shows where the active range stays; the
    /// `select.list` command gives every range.
    pub fn selection(&self) -> String {
        let mut v = json!({"anchor": self.s.sel.anchor, "head": self.s.sel.focus});
        if let Some(m) = self.s.multi.as_ref().filter(|m| m.sel == self.s.sel) {
            v["ranges"] = json!(m.others.len() + 1);
            v["set"] = json!(m.id);
        }
        v.to_string()
    }

    /// The search Reading Highlight marks while it is on, empty while it is off: the worker keys its selection event on it
    /// too (the event's `found`). It stays out of `selection`, which tells a command that changed the selection from one that
    /// did not, so a command that changes only the find state still sends its `command` event.
    #[wasm_bindgen(js_name = findMark)]
    pub fn find_mark(&self) -> String {
        if !self.s.find.highlight {
            return String::new();
        }
        serde_json::to_string(&self.s.find).unwrap_or_default()
    }

    /// Runs command `id` of EasyWriter's registry with `args` (JSON): `{ok, changed, value}` or `{ok: false, error}`.
    /// `ui` lists what the command asked the front end to do (open a dialog, say), when it asked.
    pub fn exec(&mut self, id: &str, args: &str) -> String {
        self.enter();
        self.comp = None;
        match serde_json::from_str::<Value>(args) {
            Ok(v) => self.run(id, &v),
            Err(e) => json!({"ok": false, "changed": false, "error": e.to_string()}).to_string(),
        }
    }

    /// Runs the command steps `steps` (a JSON array of `[id, args?]`) as one undo step (a composite command), as `exec`
    /// reports one: `value` holds each step's value. A step that fails takes back the ones before it; `step` is its index.
    #[wasm_bindgen(js_name = execMany)]
    pub fn exec_many(&mut self, steps: &str) -> String {
        self.enter();
        self.comp = None;
        let Some(steps) = steps_of(steps) else {
            return json!({"ok": false, "changed": false, "error": "`steps` is an array of [id, args?]"}).to_string();
        };
        let rev = self.s.rev();
        let r = self.s.run_many(&steps);
        self.report(rev, r.map(Value::Array).map_err(|(i, e)| (Some(i), e)))
    }

    /// An assistant's edit (docs/plans/engine/stage2b.md decision 4): runs `steps` as `execMany` does, as one undo step, as
    /// tracked changes by `author` whose revisions carry `tag` (the suggestion group), with Track Changes on for this call
    /// only. The user's author, Track Changes setting and selection stay as they were, and a key typed while the call waited
    /// in the queue is the user's. `if_rev` refuses the call as stale when the document changed since the caller read that
    /// revision (`document.outline` and `document.find` give it). A step that changed the document without a revision takes
    /// the call back and is refused. → as `execMany`, with `revisions` (the new revisions' ids, which `review.resolve` takes)
    /// and `rev` (the document's revision after it).
    #[wasm_bindgen(js_name = execAs)]
    pub fn exec_as(&mut self, author: &str, tag: Option<String>, steps: &str, if_rev: Option<f64>) -> String {
        self.enter();
        self.comp = None;
        let Some(steps) = steps_of(steps) else {
            return json!({"ok": false, "changed": false, "error": "`steps` is an array of [id, args?]"}).to_string();
        };
        let rev = self.s.rev();
        let (r, made) = match self.s.run_as(author, tag.as_deref(), &steps, if_rev.map(|r| r as u64)) {
            Ok((values, made)) => (Ok(Value::Array(values)), made),
            Err(e) => (Err(e), Vec::new()),
        };
        let mut out = self.report_value(rev, r);
        out["revisions"] = json!(made);
        out["rev"] = json!(self.s.rev());
        out.to_string()
    }

    /// Runs command `id` with `args` (JSON) when it is pure (a query: it never changes the document), as `exec` reports one;
    /// a command that changes the document is refused. The tools read galleries, panes and dialogs with it (ctx.read).
    pub fn query(&mut self, id: &str, args: &str) -> String {
        self.enter();
        if self.s.registry.get(id).is_some_and(|s| s.mutates) {
            return json!({"ok": false, "changed": false, "error": format!("`{id}` changes the document: it is not a query")}).to_string();
        }
        // A composition in progress stays: a query is no command the input method's text gives way to.
        match serde_json::from_str::<Value>(args) {
            Ok(v) => self.run(id, &v),
            Err(e) => json!({"ok": false, "changed": false, "error": e.to_string()}).to_string(),
        }
    }

    /// `{id: {enabled, reason, checked, value}}` for the command ids in `ids` (a JSON array), at the selection. `checked` and
    /// `value` are the command's own `state` when its spec has one, else the table below (`checked`).
    pub fn state(&mut self, ids: &str) -> Result<String, JsError> {
        self.enter();
        let ids: Vec<String> = serde_json::from_str(ids).map_err(err)?;
        let run = ew_doc_edit::cmd::format::state(&self.s);
        let align = self.para().map(|p| p.align);
        let mut out = serde_json::Map::new();
        for id in ids {
            let spec = self.s.registry.get(&id).map(|s| s.state);
            let reason = if spec.is_some() { self.s.why_disabled(&id) } else { Some("unknown command") };
            let (checked, value) = match spec.flatten() {
                Some(state) => state(&self.s),
                None => checked(&id, &run, align),
            };
            out.insert(id, json!({"enabled": reason.is_none(), "reason": reason, "checked": checked, "value": value}));
        }
        Ok(Value::Object(out).to_string())
    }

    /// `{run, para}`: the run formatting at the selection (EasyWriter's `format.state`) and the caret paragraph's resolved
    /// properties.
    pub fn format(&self) -> String {
        json!({"run": ew_doc_edit::cmd::format::state(&self.s), "para": self.para()}).to_string()
    }

    /// Types `text` at the selection as the keyboard does (AutoCorrect and AutoFormat included).
    #[wasm_bindgen(js_name = insertText)]
    pub fn insert_text(&mut self, text: &str) -> String {
        self.enter();
        self.comp = None;
        self.run("text.insert", &json!({"text": text}))
    }

    /// Backspace: `unit` 'character' or 'word'.
    #[wasm_bindgen(js_name = deleteBackward)]
    pub fn delete_backward(&mut self, unit: &str) -> String {
        self.enter();
        self.comp = None;
        self.run(if unit == "word" { "text.deleteWordBack" } else { "text.backspace" }, &json!({}))
    }

    /// Delete: `unit` 'character' or 'word'.
    #[wasm_bindgen(js_name = deleteForward)]
    pub fn delete_forward(&mut self, unit: &str) -> String {
        self.enter();
        self.comp = None;
        self.run(if unit == "word" { "text.deleteWordForward" } else { "text.delete" }, &json!({}))
    }

    /// The input method's composition is now `text`, with its own selection `sel_start..sel_end` in UTF-16 units of `text`
    /// (as EditContext counts). The text stands in the document, so the page shows it laid out; it replaces the previous
    /// composition (the selection, for the first one) and all of it is one undo step. Empty text takes the composition
    /// away. `{anchor, head}`: the range to underline.
    pub fn compose(&mut self, text: &str, sel_start: u32, sel_end: u32) -> Result<String, JsError> {
        self.enter();
        let first = self.comp.is_none();
        if let Some((a, b)) = self.comp.take() {
            self.s.sel = Selection { anchor: a, focus: b };
        }
        let start = self.s.sel.ordered().0;
        if !first {
            self.s.join_next_undo();
        }
        let mark = self.s.undo_mark();
        let r = if !text.is_empty() {
            self.s.run_ime("text.insert", &json!({"text": text, "raw": true}))
        } else if !self.s.sel.is_collapsed() {
            self.s.run_ime("text.delete", &json!({}))
        } else {
            Ok(Value::Null)
        };
        r.map_err(err)?;
        if first {
            // Its own step only when it opened one: a composition that joined open typing shares that step. One that began
            // over a selection opened its step with the selection's deletion in it.
            self.comp_step = if self.s.undo_mark() > mark { self.s.top_step_ids().0 } else { None };
        } else if text.is_empty() {
            // Cancelled (Esc, or the focus moved on): the text is gone again, so the step it opened goes too, and with it
            // the selection it replaced comes back, as in Word.
            if let Some(id) = self.comp_step.take() {
                self.s.drop_step(id);
            }
        }
        self.note_ids();
        let end = self.s.sel.focus.clone();
        if !text.is_empty() && end.story == start.story && end.path == start.path {
            let at = |u: u32| Pos { off: (start.off + utf16_to_byte(text, u)).min(end.off), ..start.clone() };
            self.s.sel = Selection { anchor: at(sel_start), focus: at(sel_end) };
            self.comp = Some((start.clone(), end.clone()));
        }
        Ok(json!({"anchor": start, "head": end}).to_string())
    }

    /// Ends the composition, keeping its text, with the caret at its end. A caller that wants the caret elsewhere (the input
    /// method's last selection) sets it with `select` after this.
    pub fn commit(&mut self) {
        if let Some((_, end)) = self.comp.take() {
            self.s.sel = Selection::caret(end);
        }
    }

    pub fn undo(&mut self) -> String {
        self.enter();
        self.comp = None;
        self.run("edit.undo", &json!({}))
    }

    pub fn redo(&mut self) -> String {
        self.enter();
        self.comp = None;
        self.run("edit.redo", &json!({}))
    }

    /// The plain text of `anchor..head`.
    pub fn text(&mut self, anchor: &str, head: &str) -> Result<String, JsError> {
        let range = Selection { anchor: pos(anchor)?, focus: pos(head)? };
        let saved = std::mem::replace(&mut self.s.sel, range);
        // That range alone: a multiple selection whose active range it is would add the others' text.
        let multi = self.s.multi.take();
        let text = self.s.selected_text();
        self.s.sel = saved;
        self.s.multi = multi;
        Ok(text)
    }

    /// The selection copied (EasyWriter's `edit.copy`, which also fills its own clipboard) as `kind`: 'text', 'html', 'rtf'
    /// or 'docx'. Empty for an empty selection.
    pub fn copy(&mut self, kind: &str) -> Result<Vec<u8>, JsError> {
        self.enter();
        if self.s.sel.is_collapsed() && self.s.cell_range().is_none() {
            return Ok(Vec::new());
        }
        self.s.run("edit.copy", &json!({})).map_err(err)?;
        let Some(frag) = &self.s.clipboard else { return Ok(Vec::new()) };
        match kind {
            "text" => Ok(self.s.clipboard_text.clone().into_bytes()),
            "html" => Ok(self.s.clipboard_html.clone().into_bytes()),
            "rtf" | "docx" => ew_doc_edit::io::save_bytes(&format!("clip.{kind}"), &frag.to_document()).map_err(err),
            _ => Err(err(format!("unknown kind `{kind}`"))),
        }
    }

    /// Pastes `bytes` of `kind` ('text', 'html', 'rtf' or 'docx') at the selection (EasyWriter's `edit.paste`): the exec
    /// result.
    pub fn paste(&mut self, kind: &str, bytes: &[u8]) -> Result<String, JsError> {
        self.enter();
        self.comp = None;
        let args = match kind {
            "text" | "html" | "rtf" => json!({ kind: String::from_utf8_lossy(bytes) }),
            "docx" => {
                let frag = ew_doc_edit::io::open_bytes("clip.docx", bytes).map_err(err)?.body_fragment();
                self.s.clipboard_text = frag.clipboard_text();
                self.s.clipboard = Some(frag);
                json!({})
            }
            _ => return Err(err(format!("unknown kind `{kind}`"))),
        };
        Ok(self.run("edit.paste", &args))
    }

    /// `[{id, kind, x, y, w, h}]`: the drawings on `page` (pictures, charts, shapes and groups, each once at its frame), for
    /// the overlay's handles and EasyWriter's own objects. `id` is the drawing's stable id as a string; `kind` is 'picture',
    /// 'graphic', 'shape', 'group' or 'box', which also has `box`, its kind ('canvas', 'planChart'), whose data `box.get` gives,
    /// and `fallback`, the kind of the drawing that stands for it.
    pub fn frames(&mut self, page: usize) -> String {
        let l = self.laid_out();
        let mut out = Vec::new();
        if let Some(p) = l.pages.get(page) {
            frames_of(&self.s.doc, &p.ids, &p.items, &mut out);
        }
        Value::Array(out).to_string()
    }

    /// Adds a font file (TTF, OTF or TTC) to the font database: the number of faces added. The next layout lays out again
    /// only the paragraphs that asked for one of its families or fell back for a character (a `layout` event follows).
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, bytes: Vec<u8>) -> usize {
        let added = add_font(bytes);
        if added > 0 {
            self.s.fonts_changed();
        }
        added
    }

    /// The `fonts.missing` event's body `{families: [{family, standIn, standIns}], scripts}` when layout met families or
    /// scripts it has no font for since the last one (each once), else undefined. `standIn` is the font a family is drawn in
    /// now and `standIns` the fonts Word's substitution picks from, first loaded wins: the provider supplies the first one it
    /// has rather than choosing one itself.
    #[wasm_bindgen(js_name = takeMissingFonts)]
    pub fn take_missing_fonts(&mut self) -> Option<String> {
        let db = ew_fonts::FontDb::global();
        let (families, scripts) = (db.take_missing_families(), db.take_missing_scripts());
        (!families.is_empty() || !scripts.is_empty()).then(|| json!({"families": missing_json(families), "scripts": scripts}).to_string())
    }

    /// The families drawn with a stand-in now (asked for, none of their own faces loaded): `[{family, standIn, standIns}]`.
    #[wasm_bindgen(js_name = missingFonts)]
    pub fn missing_fonts(&self) -> String {
        missing_json(ew_fonts::FontDb::global().missing_families()).to_string()
    }

    /// `{families, scripts}`: the fonts this document has used so far, for the font provider of a second worker that lays it
    /// out the same way (the helper worker's PDF, viewport-design.md section 8). `families` are the families it asked for, a
    /// missing one as `{family, standIns}` so the provider loads the stand-in this worker's provider loaded; `scripts` are those
    /// it needed a fallback font for.
    #[wasm_bindgen(js_name = fontsUsed)]
    pub fn fonts_used(&self) -> String {
        self.enter();
        let (named, scripts) = ew_fonts::font_scope_names();
        let missing = ew_fonts::FontDb::global().missing_families();
        let families: Vec<Value> = named
            .iter()
            .map(|f| match missing.iter().find(|m| m.family.eq_ignore_ascii_case(f)) {
                Some(m) => json!({"family": f, "standIns": m.stand_ins}),
                None => json!(f),
            })
            .collect();
        json!({"families": families, "scripts": scripts}).to_string()
    }

    /// `{wasm, heap, fonts, undo, lightEdits}` (docs/plans/engine/viewport-design.md section 8): the worker's WebAssembly
    /// memory, the allocator's bytes in use and the font files loaded at run time (compiled-in fonts not counted), all three for
    /// the whole worker and the first two null natively; then this session's undo steps and the typing keys that took the
    /// bounded edit path (`edit_path.rs`), which tests count instead of timing a key. Cheap: it lays nothing out.
    // ponytail: the render caches' bytes and the layout's and undo's own bytes are not counted; P6 (the display-list cache)
    // and P12 (undo's byte cap) add them where they keep those numbers.
    pub fn stats(&self) -> String {
        let mem = memory();
        json!({
            "wasm": mem.map(|m| m.0),
            "heap": mem.map(|m| m.1),
            "fonts": ew_fonts::FontDb::global().loaded_font_bytes(),
            "undo": self.s.undo_depth(),
            "lightEdits": self.s.light_edits(),
        })
        .to_string()
    }
}

/// The WebAssembly memory's size and the allocator's bytes in use, or None natively.
pub(crate) fn memory() -> Option<(usize, usize)> {
    #[cfg(target_arch = "wasm32")]
    {
        Some((core::arch::wasm32::memory_size(0) * 65536, big_step::in_use()))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        None
    }
}

fn missing_json(families: Vec<ew_fonts::MissingFamily>) -> Value {
    families.into_iter().map(|m| json!({"family": m.family, "standIn": m.stand_in, "standIns": m.stand_ins})).collect()
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        ew_fonts::drop_font_scope(self.scope);
        tiles::forget(self.id);
    }
}

/// FNV-1a over `s`, as hex: a digest for comparing layouts, not for security.
fn fnv(s: &str) -> String {
    let h = s.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

impl Engine {
    /// Makes this session's font scope the current one: every call that may lay out, draw or edit starts here.
    fn enter(&self) {
        ew_fonts::enter_font_scope(self.scope);
    }

    /// Opens `doc` read for `open` with an empty undo history and lays it out → `{pages, settled}`.
    fn open_document(&mut self, doc: ew_doc_edit::doc::Document) -> String {
        self.s.set_document(doc);
        self.settled_sizes.clear();
        self.s.reset_history();
        self.comp = None;
        self.s.reset_ids();
        let l = self.laid_out();
        json!({"pages": l.pages.len(), "settled": l.settled()}).to_string()
    }

    /// The session's layout, laid out again (only the paragraphs that fell back) while its font scope grew during it: a
    /// paragraph laid out before a later one named a font falls back as the finished document would make it. A layout still
    /// being made names fonts as it goes, so that waits until it is settled, as a whole layout's pass ends first.
    pub(crate) fn laid_out(&mut self) -> Arc<DocLayout> {
        self.enter();
        let mut l = self.s.layout();
        for _ in 0..3 {
            if !l.settled() || !ew_fonts::font_scope_grew() {
                break;
            }
            ew_fonts::FontDb::global().scope_changed();
            self.s.fonts_changed();
            l = self.s.layout();
        }
        l
    }

    /// Lays the rest of a layout still being made out at once, for the calls that need the whole layout.
    pub(crate) fn settle_all(&mut self) {
        // Settling begins again when fonts were named late (laid_out), once per family at most.
        for _ in 0..64 {
            if self.settle(f64::INFINITY) {
                break;
            }
        }
    }

    /// Runs a command and describes the outcome as `exec` does.
    fn run(&mut self, id: &str, v: &Value) -> String {
        let rev = self.s.rev();
        let r = self.s.run(id, v);
        self.report(rev, r.map_err(|e| (None, e)))
    }

    /// Describes the outcome of commands run since revision `rev`: `{ok, changed, value}` or `{ok: false, changed, error,
    /// step?}`, with `ui` when they asked the front end for something.
    fn report(&mut self, rev: u64, r: Result<Value, (Option<usize>, ew_doc_edit::CmdError)>) -> String {
        self.report_value(rev, r).to_string()
    }

    /// `report` as a value, for a call that adds to it.
    fn report_value(&mut self, rev: u64, r: Result<Value, (Option<usize>, ew_doc_edit::CmdError)>) -> Value {
        if self.s.rev() != rev {
            self.note_ids();
        }
        let ui: Vec<Value> = self.s.ui_requests.drain(..).collect();
        let mut out = match r {
            Ok(value) => json!({"ok": true, "changed": self.s.rev() != rev, "value": value}),
            Err((step, e)) => {
                let mut o = json!({"ok": false, "changed": self.s.rev() != rev, "error": e.to_string()});
                if let Some(i) = step {
                    o["step"] = json!(i);
                }
                o
            }
        };
        if !ui.is_empty() {
            out["ui"] = Value::Array(ui);
        }
        out
    }

    /// Gives the blocks and drawings the last change made their ids and notes the blocks it touched (the session keeps both).
    fn note_ids(&mut self) {
        self.s.note_ids();
    }

    /// `[{w, h, section, first}]` as JSON (`first`: the page's key, board design section 6).
    /// engine-keys-final: while a layout is not settled, the pages it has not laid out yet follow those it has as the last
    /// settled layout of the document had them, as Word shows the later pages until it has paginated them again. An edit
    /// whose walk passes the view's pages (an Enter on page 300 of the Word fixture that runs every later line on) pauses
    /// there; listed alone, the pages laid out took the count from 976 to 302 and back a few slices later, and the page's
    /// views placed every page again each time, 2 ms of that key's way to the screen. An open has no such pages to show.
    fn page_sizes(&mut self) -> String {
        let l = self.laid_out();
        let keys = crate::tiles::page_keys(&l);
        let mut now: Vec<(f32, f32, usize, String)> =
            l.pages.iter().zip(keys).map(|(p, first)| (p.w, p.h, p.section, first)).collect();
        if l.settled() {
            if now != self.settled_sizes {
                self.settled_sizes.clone_from(&now);
            }
        } else if let Some(rest) = self.settled_sizes.get(now.len()..) {
            now.extend_from_slice(rest);
        }
        if now != self.sizes.0 {
            let json = Value::Array(now.iter().map(|(w, h, section, first)| json!({"w": w, "h": h, "section": section, "first": first})).collect()).to_string();
            self.sizes = (now, json);
        }
        self.sizes.1.clone()
    }

    /// The caret paragraph's resolved properties.
    fn para(&self) -> Option<ew_doc_edit::doc::resolve::ResolvedPara> {
        let p = self.s.doc.para_at(&self.s.sel.focus)?;
        Some(self.s.doc.styles.resolve_para(&p.props))
    }

    /// Notes a new layout: the version goes up and the pages it laid out again join `pending`. A change outside the body
    /// text (page colour, watermark, a header) lays the whole document out again, so all pages repaint.
    fn sync(&mut self) {
        self.laid_out();
        if let Some(r) = self.s.take_layout_change() {
            self.version += 1;
            self.pending = Some(match self.pending.take() {
                Some(p) => p.start.min(r.start)..p.end.max(r.end),
                None => r,
            });
        }
        // A page colour change (Read Mode, Immersive Reader) keeps the lists but repaints every tile, as setColors does.
        let paint = self.paint_key();
        if paint != self.painted {
            self.painted = paint;
            self.version += 1;
            self.pending = Some(0..usize::MAX);
            tiles::forget(self.id);
        }
    }
}

/// Command steps from JSON `[[id, args?], ...]`, or None when they are not that.
fn steps_of(steps: &str) -> Option<Vec<(String, Value)>> {
    let step = |v: Value| match v.as_array().map(Vec::as_slice) {
        Some([Value::String(id)]) => Some((id.clone(), json!({}))),
        Some([Value::String(id), args]) => Some((id.clone(), args.clone())),
        _ => None,
    };
    serde_json::from_str::<Vec<Value>>(steps).ok().and_then(|v| v.into_iter().map(step).collect())
}

/// The engine's own form, read with EasyWriter's `.json` reader (which keeps its fix-ups after reading) and upgraded.
fn open_model(bytes: &[u8]) -> Result<ew_doc_edit::doc::Document, JsError> {
    let read = ew_doc_edit::io::open_bytes("document.json", bytes);
    let mut doc = read.map_err(|e| err(ew_doc_edit::doc::refusal(bytes).unwrap_or(e)))?;
    doc.upgrade().map_err(err)?;
    Ok(doc)
}

fn file_name(kind: &str) -> Result<&'static str, JsError> {
    match kind {
        "docx" => Ok("document.docx"),
        "doc" => Ok("document.doc"),
        "engine" => Ok("document.json"),
        // Save As's other kinds (docs/plans/engine/stage2/review.md gap 33, stage2b.md R10): the engine writes them by extension.
        "txt" => Ok("document.txt"),
        "html" => Ok("document.html"),
        "md" => Ok("document.md"),
        "rtf" => Ok("document.rtf"),
        "odt" => Ok("document.odt"),
        // A forum post's JSON (docs/plans/engine/stage3-forum.md section 2).
        "post" => Ok("document.post"),
        _ => Err(err(format!("unknown kind `{kind}`"))),
    }
}

/// The byte offset of UTF-16 unit `u` in `text` (its end when `u` is past it).
fn utf16_to_byte(text: &str, u: u32) -> usize {
    let mut n = 0;
    for (i, c) in text.char_indices() {
        if n >= u as usize {
            return i;
        }
        n += c.len_utf16();
    }
    text.len()
}

/// The frames of the drawings among `items`, whose body blocks `ids` names.
fn frames_of(doc: &ew_doc_edit::doc::Document, ids: &ew_doc_edit::layout::BlockIds, items: &[Placed], out: &mut Vec<Value>) {
    use ew_doc_edit::doc::InlineObject;
    for it in items {
        match it {
            Placed::Object { rect: r, story, path, off, .. } => {
                let Some(path) = ids.doc_path(*story, path) else { continue };
                let Some(o) = doc.para(*story, &path).and_then(|p| p.object_at(*off)) else { continue };
                let Some((_, _, f)) = o.frame() else { continue };
                let drawing = match o {
                    InlineObject::Image { .. } => "picture",
                    InlineObject::Graphic { .. } => "graphic",
                    InlineObject::Group { .. } => "group",
                    _ => "shape",
                };
                // A string id: React keys and the overlay's data-frame take it as is.
                // `pos`: its character, which select.addObject and the pointer tools take (engine-page-tools).
                let at = Pos { story: *story, path: path.clone(), off: *off };
                let mut v = json!({"id": f.id.0.to_string(), "kind": drawing, "x": r.x, "y": r.y, "w": r.w, "h": r.h, "pos": at});
                if let Some(b) = &f.r#box {
                    // The fallback's own kind tells what part of the object it shows: a lone shape only its own box.
                    v["kind"] = json!("box");
                    v["box"] = json!(b.kind);
                    v["fallback"] = json!(drawing);
                }
                out.push(v);
            }
            Placed::Clip { items, .. } => frames_of(doc, ids, items, out),
            _ => {}
        }
    }
}

/// The ribbon state of toggles and boxes that EasyWriter's `format.state` and the paragraph's alignment answer.
// ponytail: the Home tab's font and alignment controls only; other commands report null until stage 2 moves the ribbon
// to engine commands (plan section 6) and adds theirs here.
fn checked(id: &str, run: &Value, align: Option<ew_doc_edit::doc::props::Align>) -> (Value, Value) {
    use ew_doc_edit::doc::props::Align;
    let key = match id {
        "format.bold" => "bold",
        "format.italic" => "italic",
        "format.underline" => "underline",
        "format.strikethrough" => "strike",
        "format.subscript" => "subscript",
        "format.superscript" => "superscript",
        "format.smallCaps" => "smallCaps",
        "format.allCaps" => "caps",
        "format.hidden" => "hidden",
        "format.border" => "border",
        "format.font" => return (Value::Null, run["font"].clone()),
        "format.size" => return (Value::Null, run["size"].clone()),
        "format.color" => return (Value::Null, run["color"].clone()),
        "format.highlight" => return (Value::Null, run["highlight"].clone()),
        "para.style" => return (Value::Null, run["style"].clone()),
        "para.alignLeft" => return (json!(align == Some(Align::Left)), Value::Null),
        "para.alignCenter" => return (json!(align == Some(Align::Center)), Value::Null),
        "para.alignRight" => return (json!(align == Some(Align::Right)), Value::Null),
        "para.justify" => return (json!(align == Some(Align::Justify)), Value::Null),
        "para.distribute" => return (json!(align == Some(Align::Distribute)), Value::Null),
        _ => return (Value::Null, Value::Null),
    };
    (run[key].clone(), Value::Null)
}

/// The global allocator on wasm: dlmalloc, as in std, but growing the WebAssembly memory 32 MiB at a time. std's dlmalloc
/// grows it by what each request needs, and every `memory.grow` costs about 2 ms in V8 on Windows: the WordCraft evaluation
/// (docs/plans/word/wordcraft-eval.md section 3) found 53-56% of the fixture's layout time there. From its `wcbench`.
#[cfg(target_arch = "wasm32")]
mod big_step {
    use core::arch::wasm32::memory_grow;
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicUsize, Ordering::Relaxed};
    use std::alloc::{GlobalAlloc, Layout};

    const PAGE: usize = 64 << 10;
    const STEP: usize = 32 << 20;

    /// Bytes allocated and not yet freed, as asked for (dlmalloc's own overhead not counted), for `stats()`.
    static IN_USE: AtomicUsize = AtomicUsize::new(0);

    pub(crate) fn in_use() -> usize {
        IN_USE.load(Relaxed)
    }

    struct Big;

    unsafe impl dlmalloc::Allocator for Big {
        fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
            // A whole step when it fits in the memory left, else just what was asked for.
            for want in [size.max(STEP), size] {
                let pages = want.div_ceil(PAGE);
                let prev = memory_grow(0, pages);
                if prev != usize::MAX {
                    return ((prev * PAGE) as *mut u8, pages * PAGE, 0);
                }
            }
            (core::ptr::null_mut(), 0, 0)
        }
        fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
            core::ptr::null_mut()
        }
        fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
            false
        }
        fn free(&self, _: *mut u8, _: usize) -> bool {
            false
        }
        fn can_release_part(&self, _: u32) -> bool {
            false
        }
        fn allocates_zeros(&self) -> bool {
            true
        }
        fn page_size(&self) -> usize {
            PAGE
        }
    }

    // ponytail: no lock; wasm32-unknown-unknown without the atomics feature has one thread.
    struct Global(UnsafeCell<dlmalloc::Dlmalloc<Big>>);
    unsafe impl Sync for Global {}

    #[global_allocator]
    static A: Global = Global(UnsafeCell::new(dlmalloc::Dlmalloc::new_with_allocator(Big)));

    unsafe impl GlobalAlloc for Global {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let p = unsafe { (*self.0.get()).malloc(l.size(), l.align()) };
            if !p.is_null() {
                IN_USE.fetch_add(l.size(), Relaxed);
            }
            p
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            let p = unsafe { (*self.0.get()).calloc(l.size(), l.align()) };
            if !p.is_null() {
                IN_USE.fetch_add(l.size(), Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            IN_USE.fetch_sub(l.size(), Relaxed);
            unsafe { (*self.0.get()).free(p, l.size(), l.align()) }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
            let q = unsafe { (*self.0.get()).realloc(p, l.size(), l.align(), n) };
            if !q.is_null() {
                IN_USE.fetch_add(n, Relaxed);
                IN_USE.fetch_sub(l.size(), Relaxed);
            }
            q
        }
    }
}

#[cfg(test)]
mod tests {
    use super::utf16_to_byte;

    #[test]
    fn utf16_offsets() {
        // "你" is 3 bytes and 1 unit; "😀" is 4 bytes and 2 units.
        assert_eq!(utf16_to_byte("a你😀b", 0), 0);
        assert_eq!(utf16_to_byte("a你😀b", 2), 4);
        assert_eq!(utf16_to_byte("a你😀b", 4), 8);
        assert_eq!(utf16_to_byte("a你😀b", 9), 9);
    }
}
