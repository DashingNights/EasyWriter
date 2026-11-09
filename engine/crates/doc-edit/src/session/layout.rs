use super::doc_state::{Selection, TypedWord, typed_range};
use super::locale::SYSTEM_LOCALE;
use super::snapshot_types::LayoutEntry;
use super::view::DRAFT_WIDTH;
use super::{Arc, DocLayout, Document, LayoutCache, LayoutOptions, Session, StoryRef, Value, ViewMode};

impl Session {
    /// Brings the document's stable ids up to date with the changes made since (a block without one, a split's second half
    /// or a pasted copy gets its own) and notes the blocks they touched. The layout names the body's blocks by these ids
    /// (engine-layout-ids), so every layout made from the session has them.
    pub fn note_ids(&mut self) {
        let c = self.ids.update(&mut self.doc);
        self.id_changes.then(c);
    }

    /// The blocks changes touched since the last call, by stable id (the layout event's `changes`).
    pub fn take_id_changes(&mut self) -> ew_doc::Changes {
        std::mem::take(&mut self.id_changes)
    }

    /// Gives the document its ids afresh, with no changes to report (a document just opened).
    pub fn reset_ids(&mut self) {
        self.ids = ew_doc::Ids::fill(&mut self.doc);
        self.id_changes = Default::default();
    }

    /// The current layout (recomputed when the document or view changed).
    pub fn layout(&mut self) -> Arc<DocLayout> {
        let typing = self.typing_word();
        self.layout_with(typing, None)
    }

    /// engine-open: a layout made from the start lays out only about `pages` pages before it returns, and the rest follows
    /// in slices from [`Session::advance_layout`]; `None` (the default) lays the whole document out at once.
    pub fn set_layout_ahead(&mut self, pages: Option<usize>) {
        self.cache.set_ahead(pages);
    }

    /// engine-layout-key: the pages on screen end before page `end` (`None`: not known), so that an edit lays out no further
    /// than those (and the edited page and the next) before it returns ([`ew_doc_layout::LayoutCache::set_screen`]).
    pub fn set_layout_screen(&mut self, end: Option<usize>) {
        self.cache.set_screen(end);
    }

    /// engine-repaginate-2: paragraph layouts looked up in the layout cache so far (found or made), the measure of layout
    /// work the worker reports for a slice a key waited behind.
    #[doc(hidden)]
    pub fn paragraph_layouts(&self) -> u64 {
        self.cache.hits + self.cache.misses
    }

    /// engine-layout-key: pages the layout walks laid out so far, the other measure of a key's layout work.
    #[doc(hidden)]
    pub fn pages_laid_out(&self) -> u64 {
        self.cache.pages_laid
    }

    /// engine-open: [`Session::layout`], and a layout not yet settled goes on for about `ms` milliseconds.
    pub fn advance_layout(&mut self, ms: f64) -> Arc<DocLayout> {
        let typing = self.typing_word();
        self.layout_with(typing, Some(ms))
    }

