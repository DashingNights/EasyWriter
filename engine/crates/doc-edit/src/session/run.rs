use super::doc_state::{ColumnBlock, Selection};
use super::edit_path::Light;
use super::ime_state::ImeCaretState;
use super::snapshot_types::RunSnapshot;
use super::{CharProps, CmdError, Document, Fragment, ImeEditOutcome, Pos, Session, StoryRef, Value, document_id_mark};
use crate::CommandSpec;

struct SuccessContext<'a> {
    id: &'a str,
    spec: &'a CommandSpec,
    before_doc: &'a Option<RunSnapshot>,
    light: &'a Option<Light>,
    pending_before: &'a Option<Option<CharProps>>,
    document_id_before: u64,
    replaces_document: bool,
    dirty_before: Option<bool>,
    rev_restore: Option<u64>,
    pushed: bool,
    mutates: bool,
    ime_caret_before: ImeCaretState,
    rev_before: u64,
    sel_before: &'a Selection,
}

/// An assistant's call (docs/plans/engine/stage2b.md decision 4, [`Session::run_as`]): its commands are tracked changes by
/// `author`, whatever the user's own author and Track Changes setting are.
pub(crate) struct TrackAs {
    author: String,
    /// The suggestion group its revisions carry.
    tag: Option<String>,
    /// The revisions before this index are older than the call: its own never join them.
    first: usize,
    /// Revisions handed out to the call's commands so far, new or joined, so a step that changed the document without one shows.
    taken: u64,
    /// The user's settings while one of its commands runs: [`Session::run`] swaps them out after the undo checkpoint, so the
    /// undo step holds the user's own, and back in on every way out of the command.
    user: Option<UserSettings>,
}

struct UserSettings {
    author: String,
    track_changes: bool,
    track_formatting: bool,
    overtype: bool,
    replaces_selection: bool,
}

struct ElsewhereContext {
    home: u64,
    mark: u64,
    before_doc: Option<RunSnapshot>,
    light: Option<Light>,
    blocks_before: Option<std::collections::BTreeMap<String, Fragment>>,
    default_language_before: Option<String>,
    pending_application_change_before: bool,
}

impl Session {
    fn leave_math_for_command(&mut self, id: &str) {
        if self.math.is_some()
            && (id.starts_with("text.") || id.starts_with("caret.") || id.starts_with("select.") || id.starts_with("edit.paste"))
            && let Some(m) = self.math.take()
        {
            let off = m.at.off + ew_doc::para::OBJ.len_utf8();
            self.sel = Selection::caret(Pos { off, ..m.at });
        }
    }

    /// Whether the command changed nothing: the document, the selection, the formatting
    /// waiting at the caret and the column selection are as they were before it ran.
    ///
    /// A command that changes nothing is not an edit: it adds no undo step, marks no
    /// unsaved changes, forces no relayout and leaves the redo stack alone (#23).
    fn unchanged(&self, doc: &Document, sel: &Selection, column: &Option<ColumnBlock>, pending: &Option<CharProps>) -> bool {
        doc.same_content(&self.doc) && *sel == self.sel && *column == self.column && *pending == self.pending
    }

