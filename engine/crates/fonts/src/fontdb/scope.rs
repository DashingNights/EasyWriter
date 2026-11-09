//! Which loaded faces one document's character fallback may use (EasyWriter patch, viewport-design.md section 8, P4). The
//! worker keeps several documents in one font database, and a character a document's own fonts lack fell back to the best
//! loaded face that covered it: whatever another document had loaded counted too, so the same document laid out one way
//! alone and another after other documents. While a scope is current (the wasm host enters its session's scope at every
//! call), fallback looks only at the compiled-in faces, the families the document asked for by name (word::resolve), and
//! for each script the first loaded family of the app's list for it ([`set_script_fonts`]). The document reports a script
//! its named fonts do not cover once, so the app loads that list's first font it has whatever ran before, and every other
//! loaded font is out of reach. Ties are broken by name instead of load order.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use super::face::{FontBytes, FontFace};
use super::{Arc, FontDb};

#[derive(Default)]
struct Scope {
    /// The families the document asked for, as asked (compared without ASCII case, as face names are).
    named: Vec<String>,
    /// The scripts reported for this document (each once).
    reported: Vec<&'static str>,
    /// Bumped when `named` grows, so fallbacks cached for the scope are not reused.
    version: u32,
    /// A fallback ran in this scope since the last [`font_scope_grew`].
    fell_back: bool,
    /// `named` grew after a fallback: paragraphs laid out before may fall back differently now.
    grew: bool,
}

thread_local! {
    static SCOPES: RefCell<HashMap<u64, Scope>> = RefCell::new(HashMap::new());
    static CURRENT: Cell<Option<u64>> = const { Cell::new(None) };
    /// The app's fonts for each script (ISO 15924 code → families, first available wins), as its font provider loads them.
    static SCRIPT_FONTS: RefCell<HashMap<String, Vec<String>>> = RefCell::new(HashMap::new());
}

/// Makes `id`'s scope the current one (a new, empty one the first time).
pub fn enter_font_scope(id: u64) {
    SCOPES.with(|s| {
        s.borrow_mut().entry(id).or_default();
    });
    CURRENT.with(|c| c.set(Some(id)));
}

/// Forgets `id`'s scope (its session closed).
pub fn drop_font_scope(id: u64) {
    SCOPES.with(|s| s.borrow_mut().remove(&id));
    CURRENT.with(|c| {
        if c.get() == Some(id) {
            c.set(None);
        }
    });
}

/// Whether the current scope named a new family after it fell back since the last call: the host then lays the paragraphs
/// that fell back out again ([`FontDb::scope_changed`]), so a paragraph laid out before a later one named a font does not
/// keep a fallback the finished layout would not choose.
pub fn font_scope_grew() -> bool {
    current(|s| std::mem::take(&mut s.grew)).unwrap_or(false)
}

/// Sets the app's fallback families per script (`[(code, families)]`, its font provider's list).
pub fn set_script_fonts(lists: Vec<(String, Vec<String>)>) {
    SCRIPT_FONTS.with(|m| *m.borrow_mut() = lists.into_iter().collect());
}

/// The current scope's families, as its document asked for them, and the scripts reported for it: what a second worker loads
/// so that the document falls back there as it does here (the helper worker's PDF, viewport-design.md section 8).
pub fn font_scope_names() -> (Vec<String>, Vec<&'static str>) {
    current(|s| (s.named.clone(), s.reported.clone())).unwrap_or_default()
}

fn current<R>(f: impl FnOnce(&mut Scope) -> R) -> Option<R> {
    let id = CURRENT.with(Cell::get)?;
    SCOPES.with(|s| s.borrow_mut().get_mut(&id).map(f))
}

/// Notes that the document of the current scope asks for `family` (word::resolve).
pub(crate) fn note_named(family: &str) {
    let f = family.trim();
    if f.is_empty() {
        return;
    }
    current(|s| {
        if !s.named.iter().any(|n| n.eq_ignore_ascii_case(f)) {
            s.named.push(f.to_string());
            s.version = s.version.wrapping_add(1);
            s.grew |= s.fell_back;
        }
    });
}

/// Which faces a fallback may use, with the class each ranks in: compiled-in 0, named by the document 1, its script's
/// font 2. Faces it does not list are out of reach.
pub(super) struct Eligible {
    named: Vec<String>,
    scripts: Vec<String>,
}

impl Eligible {
    pub(super) fn class(&self, f: &FontFace) -> Option<u8> {
        if matches!(f.bytes, FontBytes::Static(_)) {
            return Some(0);
        }
        let is = |n: &str| f.named(n) || f.local_names.iter().any(|l| l.name.eq_ignore_ascii_case(n));
        if self.named.iter().any(|n| is(n)) {
            Some(1)
        } else if self.scripts.iter().any(|n| is(n)) {
            Some(2)
        } else {
            None
        }
    }