    /// [`Session::layout`] with `typing` as the word being typed; with `advance`, an unsettled layout goes on that long.
    fn layout_with(&mut self, typing: Option<ew_doc_layout::TypingWord>, advance: Option<f64>) -> Arc<DocLayout> {
        let mode = if self.view.read_mode { ViewMode::Read } else { self.view.mode };
        let width = match mode {
            ViewMode::Read => self.view.read_width,
            ViewMode::Web if self.view.immersive => self.view.reader_width.unwrap_or_else(|| self.page_text_column()),
            ViewMode::Web => self.view.web_width,
            ViewMode::Draft if self.view.wrap_to_window => self.view.web_width,
            ViewMode::Draft => self.page_text_column(),
            _ => DRAFT_WIDTH,
        };
        // Immersive Reader's text options, which Read Mode's View menu also has.
        let reader = ((mode == ViewMode::Web && self.view.immersive) || mode == ViewMode::Read)
            .then_some(ew_doc_layout::ReaderText { spacing: self.view.reader_spacing, syllables: self.view.reader_syllables })
            .filter(|r| r.spacing || r.syllables);
        let height = if self.view.read_mode { self.view.read_height } else { 0.0 };
        let spacing = if self.view.read_mode { self.view.read_line_spacing.map(f32::to_bits) } else { None };
        // Deletions in balloons depend on the view (the Comments pane, Read Mode, side by side), so
        // a view change that moves them in or out of the text lays it out again.
        // Original keeps the deletions and leaves the insertions out instead.
        let original = self.view.display_for_review == crate::view::ReviewDisplay::Original;
        let hide_deleted = !self.view.show_markup && !original;
        let marked = if original { ew_doc_layout::HideDeleted::ORIGINAL } else { self.prefs.markup.hidden_deletions() };
        let deleted = (hide_deleted, marked, self.revisions_in_balloons());
        // Outline view's own state, or in the page views the headings the reader folded or opened (stage2.md G19), which
        // the layout key holds so a fold lays the document out again.
        let outline = if mode == ViewMode::Outline { Some(self.view.outline.view()) } else { self.view.outline.fold_view(&self.doc) };
        let shown = (self.view.marks || self.prefs.marks.hidden, self.view.field_codes);
        let (rev, proofing, numeral) = (self.rev, self.view.proofing, self.view.numeral);
        let fits = |e: &Option<LayoutEntry>| {
            e.as_ref().is_some_and(|(r, w, h, m, sp, _, pf, o, hd, n, t, sh, mgn)| {
                *r == rev
                    && (*w == width || mode == ViewMode::Print)
                    && *h == height
                    && *m == mode
                    && *sp == spacing
                    && *pf == proofing
                    && *n == numeral
                    && *hd == deleted
                    && *o == outline
                    && *t == typing
                    && *sh == shown
                    && *mgn == self.view.web_margin
            })
        };
        if !fits(&self.layout[0]) && fits(&self.layout[1]) {
            self.layout.swap(0, 1);
            // The other view's layout: all its pages are new to the front end.
            self.layout_changed = Some(0..usize::MAX);
        }
        if fits(&self.layout[0])
            && let Some(e) = &self.layout[0]
            && (advance.is_none() || e.5.settled())
        {
            return e.5.clone();
        }
        // The layout names the body's blocks by their stable ids: blocks a change added get theirs first.
        self.note_ids();
        let (fn_name, fn_path) = self.resolved_filenames();
        let (filename, filepath): (Option<Arc<str>>, Option<Arc<str>>) = (Some(Arc::from(fn_name.as_str())), Some(Arc::from(fn_path.as_str())));
        let opts = LayoutOptions {
            view: mode,
            web_width: width,
            web_margin: self.view.web_margin,
            read_height: height,
            read_line_spacing: spacing.map(f32::from_bits),
            show_hidden: shown.0,
            hide_deleted,
            hide_marked: deleted.1.clone(),
            deletions_in_balloons: deleted.2,
            proofing: self.view.proofing,
            numeral: self.view.numeral.resolve(SYSTEM_LOCALE.get().map(String::as_str)),
            comment_balloons: false,
            field_codes: shown.1,
            outline: outline.clone(),
            // Headings collapsed by default fold, as Word shows them on opening, and the reader can open them (heading.collapse).
            expanded: Some(Default::default()),
            proof: ew_doc_layout::ProofOptions { grammar: self.prefs.mark_grammar, spelling: self.prefs.spelling() },
            typing_word: typing,
            filename: filename.clone(),
            filepath: filepath.clone(),
            reader,
        };
        // The layout last made for this view is laid out again where the document changed (ew_doc_layout::relayout).
        // Taken out of its slot, it is held nowhere else, so its pages are reused rather than copied.
        let same_view = |e: &Option<LayoutEntry>| {
            e.as_ref().is_some_and(|(_, w, h, m, sp, _, pf, o, hd, n, _, sh, mgn)| {
                (*w == width || mode == ViewMode::Print)
                    && *h == height
                    && *m == mode
                    && *sp == spacing
                    && *pf == proofing
                    && *n == numeral
                    && *hd == deleted
                    && *o == outline
                    && *sh == shown
                    && *mgn == self.view.web_margin
            })
        };
        let prev = (0..2).find(|&i| same_view(&self.layout[i])).and_then(|i| self.layout[i].take()).map(|e| Arc::try_unwrap(e.5));
        let (l, changed) = match (prev, advance) {
            (Some(Ok(prev)), Some(ms)) if !prev.settled() => ew_doc_layout::advance(&self.doc, &mut self.cache, &opts, prev, ms),
            (Some(Ok(prev)), _) => ew_doc_layout::relayout(&self.doc, &mut self.cache, &opts, prev),
            _ => {
                let l = ew_doc_layout::layout(&self.doc, &mut self.cache, &opts);
                let n = l.pages.len();
                (l, 0..n)
            }
        };
        if !changed.is_empty() {
            let had = self.layout_changed.take();
            self.layout_changed = Some(had.map_or(changed.clone(), |h| h.start.min(changed.start)..h.end.max(changed.end)));
        }
        let l = Arc::new(l);
        let [a, b] = std::mem::take(&mut self.layout);
        self.layout = [
            Some((self.rev, width, height, mode, spacing, l.clone(), self.view.proofing, outline, deleted, self.view.numeral, typing, shown, self.view.web_margin)),
            a.or(b),
        ];
        l
    }