    /// Run a command by id with JSON params (the single entry point for the UI, CLI, MCP and
    /// control channel). Mutating commands are undoable; a failed command leaves the document as
    /// it was; a panic inside a command becomes an error.
    pub fn run(&mut self, id: &str, params: &Value) -> Result<Value, CmdError> {
        // The document the command starts in, and the first id a document it opens can have.
        let home = self.document_id;
        let mark = document_id_mark();
        // Every dispatch starts from an unclassified outcome. Early returns (unknown, disabled,
        // protected) leave it at the default.
        self.ime_edit_outcome = ImeEditOutcome::default();
        // A rolled-back transaction must not leave a successful application-change signal from a
        // nested command that ran before the failure.
        let pending_application_change_before = self.pending_ime_application_change;
        let join = std::mem::take(&mut self.join_next);
        // The equation replacement promise is not a generic undo join: only the command that
        // actually types into the equation may consume it. Any other command discards it.
        let equation_join = std::mem::take(&mut self.equation_join_next);
        // The body replacement promise is likewise scoped: only the `text.insert` at the
        // selection the deletion left may consume it.
        let ime_text_join = self.ime_text_join.take();
        let reg = self.registry.clone();
        let Some(spec) = reg.get(id) else { return Err(CmdError::Unknown(id.to_string())) };
        // A forum post runs only the post kit's commands (docs/plans/engine/stage3-forum.md section 3, B1).
        crate::cmd::post::refuse(self, id)?;
        let join = join
            || (equation_join && matches!(id, "equation.type" | "equation.backspace"))
            || (id == "text.insert" && ime_text_join.as_ref().is_some_and(|sel| sel == &self.sel));
        if let Some(why) = (spec.enabled)(self) {
            return Err(CmdError::Disabled(format!("{id}: {why}")));
        }
        // Restrict Editing: refused outright, or allowed as long as it only edits the exceptions.
        let guard = if spec.mutates { crate::cmd::protect::check_before(self, id, params)? } else { false };
        // Quick Parts aren't part of the document, so a refused edit puts them back itself (the Spike).
        let blocks_before = guard.then(|| self.building_blocks.clone());
        if spec.mutates && self.doc.settings.protection.as_deref() == Some("trackedChanges") {
            self.doc.settings.track_changes = true;
        }
        // Macro recording and Repeat.
        let record = !matches!(id, "tools.recordMacro" | "tools.macros" | "edit.undo" | "edit.redo" | "edit.repeat")
            && (spec.mutates || id.starts_with("caret.") || id.starts_with("select."));
        // A password never lands in a recorded macro or Repeat.
        let kept = || {
            let mut p = params.clone();
            if let Some(m) = p.as_object_mut() {
                m.remove("password");
            }
            p
        };
        if record && let Some((_, steps)) = self.recording.as_mut() {
            steps.push((id.to_string(), kept()));
        }
        if spec.mutates && !matches!(id, "edit.undo" | "edit.redo" | "edit.repeat") {
            self.last_command = Some((id.to_string(), kept()));
        }
        // Typing, caret movement and selection outside the equation commands leave the equation.
        self.leave_math_for_command(id);
        // The undo stacks are snapshotted whole, not as a length: commands run nested commands,
        // whose checkpoints, undos and redos (and evictions at the limit) must be put back too.
        let ime_epoch_before = spec.mutates.then_some(self.ime_body_epoch);
        // Commands may leave an equation (a whole-body replacement) even after they fail; put
        // the editing session back with the document.
        let math_before = spec.mutates.then(|| self.math.clone());
        let (light, before_doc) = if spec.mutates { self.run_snapshot(id, params) } else { (None, None) };
        // The formatting waiting at the caret (⌘B with nothing selected): an undo step restores
        // it, so a command that only changes it is an edit.
        let pending_before = spec.mutates.then(|| self.pending.clone());
        // Which document is open. A command that replaces the document (a mail merge) opens a
        // new one, with a new undo history: it is not an edit of this document, whatever the
        // new document holds.
        let document_id_before = self.document_id;
        // Whether the document has unsaved changes, and the revision its layout is keyed on: a
        // command that changes nothing leaves both as they were, and a failed one leaves no
        // trace.
        let dirty_before = spec.mutates.then_some(self.dirty);
        let rev_restore = spec.mutates.then_some(self.rev);
        // These mutating commands can replace the open document and discard its saved versions.
        // Keep the versions until the command and the protected-region post-check have both
        // succeeded; rejected commands must leave the old document and its snapshots together.
        // `mailings.finish` with a path saves the merged copy there and leaves the open
        // document alone, so it replaces nothing.
        let replaces_document = matches!(id, "review.compare" | "review.combine" | "mailings.envelopes" | "mailings.labels")
            || (id == "mailings.finish" && crate::p::str(params, "path").is_none());
        let versions_before = replaces_document.then(|| self.versions.clone());
        let identity_before = replaces_document.then(|| {
            (
                self.path.clone(),
                self.file_name.clone(),
                self.document_id,
                self.password.clone(),
                self.dirty,
                self.bib_style.clone(),
                self.merge.preview,
            )
        });
        let typing = spec.id == "text.insert" || spec.id == "equation.type";
        if spec.mutates && !typing {
            self.typing_open = false;
        }
        // Whether this command pushed an undo step (a no-op command's step is dropped below,
        // leaving its undo group without one).
        let mut pushed = false;
        // Preview Results and its record stepping change the document's merge but take no undo step, as in Word.
        if spec.mutates && !crate::cmd::mailings::PREVIEW_IDS.contains(&id) {
            let label = if typing { "Typing" } else { spec.label };
            // A joined command merges into its group's step; a group whose first command
            // changed nothing has none, so the next command in it starts one (#4001).
            if !join || self.history.is_empty() || !self.join_anchor {
                pushed = self.checkpoint(label);
            }
        } else if !spec.id.starts_with("caret.") && !spec.id.starts_with("view.") {
            // Non-mutating commands other than caret movement keep the typing group.
        } else if spec.id.starts_with("caret.") {
            self.typing_open = false;
        }
        // Only the paste right after a tracked cut makes it a move.
        if (spec.mutates || matches!(id, "edit.undo" | "edit.undoTo" | "edit.redo")) && !matches!(id, "edit.cut" | "edit.paste" | "edit.pasteSpecial")
        {
            self.pending_move = None;
        }
        let sel_before = self.sel.clone();
        // A rejected command must not persist a new proofing default, including a rejection
        // by the protected-region check after its handler has succeeded. Undo stays document-only.
        let default_language_before = self.prefs.default_language.clone();
        let run = spec.run;
        let mutates = spec.mutates;
        let ime_caret_before = self.current_ime_caret_state();
        let rev_before = self.rev;
        // An assistant's command runs tracked under its author from here, after the undo checkpoint, until it returns or
        // panics: the user's settings are back before the checks below read the author.
        let swapped = mutates && self.swap_in_track_as();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::cmd::multi::dispatch(self, id, mutates, run, params)));
        if swapped {
            self.swap_out_track_as();
        }
        self.light_edit_ran();
        let mut result = match result {
            Ok(r) => r,
            Err(p) => {
                let msg = p.downcast_ref::<&str>().map(ToString::to_string).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
                Err(CmdError::Failed(format!("{id} panicked: {msg}")))
            }
        };
        if self.document_id != home || (result.is_err() && self.order.iter().any(|d| *d >= mark)) {
            return self.finish_elsewhere(
                ElsewhereContext { home, mark, before_doc, light, blocks_before, default_language_before, pending_application_change_before },
                result,
            );
        }
        // Restrict Editing: outside the exceptions nothing may change.
        if result.is_ok()
            && guard
            && let Some((before, ..)) = &before_doc
            && !crate::cmd::protect::outside_unchanged(before, &self.doc, self.user_author())
        {
            result = Err(CmdError::Disabled(format!("{id}: only the editable regions of this protected document can change")));
        }
        match &result {
            Ok(_) => self.finish_success(SuccessContext {
                id,
                spec,
                before_doc: &before_doc,
                light: &light,
                pending_before: &pending_before,
                document_id_before,
                replaces_document,
                dirty_before,
                rev_restore,
                pushed,
                mutates,
                ime_caret_before,
                rev_before,
                sel_before: &sel_before,
            }),
            Err(e) => {
                self.ime_edit_outcome = ImeEditOutcome::default();
                self.pending_ime_application_change = pending_application_change_before;
                self.autocap = None;
                self.prefs.default_language = default_language_before;
                if let Some(epoch) = ime_epoch_before {
                    self.ime_body_epoch = epoch;
                }
                if let Some(math) = math_before {
                    self.math = math;
                }
                if let Some(versions) = versions_before {
                    self.versions = versions;
                }
                if let Some((path, file_name, document_id, password, dirty, bib_style, merge_preview)) = identity_before {
                    self.path = path;
                    self.file_name = file_name;
                    self.document_id = document_id;
                    self.password = password;
                    self.dirty = dirty;
                    self.bib_style = bib_style;
                    self.merge.preview = merge_preview;
                }
                if let Some((d, s, h, r, t, ev, c, m)) = before_doc {
                    self.doc = d;
                    self.sel = s;
                    self.history = h;
                    self.redo = r;
                    self.typing_open = t;
                    // The steps the command pushed out are back, so they no longer count as gone.
                    self.undo_evicted = ev;
                    self.column = c;
                    self.multi = m;
                    // Its step is gone with them: its undo group has none to merge into.
                    if pushed {
                        self.join_anchor = false;
                    }
                }
                if light.is_some() && pushed {
                    self.join_anchor = false;
                }
                self.light_edit_failed(light);
                if let Some(dirty) = dirty_before {
                    self.dirty = dirty;
                }
                if let Some(rev) = rev_restore {
                    self.restore_rev(rev);
                    self.edit_path_back_to(rev);
                }
                if let Some(b) = blocks_before {
                    self.building_blocks = b;
                }
                self.status = e.to_string();
            }
        }
        result
    }

    /// What a mutating command keeps to be taken back: a typing key only the blocks it changes and the undo stacks
    /// (session/edit_path.rs), any other command a copy of the document.
    fn run_snapshot(&mut self, id: &str, params: &Value) -> (Option<Light>, Option<RunSnapshot>) {
        // An assistant's key is tracked, which the bounded path does not handle; it sees the user's settings, not the call's.
        if self.track_as.is_none()
            && let Some(light) = self.light_edit(id, params)
        {
            return (Some(light), None);
        }
        let snapshot = (
            self.doc.clone(),
            self.sel.clone(),
            self.history.clone(),
            self.redo.clone(),
            self.typing_open,
            self.undo_evicted,
            self.column.clone(),
            self.multi.clone(),
        );
        (None, Some(snapshot))
    }

    fn finish_success(&mut self, context: SuccessContext<'_>) {
        let SuccessContext {
            id,
            spec,
            before_doc,
            light,
            pending_before,
            document_id_before,
            replaces_document,
            dirty_before,
            rev_restore,
            pushed,
            mutates,
            ime_caret_before,
            rev_before,
            sel_before,
        } = context;
        let mut no_op = false;
        if spec.mutates {
            // Formatting changed while tracking becomes a formatting revision.
            if let Some((before, ..)) = before_doc {
                crate::cmd::fmt_revisions::record(self, id, before);
            }
            // A bounded edit runs in a tidy document and changes paragraphs only: no story or cell empties and no text box
            // loses its shape.
            if light.is_none() {
                self.doc.ensure_nonempty();
                self.doc.prune_text_boxes();
            }
            // Whether the command left the document, the selection and the formatting
            // waiting at the caret as they were. A command that replaces the document —
            // a mail merge, a comparison — is not an edit of this one, whatever the new
            // document holds: `replaces_document` names the commands that may replace
            // it, and `document_id` catches any other that does (through
            // `set_document`, which starts a new history the old one must not overwrite).
            let unchanged = |s: &Session| match (before_doc, light, pending_before) {
                (Some((doc, sel, _, _, _, _, column, _)), _, Some(pending)) => {
                    !replaces_document && s.document_id == document_id_before && s.unchanged(doc, sel, column, pending)
                }
                // Nothing but its blocks can have changed, and it starts with no column selection.
                (None, Some(l), Some(pending)) => {
                    s.document_id == document_id_before && l.unchanged(&s.doc) && s.sel == l.sel && s.column.is_none() && s.pending == *pending
                }
                _ => false,
            };
            let changed = !unchanged(self);
            if changed {
                // The layout the connectors are rerouted against is the new one.
                self.touch();
            }
            // Glued connectors follow the shapes they join.
            let rerouted = crate::cmd::connectors::reroutes_after(id) && crate::cmd::connectors::reroute(self);
            if rerouted {
                self.touch();
            }
            // A command that changed nothing is not an edit (#23): it adds no undo
            // step, marks no unsaved changes, forces no relayout and leaves the redo
            // stack alone. What it left behind is compared with what it started from,
            // after the reroute: a reroute that moved a connector is an edit of its own.
            no_op = !changed && !rerouted && unchanged(self);
            if no_op {
                // The step the dispatch pushed is not an edit: put the stacks back as
                // they were, so the redo stack survives and no step is evicted. The
                // group it belonged to is left without a step of its own, so the next
                // command in it starts one.
                let stacks = before_doc
                    .as_ref()
                    .map(|(_, _, history, redo, typing_open, evicted, _, _)| (history, redo, typing_open, evicted))
                    .or(light.as_ref().map(|l| (&l.stacks.0, &l.stacks.1, &l.stacks.2, &l.stacks.3)));
                if let Some((history, redo, typing_open, evicted)) = stacks {
                    self.history = history.clone();
                    self.redo = redo.clone();
                    self.typing_open = *typing_open;
                    self.undo_evicted = *evicted;
                }
                if let Some(dirty) = dirty_before {
                    self.dirty = dirty;
                }
                if let Some(rev) = rev_restore {
                    let touched = self.rev;
                    self.restore_rev(rev);
                    self.edit_path_back_to(rev);
                    crate::cmd::draw::rekey_lasso(self, touched, rev);
                }
                if pushed {
                    self.join_anchor = false;
                }
            }
        }
        self.clamp_selection();
        let mut ime_outcome = self.ime_edit_outcome;
        if ime_outcome.content_changed {
            ime_outcome.state_changed = true;
        }
        // An unclassified mutating command is conservatively a state change. It can make
        // a frame Other, but it can never mint a receipt because `classified` is false.
        // A command that changed nothing is not an edit (#23), so it is not an IME
        // state change either: otherwise Backspace at the document start would still
        // signal an application change and move the settled IME revision.
        if !ime_outcome.classified && mutates && !no_op {
            ime_outcome.state_changed = true;
        }
        ime_outcome.selection_changed = self.current_ime_caret_state() != ime_caret_before;
        self.ime_edit_outcome = ime_outcome;
        if ime_outcome.state_changed {
            let caret = self.current_ime_caret_state();
            self.ime_state_seen = Some(caret);
            self.reset_ime_state_revision();
        }
        if !self.ime_origin && !no_op && (ime_outcome.content_changed || ime_outcome.state_changed || (!ime_outcome.classified && mutates)) {
            self.pending_ime_application_change = true;
        }
        if sel_before.focus.story == StoryRef::Body && self.in_header_footer() {
            self.hf_return = Some(sel_before.clone());
        }
        // Show Document Text is a header and footer option: however the caret gets back to the body (Close, Esc, a click or a
        // double-click there), the body draws again, as in Word.
        if self.sel.focus.story == StoryRef::Body && !self.view.show_document_text {
            crate::cmd::page::set_show_document_text(self, true);
        }
        // A selection command that moves the insertion point ends the typing group, like
        // caret movement: typing, Select, typing are two undo steps (#419).
        if !spec.mutates && self.sel != *sel_before {
            self.typing_open = false;
        }
        if spec.mutates && !no_op && !matches!(id, "edit.undo" | "edit.redo") {
            self.note_edit();
        }
        // Outline view: collapsed headings follow edits; the caret stays where it shows.
        crate::cmd::outline::after_command(self, sel_before, self.rev != rev_before);
        // Extra selected objects last until something else is edited or selected; formatting
        // them keeps them selected, as in Word.
        if !matches!(id, "select.addObject" | "arrange.ungroup" | "shape.fill" | "shape.effects") && (spec.mutates || self.sel != *sel_before) {
            self.also_selected.clear();
        }
        // Whether the command changed the text of the caret's paragraph, for the word being typed.
        let edited = id.starts_with("text.") && {
            let at = &self.sel.focus;
            let now = self.doc.para_at(at).map(|p| &p.text);
            match (before_doc, light) {
                (Some(b), _) => b.0.para_at(at).map(|p| &p.text) != now,
                (None, Some(l)) => l.old_para(&self.doc, at).map(|p| &p.text) != now,
                _ => false,
            }
        };
        self.note_typing(id, edited, sel_before);
        if spec.mutates {
            self.light_edit_done(light.as_ref());
        }
    }

    /// The end of [`Session::run`] for a command that ended up in another document than it
    /// started in (it opened, made, switched to or closed one) or that failed after opening one.
    /// The checks that compare the document before and after the command don't apply.
    /// Succeeded: the first document loses the undo step made for the command when its text is
    /// as it was (opening a document is no edit to undo there). Failed: the documents the command opened close again and the first document is
    /// active and as it was.
    fn finish_elsewhere(&mut self, context: ElsewhereContext, result: Result<Value, CmdError>) -> Result<Value, CmdError> {
        let ElsewhereContext { home, mark, before_doc, light, blocks_before, default_language_before, pending_application_change_before } = context;
        // Another document is a state change the input method has to see, never an IME edit.
        self.ime_edit_outcome = ImeEditOutcome::default();
        match &result {
            Ok(_) => {
                self.put_back_parked(home, before_doc);
                self.clamp_selection();
                self.ime_state_seen = Some(self.current_ime_caret_state());
                self.reset_ime_state_revision();
                if !self.ime_origin {
                    self.pending_ime_application_change = true;
                }
            }
            Err(e) => {
                self.pending_ime_application_change = pending_application_change_before;
                self.autocap = None;
                self.prefs.default_language = default_language_before;
                if self.is_open(home) {
                    let _ = self.switch_to(home);
                    let opened: Vec<u64> = self.order.iter().copied().filter(|d| *d >= mark && *d != home).collect();
                    for d in opened {
                        let _ = self.close_document(d);
                    }
                    if let Some((d, s, h, r, t, ev, c, m)) = before_doc {
                        self.doc = d;
                        self.sel = s;
                        self.history = h;
                        self.redo = r;
                        self.typing_open = t;
                        self.undo_evicted = ev;
                        self.column = c;
                        self.multi = m;
                    }
                    self.light_edit_failed(light);
                }
                if let Some(b) = blocks_before {
                    self.building_blocks = b;
                }
                self.status = e.to_string();
            }
        }
        result
    }
}