    /// The sort key that ends a scoped fallback order: the class, then the name, so two faces that tie on everything
    /// else rank the same whatever order they loaded in. Compiled-in faces keep their order (they always load first).
    pub(super) fn tie(&self, f: &FontFace) -> (u8, String, String) {
        let class = self.class(f).unwrap_or(u8::MAX);
        if class == 0 { (0, String::new(), String::new()) } else { (class, f.family.to_lowercase(), f.style.to_lowercase()) }
    }
}

impl FontDb {
    /// The current scope's key for the fallback caches, or None when no scope applies (every loaded face may be used).
    /// Natively a scope applies only with the system fallback off: there a search loads installed fonts by itself.
    pub(super) fn scope_key(&self) -> Option<(u64, u32)> {
        #[cfg(not(target_arch = "wasm32"))]
        if self.sys.lock().unwrap_or_else(std::sync::PoisonError::into_inner).enabled {
            return None;
        }
        let id = CURRENT.with(Cell::get)?;
        SCOPES.with(|s| s.borrow().get(&id).map(|sc| (id, sc.version)))
    }

    /// What a fallback for `chars` may use in the current scope, or None without one. Takes the faces lock: call it before
    /// holding that lock. Also notes the scope fell back.
    pub(super) fn eligible(&self, chars: &[char]) -> Option<Eligible> {
        self.scope_key()?;
        let named = current(|s| {
            s.fell_back = true;
            s.named.clone()
        })?;
        let mut scripts = Vec::new();
        SCRIPT_FONTS.with(|m| {
            let m = m.borrow();
            for c in chars {
                let Some(list) = super::changes::script_of(*c).and_then(|code| m.get(code)) else { continue };
                if let Some(first) = list.iter().find(|f| self.is_loaded(f))
                    && !scripts.contains(first)
                {
                    scripts.push(first.clone());
                }
            }
        });
        Some(Eligible { named, scripts })
    }

    /// Reports the scripts of `chars` that no compiled-in or named face covers, once per scope, so the app loads the
    /// script's font for this document whatever other documents loaded. Takes the faces lock.
    pub(super) fn report_scripts(&self, chars: &[char], ok: &Eligible, exclude: u32) {
        let faces = self.read_faces();
        let covered = |c: char| faces.iter().any(|f| f.id != exclude && ok.class(f).is_some_and(|k| k < 2) && f.covers(c));
        let wanted: Vec<&'static str> = chars.iter().filter(|c| !covered(**c)).filter_map(|c| super::changes::script_of(*c)).collect();
        drop(faces);
        for code in wanted {
            if current(|s| (!s.reported.contains(&code)).then(|| s.reported.push(code)).is_some()) == Some(true) {
                self.queue_script(code);
            }
        }
    }

    /// The current scope named a family after it fell back: paragraphs that fell back lay out again at the next layout.
    pub fn scope_changed(&self) {
        self.fonts_changed();
    }
}

/// The faces of `faces` a scoped fallback may use, or all of them without a scope.
pub(super) fn reachable<'a>(faces: &'a [Arc<FontFace>], ok: Option<&Eligible>) -> impl Iterator<Item = &'a Arc<FontFace>> {
    faces.iter().filter(move |f| ok.is_none_or(|e| e.class(f).is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Liberation Sans, the app's open stand-in for Arial: it has Hebrew, which no compiled-in face has.
    fn liberation() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/vendor/fonts/liberation/LiberationSans-Regular.ttf")).unwrap_or_default()
    }

    /// A document's fallback picks the same face alone and after another document loaded a font that covers its text.
    #[test]
    fn fallback_ignores_fonts_other_documents_loaded() {
        let bytes = liberation();
        if bytes.is_empty() {
            return; // a checkout without the app's open fonts
        }
        let db = FontDb::with_font_dirs(Vec::new());
        db.set_system_fallback(false);
        let hebrew = '\u{05D0}';
        let family = |f: Option<Arc<FontFace>>| f.map(|f| f.family.clone());
        // Document 1 alone: no loaded face covers Hebrew.
        enter_font_scope(901);
        note_named("Body Font");
        let alone = family(db.fallback_for(hebrew, u32::MAX));
        assert_eq!(alone, None);
        // Document 2 names Liberation Sans and it loads: its Hebrew falls back to it.
        enter_font_scope(902);
        note_named("Liberation Sans");
        assert!(db.add_font(bytes) > 0);
        assert_eq!(family(db.fallback_for(hebrew, u32::MAX)).as_deref(), Some("Liberation Sans"));
        // Document 1 again: the other document's font is out of its reach.
        enter_font_scope(901);
        assert_eq!(family(db.fallback_for(hebrew, u32::MAX)), alone);
        // Its script's font is in reach once the app names it for the script, as when the app loads it for document 1.
        set_script_fonts(vec![("Hebr".into(), vec!["Liberation Sans".into()])]);
        db.scope_changed();
        assert_eq!(family(db.fallback_for(hebrew, u32::MAX)).as_deref(), Some("Liberation Sans"));
        drop_font_scope(901);
        drop_font_scope(902);
        set_script_fonts(Vec::new());
    }
}