    /// EasyWriter engine-gaps-views: the page Draft and the Reader's Default width lay text out on, which the continuous views'
    /// 18 pt margins ([`ew_doc_layout`]'s reflow page) take from: the first section's text width with those margins, so lines
    /// break as on the printed page.
    fn page_text_column(&self) -> f32 {
        let margins = 2.0 * self.view.web_margin;
        let text = self.doc.sections().first().map_or(DRAFT_WIDTH - margins, |(_, s)| s.text_width());
        text.clamp(72.0, 20_000.0) + margins
    }

    /// The pages laid out again since the last call (`to` may run past the last page), or `None` when no layout changed.
    /// A front end that draws pages repaints these.
    pub fn take_layout_change(&mut self) -> Option<std::ops::Range<usize>> {
        self.layout_changed.take()
    }

    /// The recorded word while the caret and the word are as typing left them; else drops it.
    fn typing_word(&mut self) -> Option<ew_doc_layout::TypingWord> {
        let t = self.typing.as_ref()?;
        let p = if self.sel.is_collapsed() && self.sel.focus == t.at { self.doc.para_at(&t.at) } else { None };
        match p {
            Some(p) if typed_range(&p.text, t.at.off) == Some((t.start, t.end)) => {
                Some(ew_doc_layout::TypingWord { rev: p.rev, start: t.start, end: t.end })
            }
            _ => {
                self.typing = None;
                None
            }
        }
    }

    /// After a successful command: a `text.*` edit at the caret records the word being typed;
    /// any other caret move ends it.
    pub(super) fn note_typing(&mut self, id: &str, edited: bool, sel_before: &Selection) {
        if id.starts_with("text.") && edited {
            self.typing = self.word_being_typed();
        } else if self.sel != *sel_before {
            self.typing = None;
        }
    }

    /// The word the collapsed caret ends or sits in, as [`TypedWord`].
    fn word_being_typed(&self) -> Option<TypedWord> {
        if !self.sel.is_collapsed() {
            return None;
        }
        let at = self.sel.focus.clone();
        let (start, end) = typed_range(&self.doc.para_at(&at)?.text, at.off)?;
        Some(TypedWord { at, start, end })
    }

    /// The page as command `id` would leave it, for a live preview (Insert › Table's grid, #3931):
    /// the command runs on a copy of the document, with this caret and view, and the copy is laid
    /// out. The copy comes back with its layout, which is drawn from it: the layout's paragraph
    /// paths name the copy's paragraphs, not this document's, and so is the copy's selection,
    /// which is where the caret would be. The document, the selection, the undo history and Repeat
    /// are untouched. `None` when the command fails or isn't allowed here.
    pub fn preview_layout(&mut self, id: &str, params: &Value) -> Option<(Document, Selection, Arc<DocLayout>)> {
        // The word being typed keeps going without a squiggle on the preview: the command moves
        // the copy's caret off it and may split its paragraph, so it is found again by its place.
        let typing = self.typing_word();
        let at = self.sel.focus.clone();
        let mut copy = Session::with_registry(self.doc.clone(), self.registry.clone());
        copy.sel = self.sel.clone();
        copy.column = self.column.clone();
        copy.multi = self.multi.clone();
        copy.widened = self.widened.clone();
        copy.view = self.view.clone();
        copy.prefs = self.prefs.clone();
        copy.path = self.path.clone();
        copy.file_name = self.file_name.clone();
        copy.author = self.author.clone();
        copy.last_highlight = self.last_highlight;
        copy.system_region = self.system_region.clone();
        copy.editing_lang = self.editing_lang.clone();
        // The copy shares the paragraph layouts, so only what the command changed is laid out.
        std::mem::swap(&mut copy.cache, &mut self.cache);
        let layout = copy.run(id, params).is_ok().then(|| {
            let typing = typing.and_then(|t| {
                let p = copy.doc.para_at(&at)?;
                (t.end <= p.len()).then_some(ew_doc_layout::TypingWord { rev: p.rev, ..t })
            });
            copy.layout_with(typing, None)
        });
        std::mem::swap(&mut copy.cache, &mut self.cache);
        layout.map(|l| (copy.doc, copy.sel, l))
    }