impl Session {
    /// Runs `steps` (command id, params) in order as one undo step, labelled by the first that records one: a composite
    /// command such as a text box preset or a picture with its wrap (the wasm host's `execMany`, docs/plans/engine/stage2.md
    /// G9). A step that fails takes back the steps before it, the selection included, and its index comes back with its
    /// error; each step's own checks (enabled, protection) apply as for [`Session::run`].
    pub fn run_many(&mut self, steps: &[(String, Value)]) -> Result<Vec<Value>, (usize, CmdError)> {
        // Typing still open would take the first step into its own undo step.
        self.close_typing();
        let mark = self.undo_mark();
        let sel = self.sel.clone();
        let mut out = Vec::with_capacity(steps.len());
        for (i, (id, params)) in steps.iter().enumerate() {
            match self.run(id, params) {
                Ok(v) => out.push(v),
                Err(e) => {
                    self.merge_undo_since(mark);
                    if self.undo_mark() > mark && self.undo() {
                        self.redo.pop();
                    }
                    self.sel = sel;
                    return Err((i, e));
                }
            }
        }
        self.merge_undo_since(mark);
        Ok(out)
    }

    /// Runs `steps` as [`Session::run_many`] does, as one undo step, tracked as changes by `author` (an assistant,
    /// docs/plans/engine/stage2b.md decision 4): each command runs with Track Changes and Track Formatting on, overtype off and
    /// typing replacing the selection, under `author`, and the revisions it makes carry `tag` and never join one made before
    /// the call. The user's author, Track Changes and typing settings never change, the undo step holds them, and the user's
    /// selection and the formatting waiting at the caret are put back (mapped through the call's edits). Restrict Editing
    /// reads the user's author. Refused: a document changed since revision `if_rev` (the caller's read is stale), and a step
    /// that changed the document with no revision (an edit tracking does not record), which takes the call back.
    /// → each step's value and the ids of the revisions the call made; an error names the failing step when there is one.
    pub fn run_as(
        &mut self,
        author: &str,
        tag: Option<&str>,
        steps: &[(String, Value)],
        if_rev: Option<u64>,
    ) -> Result<(Vec<Value>, Vec<u32>), (Option<usize>, CmdError)> {
        if if_rev.is_some_and(|r| r != self.rev) {
            return Err((None, CmdError::Failed("stale: the document changed since it was read".into())));
        }
        if self.track_as.is_some() {
            return Err((None, CmdError::Failed("an assistant's call is already running".into())));
        }
        let author = crate::cmd::file::normalize_author(author).map_err(|e| (None, e))?;
        // A join left by the user's last command (a drag, a composition) must not take the call into the user's undo step.
        self.join_next = false;
        self.clear_ime_joins();
        self.close_typing();
        let kept = crate::cmd::agents::Kept::of(self);
        let first = self.doc.revisions.len();
        self.track_as = Some(TrackAs { author, tag: tag.map(str::to_string), first, taken: 0, user: None });
        let mark = self.undo_mark();
        let home = self.document_id;
        let mut out = Vec::with_capacity(steps.len());
        let mut failed = None;
        for (i, (id, params)) in steps.iter().enumerate() {
            let (rev, taken) = (self.rev, self.track_as.as_ref().map_or(0, |t| t.taken));
            match self.run(id, params) {
                // A call stays in the document it edits: one that opened or switched to another goes back and is refused.
                Ok(_) if self.document_id != home => {
                    let _ = self.switch_to(home);
                    failed = Some((i, CmdError::Disabled(format!("{id}: an assistant's call cannot open or switch documents"))));
                    break;
                }
                // A later step addresses blocks by the ids this one left (`select.at`).
                Ok(v) => {
                    self.note_ids();
                    if self.rev != rev && self.track_as.as_ref().is_some_and(|t| t.taken == taken) {
                        failed = Some((i, CmdError::Disabled(format!("{id}: the assistant cannot make this change as a suggestion"))));
                        break;
                    }
                    out.push(v);
                }
                Err(e) => {
                    failed = Some((i, e));
                    break;
                }
            }
        }
        self.track_as = None;
        self.merge_undo_since(mark);
        // The user's next key starts an undo step of its own, even after a call that ended typing.
        self.close_typing();
        if let Some((i, e)) = failed {
            if self.undo_mark() > mark && self.undo() {
                self.redo.pop();
            }
            kept.restore(self);
            self.status = e.to_string();
            return Err((Some(i), e));
        }
        kept.restore(self);
        Ok((out, (first..self.doc.revisions.len()).map(|r| r as u32).collect()))
    }

