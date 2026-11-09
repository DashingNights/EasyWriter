//! Which families changed, and which a lookup missed (an EasyWriter patch, CHANGES.md). In the
//! browser the database starts with only the bundled faces and the app adds a document's fonts
//! after the first layout, as their bytes arrive. Layout then asks [`FontDb::family_generation`]
//! for the families a paragraph names, so only the paragraphs set in a family that changed lay out
//! again, and the app asks [`FontDb::take_missing_families`] which families to fetch.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::MutexGuard;

use super::FontDb;

/// The name [`track_families`] reports for "fell back to whatever face covers a character": it
/// changes with every font added, since any new face may cover it.
pub const FALLBACK_USE: &str = "\u{0}fallback";

thread_local! {
    /// The families asked about while [`track_families`] runs on this thread, lowercased.
    static USED: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

/// Runs `f` and returns the font families it asked the database about (by name, and
/// [`FALLBACK_USE`] when it fell back for characters its fonts lack), lowercased, each once. A
/// layout cache stores them with a paragraph's layout and lays the paragraph out again when
/// [`FontDb::family_generation`] of one of them moves past the generation it was made at. Nested
/// calls also count toward the outer one.
pub fn track_families<R>(f: impl FnOnce() -> R) -> (R, Vec<String>) {
    let outer = USED.with(|u| u.borrow_mut().replace(Vec::new()));
    let r = f();
    let inner = USED.with(|u| std::mem::replace(&mut *u.borrow_mut(), outer)).unwrap_or_default();
    if !inner.is_empty() {
        USED.with(|u| {
            if let Some(o) = u.borrow_mut().as_mut() {
                for f in &inner {
                    if !o.contains(f) {
                        o.push(f.clone());
                    }
                }
            }
        });
    }
    (r, inner)
}

/// Note `family` as asked about, when [`track_families`] is running.
pub(crate) fn note_used(family: &str) {
    USED.with(|u| {
        if let Some(v) = u.borrow_mut().as_mut() {
            let f = family.trim();
            if !v.iter().any(|x| x.eq_ignore_ascii_case(f)) {
                v.push(f.to_ascii_lowercase());
            }
        }
    });
}

/// The ISO 15924 code of the script whose fallback font draws `c`, for the scripts the app has
/// fonts for. ponytail: Han is reported as Traditional Chinese (the user writes Cantonese); the
/// run's language would tell Hans from Hant.
pub(super) fn script_of(c: char) -> Option<&'static str> {
    Some(match c as u32 {
        0x3040..=0x30FF | 0x31F0..=0x31FF => "Jpan",
        0x2E80..=0x2FDF | 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF => "Hant",
        0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => "Kore",
        0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => "Arab",
        0x0590..=0x05FF => "Hebr",
        0x0E00..=0x0E7F => "Thai",
        0x0900..=0x097F => "Deva",
        _ => return None,
    })
}

/// More missing families than this are not remembered: a document naming thousands of fonts
/// still gets its first ones fetched, without the list growing without bound.
const MAX_MISSING: usize = 4096;

/// A family drawn with a stand-in, as [`FontDb::take_missing_families`] reports it to the app.
#[derive(Clone, Debug, PartialEq)]
pub struct MissingFamily {
    /// The family as the document names it.
    pub family: String,
    /// The family it is drawn in now.
    pub stand_in: &'static str,
    /// The fonts it would be drawn in, first loaded wins: the app supplies the first one it has, and the stand-in moves to it.
    pub stand_ins: Vec<&'static str>,
}