    /// The layout last made for the view, without laying out: a state reader's (it takes `&self`), which may be a change
    /// behind. None before the first layout.
    pub fn last_layout(&self) -> Option<Arc<DocLayout>> {
        self.layout[0].as_ref().map(|e| e.5.clone())
    }

    /// A layout for output (PDF, images, print): no proofing marks, print view.
    pub fn export_layout(&self) -> Arc<DocLayout> {
        self.export_layout_with(false)
    }

    /// [`Session::export_layout`]; with `markup` (Print Markup) each page also has the markup
    /// area with the comments in balloons.
    pub fn export_layout_with(&self, markup: bool) -> Arc<DocLayout> {
        let (fn_name, fn_path) = self.resolved_filenames();
        let opts = LayoutOptions {
            view: ViewMode::Print,
            comment_balloons: markup && self.prefs.markup.comments,
            numeral: self.view.numeral.resolve(SYSTEM_LOCALE.get().map(String::as_str)),
            filename: Some(Arc::from(fn_name.as_str())),
            filepath: Some(Arc::from(fn_path.as_str())),
            // EasyWriter engine-fidelity-4: print and PDF leave out what is under a heading collapsed by default, as Word's do.
            expanded: Some(Default::default()),
            ..Default::default()
        };
        Arc::new(ew_doc_layout::layout(&self.doc, &mut LayoutCache::new(), &opts))
    }

    /// Fonts were added: lay out again, keeping the cached paragraphs whose fonts did not change
    /// (the layout cache checks each one's families, EasyWriter patch).
    /// A paint flag changed (Highlight Merge Fields): every page is drawn again, so the views repaint their tiles. The layout
    /// stays.
    pub fn repaint(&mut self) {
        self.layout_changed = Some(0..usize::MAX);
    }

    pub fn fonts_changed(&mut self) {
        self.layout = Default::default();
    }

    /// Invalidate the cached layout (fonts changed etc.).
    pub fn relayout(&mut self) {
        self.layout = Default::default();
        self.cache.clear();
    }

    /// Set the language new documents are written in ([`Session::editing_lang`]; `None` or a
    /// malformed tag: US English). A document nobody has touched yet — untitled, unchanged, no
    /// undo steps, no text — switches too, so the blank document a session starts with follows
    /// the saved proofing default, or the interface language when none is saved. Nothing else
    /// changes and no undo step is added.
    pub fn set_editing_language(&mut self, tag: Option<&str>) {
        let tag = self
            .prefs
            .default_language
            .as_deref()
            .and_then(ew_proof::lang::normalize_tag)
            .or_else(|| tag.and_then(ew_proof::lang::normalize_tag));
        if self.editing_lang == tag {
            return;
        }
        self.editing_lang = tag;
        let untouched = self.path.is_none() && !self.dirty && self.history.is_empty() && self.redo.is_empty();
        if untouched && self.doc.plain_text(StoryRef::Body).trim().is_empty() && self.doc.paragraph_count() <= 1 {
            self.doc.styles_mut().default_chr.lang = Some(self.editing_lang.clone().unwrap_or_else(|| "en-US".into()));
            self.rev = self.rev.wrapping_add(1);
            // Not an edit: the document is as untouched as it was.
            if self.made_rev == self.rev.wrapping_sub(1) {
                self.made_rev = self.rev;
            }
            self.relayout();
        }
    }
}