    /// Swaps an assistant call's settings in for its command (see [`TrackAs`]) → whether it did: not outside a call, nor for a
    /// command another one runs (the outer one swapped already).
    fn swap_in_track_as(&mut self) -> bool {
        let Some(t) = self.track_as.as_mut().filter(|t| t.user.is_none()) else { return false };
        let m = &mut self.prefs.markup;
        t.user = Some(UserSettings {
            author: std::mem::replace(&mut self.author, t.author.clone()),
            track_changes: std::mem::replace(&mut self.doc.settings.track_changes, true),
            track_formatting: std::mem::replace(&mut m.track_formatting, true),
            overtype: std::mem::replace(&mut self.prefs.overtype, false),
            replaces_selection: std::mem::replace(&mut self.prefs.typing_replaces_selection, true),
        });
        true
    }

    /// Puts the user's settings back after an assistant's command, whatever the command did to them.
    fn swap_out_track_as(&mut self) {
        let Some(u) = self.track_as.as_mut().and_then(|t| t.user.take()) else { return };
        self.author = u.author;
        self.doc.settings.track_changes = u.track_changes;
        self.prefs.markup.track_formatting = u.track_formatting;
        self.prefs.overtype = u.overtype;
        self.prefs.typing_replaces_selection = u.replaces_selection;
    }

    /// The user's own author, also while an assistant's command runs under its own: whose Restrict Editing exceptions apply.
    pub(crate) fn user_author(&self) -> &str {
        self.track_as.as_ref().and_then(|t| t.user.as_ref()).map_or(&self.author, |u| &u.author)
    }

    /// While an assistant's call runs: the first revision a new one may join (none older than the call) and the tag new ones
    /// carry. Outside one: 0 and no tag.
    pub(crate) fn revision_scope(&self) -> (usize, Option<String>) {
        self.track_as.as_ref().map_or((0, None), |t| (t.first, t.tag.clone()))
    }

    /// A command of an assistant's call took a revision (new or joined).
    pub(crate) fn took_revision(&mut self) {
        if let Some(t) = self.track_as.as_mut() {
            t.taken += 1;
        }
    }

    /// The author an assistant's call runs as, while one runs: its formatting changes are recorded under it after each command
    /// (fmt_revisions.rs), once the user's settings are back.
    pub(crate) fn assistant(&self) -> Option<&str> {
        self.track_as.as_ref().map(|t| t.author.as_str())
    }
}