#[derive(Default)]
pub(crate) struct Changes {
    /// Families whose faces were added or removed since the last change was recorded.
    pub(super) pending: Vec<String>,
    /// The generation each family last changed at, by lowercased name.
    at: HashMap<String, u64>,
    /// Families a lookup asked for that resolved to a stand-in, lowercased → (as asked, the stand-in
    /// word::resolve chose, and whether the caller fixed it: [`FontDb::note_missing_fixed`]).
    missing: HashMap<String, (String, &'static str, bool)>,
    /// Missing families not yet taken by [`FontDb::take_missing_families`], in the order asked.
    unreported: Vec<String>,
    /// Scripts with a character no loaded face covers, each noted once ([`FontDb::take_missing_scripts`]).
    scripts: Vec<&'static str>,
    scripts_taken: usize,
}

impl FontDb {
    fn changes(&self) -> MutexGuard<'_, Changes> {
        self.changes.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The [`FontDb::generation`] at which `family` (any case) last changed: faces of it were
    /// added or removed, or it was missing when other faces arrived (its stand-in may be another
    /// now). 0 when it never changed. A layout cache keyed on it keeps every paragraph set in
    /// other families when a font arrives.
    pub fn family_generation(&self, family: &str) -> u64 {
        self.changes().at.get(&family.trim().to_ascii_lowercase()).copied().unwrap_or(0)
    }

    /// The families lookups asked for and resolved to a stand-in since the last call, each once,
    /// in the order asked: the fonts the app should supply, with the stand-ins Word's substitution
    /// picks from. A family stays known as missing (and is not reported again) until faces of it
    /// are added.
    pub fn take_missing_families(&self) -> Vec<MissingFamily> {
        let mut c = self.changes();
        let keys = std::mem::take(&mut c.unreported);
        keys.iter().filter_map(|k| c.missing.get(&k.to_ascii_lowercase()).map(missing_family)).collect()
    }

    /// The scripts that had a character no loaded face covers since the last call, each once
    /// (ISO 15924 codes): the app supplies a fallback font for each.
    pub fn take_missing_scripts(&self) -> Vec<&'static str> {
        let mut c = self.changes();
        let new = c.scripts[c.scripts_taken..].to_vec();
        c.scripts_taken = c.scripts.len();
        new
    }

    /// The families that resolve to a stand-in now: asked for, and none of their own faces loaded.
    pub fn missing_families(&self) -> Vec<MissingFamily> {
        let mut v: Vec<MissingFamily> = self.changes().missing.values().map(missing_family).collect();
        v.sort_by(|a, b| a.family.cmp(&b.family));
        v
    }

    /// Remember that no loaded face covers `c` (fallback_styled).
    pub(super) fn note_missing_script(&self, c: char) {
        if let Some(s) = script_of(c) {
            let mut ch = self.changes();
            if !ch.scripts.contains(&s) {
                ch.scripts.push(s);
            }
        }
    }

    /// Queue `script` for [`FontDb::take_missing_scripts`] again (a scoped document needs it: scope.rs), once until taken.
    pub(super) fn queue_script(&self, script: &'static str) {
        let mut ch = self.changes();
        let from = ch.scripts_taken;
        if !ch.scripts[from..].contains(&script) {
            ch.scripts.push(script);
        }
    }

    /// Remember that `family` resolved to `stand_in` (word::resolve).
    pub(crate) fn note_missing(&self, family: &str, stand_in: &'static str) {
        self.remember_missing(family, stand_in, false);
    }

    /// Report `family` as missing where the caller draws it in `stand_in`, a font of its own
    /// choosing (layout's missing roman font, drawn in Cambria): it changes only when its own faces
    /// arrive.
    pub fn note_missing_fixed(&self, family: &str, stand_in: &'static str) {
        self.remember_missing(family, stand_in, true);
    }

    fn remember_missing(&self, family: &str, stand_in: &'static str, fixed: bool) {
        let name = family.trim();
        if name.is_empty() {
            return;
        }
        let mut c = self.changes();
        let key = name.to_ascii_lowercase();
        if c.missing.len() < MAX_MISSING && !c.missing.contains_key(&key) {
            c.missing.insert(key, (name.to_string(), stand_in, fixed));
            c.unreported.push(name.to_string());
        }
    }

    /// Record the families changed at `generation`: the pending ones, the missing ones whose own
    /// faces arrived (missing no more) or whose stand-in is another now, and [`FALLBACK_USE`].
    pub(super) fn record_change(&self, generation: u64) {
        let missing: Vec<(String, String, &'static str, bool)> = {
            let mut c = self.changes();
            let pending = std::mem::take(&mut c.pending);
            for f in pending.iter().map(|f| f.trim().to_ascii_lowercase()) {
                c.at.insert(f, generation);
            }
            c.at.insert(FALLBACK_USE.to_string(), generation);
            c.missing.iter().map(|(k, (name, s, fixed))| (k.clone(), name.clone(), *s, *fixed)).collect()
        };
        // Checked outside the lock: both take the faces lock.
        let mut found = Vec::new();
        let mut moved = Vec::new();
        for (key, name, was, fixed) in missing {
            if self.is_loaded(&name) {
                found.push(key);
            } else if !fixed {
                let now = crate::word::stand_in(self, &name);
                if now != was {
                    moved.push((key, now));
                }
            }
        }
        let mut c = self.changes();
        for f in &found {
            c.missing.remove(f);
            c.at.insert(f.clone(), generation);
        }
        for (key, now) in moved {
            c.at.insert(key.clone(), generation);
            if let Some(m) = c.missing.get_mut(&key) {
                m.1 = now;
            }
        }
        if !found.is_empty() {
            c.unreported.retain(|u| !found.contains(&u.to_ascii_lowercase()));
        }
    }
}

fn missing_family((family, stand_in, fixed): &(String, &'static str, bool)) -> MissingFamily {
    let stand_ins = if *fixed { vec![*stand_in] } else { crate::word::stand_ins(family).to_vec() };
    MissingFamily { family: family.clone(), stand_in, stand_ins }
}

#[cfg(test)]
mod tests {
    use super::{FontDb, MissingFamily};

    fn names(v: Vec<MissingFamily>) -> Vec<String> {
        v.into_iter().map(|m| m.family).collect()
    }

    /// JetBrains Mono (bundled) renamed to `name` (14 characters), so adding it adds a family.
    fn renamed(name: &str) -> Vec<u8> {
        assert_eq!(name.len(), 14);
        let mut data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/JetBrainsMono-Regular.ttf")).unwrap();
        let utf16 = |s: &str| s.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<u8>>();
        for (from, to) in [(utf16("JetBrains Mono"), utf16(name)), (b"JetBrains Mono".to_vec(), name.as_bytes().to_vec())] {
            while let Some(at) = data.windows(from.len()).position(|w| w == from) {
                data[at..at + to.len()].copy_from_slice(&to);
            }
        }
        data
    }

    #[test]
    fn adding_a_font_changes_only_its_family() {
        let db = FontDb::with_font_dirs(vec![]);
        db.set_system_fallback(false);
        let before = db.generation();
        assert_eq!(db.family_generation("Engine Fonts A"), 0);
        assert!(db.add_font(renamed("Engine Fonts A")) > 0);
        assert!(db.generation() > before, "a lookup memoised before the font arrived must not stay");
        assert_eq!(db.family_generation("engine fonts a"), db.generation());
        assert_eq!(db.family_generation("Source Serif 4"), 0, "paragraphs in other families keep their layout");
        // The same bytes again add nothing and change nothing.
        let now = db.generation();
        assert_eq!(db.add_font(renamed("Engine Fonts A")), 0);
        assert_eq!(db.generation(), now);
    }

    #[test]
    fn missing_families_are_reported_once_until_they_arrive() {
        let db = FontDb::with_font_dirs(vec![]);
        db.set_system_fallback(false);
        let stand_in = |f: &str| crate::word::stand_in(&db, f);
        db.note_missing("Engine Fonts B", stand_in("Engine Fonts B"));
        db.note_missing("engine fonts b", stand_in("Engine Fonts B"));
        // As if C had been laid out when its stand-in was another font.
        db.note_missing("Engine Fonts C", "Not The Stand-in");
        let taken = db.take_missing_families();
        assert_eq!(names(taken.clone()), ["Engine Fonts B", "Engine Fonts C"]);
        assert_eq!(taken[0].stand_in, stand_in("Engine Fonts B"));
        assert_eq!(taken[0].stand_ins, crate::word::stand_ins("Engine Fonts B"));
        assert!(db.take_missing_families().is_empty());
        // A font that is no family's stand-in leaves B's text alone; C's stand-in differs now.
        assert!(db.add_font(renamed("Engine Fonts D")) > 0);
        assert_eq!(db.family_generation("Engine Fonts B"), 0);
        assert_eq!(db.family_generation("Engine Fonts C"), db.generation());
        // B's own faces arrive: it is no longer missing, so it is not reported again.
        assert!(db.add_font(renamed("Engine Fonts B")) > 0);
        assert_eq!(db.family_generation("Engine Fonts B"), db.generation());
        assert_eq!(names(db.missing_families()), ["Engine Fonts C"]);
        assert!(db.add_font(renamed("Engine Fonts E")) > 0);
        assert!(db.family_generation("Engine Fonts B") < db.generation());
        assert!(db.family_generation("Engine Fonts C") < db.generation(), "the same stand-in as at the last change");
        db.note_missing("Engine Fonts C", stand_in("Engine Fonts C"));
        assert!(db.take_missing_families().is_empty());
        // A family the caller draws in its own stand-in is reported, and changes only when it arrives.
        db.note_missing_fixed("Engine Fonts I", "Cambria");
        let fixed = db.take_missing_families();
        assert_eq!((fixed[0].family.as_str(), fixed[0].stand_in, fixed[0].stand_ins.as_slice()), ("Engine Fonts I", "Cambria", &["Cambria"][..]));
        assert!(db.add_font(renamed("Engine Fonts J")) > 0);
        assert_eq!(db.family_generation("Engine Fonts I"), 0);
        assert!(db.add_font(renamed("Engine Fonts I")) > 0);
        assert_eq!(db.family_generation("Engine Fonts I"), db.generation());
        assert_eq!(names(db.missing_families()), ["Engine Fonts C"]);
    }

    #[test]
    fn tracking_notes_the_families_asked_about_nested_ones_too() {
        let db = FontDb::with_font_dirs(vec![]);
        let ((_, inner), outer) = super::track_families(|| {
            db.has_family("Engine Fonts F");
            super::track_families(|| {
                db.has_family("engine fonts f");
                db.has_family("Engine Fonts G");
            })
        });
        assert_eq!(inner, ["engine fonts f", "engine fonts g"]);
        assert_eq!(outer, ["engine fonts f", "engine fonts g"]);
        // Outside tracking nothing is kept.
        db.has_family("Engine Fonts H");
        assert!(super::track_families(|| ()).1.is_empty());
    }

    #[test]
    fn a_character_nothing_covers_reports_its_script_once() {
        let db = FontDb::with_font_dirs(vec![]);
        db.set_system_fallback(false);
        let (_, used) = super::track_families(|| {
            db.fallback_for('\u{AC00}', u32::MAX);
            db.fallback_for('\u{AC01}', u32::MAX);
        });
        assert_eq!(used, [super::FALLBACK_USE]);
        assert_eq!(db.take_missing_scripts(), ["Kore"]);
        assert!(db.take_missing_scripts().is_empty());
    }

    #[test]
    fn word_resolution_reports_a_missing_family() {
        let r = crate::word::resolve("Engine Fonts Zz Unknown", false, false);
        assert!(r.substituted);
        assert!(FontDb::global().take_missing_families().iter().any(|f| f.family == "Engine Fonts Zz Unknown"));
    }
}
