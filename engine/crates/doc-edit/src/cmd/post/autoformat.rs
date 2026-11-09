//! The forum post's Markdown input rules (docs/plans/engine/stage3-forum.md section 3, B2): StarterKit's rules
//! (SPEC.md line 628), run after the character that triggers them, as one undo step each, and never inside a code block.
//!
//! The patterns are the ones the installed @tiptap 3.31 extensions define, so a post typed on the engine formats as the
//! DOM editor formats it: a heading from `# ` to `###### `, a bullet list from `- `, `* ` or `+ `, an ordered list from
//! `1. ` with its typed number, a quote from `> `, a code block from a backtick or tilde fence with its language, a rule
//! from `---`, `—-`, `___ ` or `*** `, and bold, italic, strike and inline code from their mark pairs.

use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::json;
use ew_doc::post;
use ew_doc::props::NumRef;
use ew_doc::section::NumFormat;
use ew_doc::{Block, ContainerRole, Paragraph, StoryRef};
use ew_doc::Pos;

use crate::{CmdError, Session, Selection};

/// StarterKit's input-rule patterns, compiled once.
struct Rules {
    heading: Regex,
    bullet: Regex,
    ordered: Regex,
    quote: Regex,
    fences: [Regex; 2],
    rule: Regex,
    bold: [Regex; 2],
    italic: [Regex; 2],
    strike: Regex,
    code: Regex,
}

fn rules() -> Option<&'static Rules> {
    static RULES: OnceLock<Option<Rules>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let re = |p: &str| Regex::new(p).ok();
            Some(Rules {
                heading: re(r"^(#{1,6})\s$")?,
                bullet: re(r"^\s*([-+*])\s$")?,
                ordered: re(r"^([0-9]+)\.\s$")?,
                quote: re(r"^\s*>\s$")?,
                fences: [re(r"^```([a-z]+)?[\s\n]$")?, re(r"^~~~([a-z]+)?[\s\n]$")?],
                rule: re(r"^(?:---|—-|___\s|\*\*\*\s)$")?,
                // Tiptap's `(?!\s+\*\*)` pair guards become [`pair`]'s check: Rust's regex has no look-ahead.
                bold: [re(r"(?:^|\s)(\*\*([^*]+)\*\*)$")?, re(r"(?:^|\s)(__([^_]+)__)$")?],
                italic: [re(r"(?:^|\s)(\*([^*]+)\*)$")?, re(r"(?:^|\s)(_([^_]+)_)$")?],
                strike: re(r"(?:^|\s)(~~([^~]+)~~)$")?,
                code: re(r"`([^`]+)`$")?,
            })
        })
        .as_ref()
}

/// Run the rule the just-typed character triggers, if any: `true` when it rewrote the paragraph. A post outside its profile,
/// with AutoFormat off, with a range selected, or with the caret in a code block or beside inline code runs no rule.
pub(crate) fn typed(s: &mut Session) -> Result<bool, CmdError> {
    if s.doc.settings.profile.as_deref() != Some(post::PROFILE)
        || !s.prefs.autocorrect.enabled
        || !s.sel.is_collapsed()
        || super::container::in_code(s)
    {
        return Ok(false);
    }
    let f = s.sel.focus.clone();
    let Some(before) = s.doc.para_at(&f).and_then(|p| p.text.get(..f.off)).map(str::to_string) else { return Ok(false) };
    let before = before.as_str();
    let Some(r) = rules() else { return Ok(false) };
    // Tiptap refuses every rule while the text beside the caret has the code mark (`run` in @tiptap/core).
    if beside_code(s, &f) {
        return Ok(false);
    }
    if block_rules(s, r, &f, before)? {
        return Ok(true);
    }
    mark_rules(s, r, &f, before)
}

/// The block rules: heading, list, quote, code fence and rule.
fn block_rules(s: &mut Session, r: &Rules, f: &Pos, before: &str) -> Result<bool, CmdError> {
    // A list item's first paragraph must stay a paragraph (`listItem` content is `paragraph block*`), so Tiptap's heading,
    // list, quote and fence handlers bail out there. Its rule is fitted after the paragraph instead.
    let numbered = s.doc.para_at(f).is_some_and(|p| p.props.numbering.is_some_and(|n| n.num != 0));
    if !numbered && let Some(level) = r.heading.captures(before).and_then(|c| u8::try_from(c[1].len()).ok()) {
        return block_change(s, f, before, |s| super::block(s, &json!({"kind": format!("h{level}")})).map(|_| ()));
    }
    if !numbered && let Some(start) = r.ordered.captures(before).and_then(|c| c[1].parse::<u32>().ok()) {
        return block_change(s, f, before, |s| start_list(s, false, start));
    }
    if !numbered && r.bullet.is_match(before) {
        return block_change(s, f, before, |s| start_list(s, true, 1));
    }
    if !numbered && r.quote.is_match(before) {
        return block_change(s, f, before, |s| super::container::wrap(s, &super::wrap_args(ContainerRole::Quote)).map(|_| ()));
    }
    if !numbered && let Some(c) = r.fences.iter().find_map(|re| re.captures(before)) {
        let language = c.get(1).map(|m| m.as_str().to_string());
        return block_change(s, f, before, |s| {
            let mut args = super::wrap_args(ContainerRole::Code);
            if let Some(language) = language {
                args["language"] = json!(language);
            }
            super::container::wrap(s, &args).map(|_| ())
        });
    }
    if r.rule.is_match(before) {
        return block_change(s, f, before, |s| if numbered { rule_after(s, f) } else { super::rule(s, &json!({})).map(|_| ()) });
    }
    Ok(false)
}

/// A block rule's change: the trigger characters go, then `apply` runs, all as one undo step.
fn block_change(
    s: &mut Session,
    f: &Pos,
    before: &str,
    apply: impl FnOnce(&mut Session) -> Result<(), CmdError>,
) -> Result<bool, CmdError> {
    change(s, |s| {
        take(s, f, before.len())?;
        apply(s)
    })
}

/// The mark rules: a bold, italic, strike or inline-code pair.
fn mark_rules(s: &mut Session, r: &Rules, f: &Pos, before: &str) -> Result<bool, CmdError> {
    if let Some(c) = r.bold.iter().find_map(|re| pair(re, before)) {
        return mark(s, f, &c, "bold");
    }
    if let Some(c) = r.italic.iter().find_map(|re| pair(re, before)) {
        return mark(s, f, &c, "italic");
    }
    if let Some(c) = pair(&r.strike, before) {
        return mark(s, f, &c, "strike");
    }
    if let Some(c) = inline_code(r, before) {
        return mark(s, f, &c, "code");
    }
    Ok(false)
}

/// Whether the text beside the caret has the code mark: the character before it, or the one after when there is none
/// (Tiptap's `run`, which refuses every rule there).
fn beside_code(s: &Session, f: &Pos) -> bool {
    let Some(p) = s.doc.para_at(f) else { return false };
    let at = f.off.saturating_sub(1);
    at < p.len() && p.props_of_char(at).style.as_deref() == Some(post::CODE)
}

/// A mark pair's match, unless its text is all spacing: Tiptap's `(?!\s+\*\*)` look-aheads, which Rust's regex lacks.
fn pair<'a>(re: &Regex, before: &'a str) -> Option<Captures<'a>> {
    re.captures(before).filter(|c| !c[c.len() - 1].trim().is_empty())
}

/// Delete the characters that triggered the rule, leaving the caret where they began.
fn take(s: &mut Session, f: &Pos, off: usize) -> Result<(), CmdError> {
    s.sel = Selection { anchor: Pos { off: 0, ..f.clone() }, focus: Pos { off, ..f.clone() } };
    crate::cmd::delete_selection(s)?;
    Ok(())
}

/// Apply a rule's change and keep it as one undo step of its own, so Undo puts the paragraph back as it was typed.
fn change(s: &mut Session, action: impl FnOnce(&mut Session) -> Result<(), CmdError>) -> Result<bool, CmdError> {
    let doc = s.doc.clone();
    let sel = s.sel.clone();
    action(s)?;
    s.push_undo("AutoFormat", doc, sel);
    Ok(true)
}

/// The code mark's rule: a backtick-enclosed run ending at the caret, not opened by a second backtick (Tiptap's function
/// finder, which keeps a preceding backtick out of the match).
fn inline_code<'a>(r: &Rules, before: &'a str) -> Option<Captures<'a>> {
    let c = r.code.captures(before)?;
    let open = c.get(0)?.start();
    if before[..open].ends_with('`') {
        return None;
    }
    Some(c)
}

/// A mark pair's rule: the delimiters go and the mark covers what they held, as `markInputRule` does (a leading space stays,
/// and the caret ends after the marked text).
fn mark(s: &mut Session, f: &Pos, c: &Captures<'_>, name: &str) -> Result<bool, CmdError> {
    let whole = c.get(0).ok_or_else(|| CmdError::Failed("the mark rule matched nothing".into()))?;
    let inner = c.get(c.len() - 1).ok_or_else(|| CmdError::Failed("the mark rule matched no text".into()))?;
    let full = whole.as_str();
    let open = whole.start() + full.len() - full.trim_start().len();
    let (start, end) = (inner.start(), inner.end());
    let match_end = whole.end();
    change(s, move |s| {
        {
            let para = s.doc.para_mut(f.story, &f.path)?;
            para.delete(end, match_end)?;
            para.delete(open, start)?;
            para.touch();
        }
        let mark_end = open + (end - start);
        s.sel = Selection { anchor: Pos { off: open, ..f.clone() }, focus: Pos { off: mark_end, ..f.clone() } };
        super::named(s, name, Some(true))?;
        s.sel = Selection::caret(Pos { off: mark_end, ..f.clone() });
        // The pair's mark ends with its text, as Tiptap's `removeStoredMark`: the caret takes the formatting beside it, less
        // the mark, so typed text is plain (inline code, not inclusive, clears too).
        let mut c = s.caret_props();
        match name {
            "bold" => {
                c.bold = None;
                c.bold_cs = None;
            }
            "italic" => {
                c.italic = None;
                c.italic_cs = None;
            }
            "strike" => c.strike = None,
            _ => {
                if c.style.as_deref() == Some(post::CODE) {
                    c.style = None;
                }
            }
        }
        s.pending = Some(c);
        Ok(())
    })
}

/// A rule in a list item's first paragraph: the paragraph stays, with the rule after it and a paragraph after that, where
/// ProseMirror's fitting places it (`nodeInputRule` cannot put a horizontal rule before the item's `paragraph`).
fn rule_after(s: &mut Session, f: &Pos) -> Result<(), CmdError> {
    let mut rule = Paragraph::new();
    rule.props.style = Some(post::RULE.to_string());
    let story = f.story;
    s.doc.insert_block(story, &f.path.with_last(f.path.last() + 1), Block::Para(rule))?;
    let after = f.path.with_last(f.path.last() + 2);
    s.doc.insert_block(story, &after, Block::Para(Paragraph::new()))?;
    s.sel = Selection::caret(s.doc.clamp(&Pos { story, path: after, off: 0 }));
    Ok(())
}

/// StarterKit's list rule: the paragraph becomes an item of the list above it when that list continues (Tiptap joins an
/// adjacent list), else a new instance of the post's bulleted or numbered definition starting at the typed number.
fn start_list(s: &mut Session, bullet: bool, start: u32) -> Result<(), CmdError> {
    let f = s.sel.focus.clone();
    let above = (f.path.last() > 0).then(|| f.path.with_last(f.path.last() - 1));
    let prev = above
        .as_ref()
        .and_then(|p| s.doc.para(f.story, p))
        .and_then(|p| s.doc.styles.resolve_para(&p.props).numbering)
        .filter(|n| n.num != 0 && n.level == 0)
        .filter(|n| s.doc.numbering.level(n.num, 0).is_some_and(|l| (l.format == NumFormat::Bullet) == bullet));
    if let Some(n) = prev.filter(|n| bullet || continues(s, f.story, n.num, start)) {
        let para = s.doc.para_mut(f.story, &f.path)?;
        para.props.numbering = Some(NumRef { num: n.num, level: 0 });
        para.touch();
        return Ok(());
    }
    super::ensure_lists(s);
    let num = super::new_list(s, bullet)?;
    if start != 1
        && let Some(n) = s.doc.numbering_mut().nums.iter_mut().find(|n| n.id == num)
    {
        n.start_overrides = vec![(0, start)];
    }
    let para = s.doc.para_mut(f.story, &f.path)?;
    para.props.numbering = Some(NumRef { num, level: 0 });
    para.touch();
    Ok(())
}

/// Whether the typed number continues the list above it: its start plus the level-0 items already there (Tiptap's join
/// predicate, `node.childCount + node.attrs.start === +match[1]`).
fn continues(s: &Session, story: StoryRef, num: u32, typed: u32) -> bool {
    let first = s.doc.numbering.num(num).and_then(|n| n.start_overrides.iter().find(|(level, _)| *level == 0).map(|(_, start)| *start)).unwrap_or(1);
    let path = &s.sel.focus.path;
    let mut items = 0;
    for i in (0..path.last()).rev() {
        let reported = s.doc.para(story, &path.with_last(i)).and_then(|p| s.doc.styles.resolve_para(&p.props).numbering);
        match reported {
            Some(n) if n.num == num && n.level == 0 => items += 1,
            _ => break,
        }
    }
    first + items == typed
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ew_doc::post;
    use ew_doc::{Block, ContainerRole, Pos, StoryRef};

    use crate::{Selection, Session};

    fn session() -> Session {
        let doc = ew_formats::post::read(&json!({"doc": {"type": "doc", "content": [{"type": "paragraph"}]}}).to_string()).unwrap();
        Session::new(doc)
    }

    fn session_of(blocks: serde_json::Value) -> Session {
        Session::new(ew_formats::post::read(&json!({"doc": {"type": "doc", "content": blocks}}).to_string()).unwrap())
    }

    /// Type one character at a time, as the keyboard sends it.
    fn typ(s: &mut Session, keys: &str) {
        for c in keys.chars() {
            s.run("text.insert", &json!({"text": c.to_string()})).unwrap();
        }
    }

    fn caret(s: &mut Session, path: &[u32], off: usize) {
        s.sel = Selection::caret(Pos { story: StoryRef::Body, path: ew_doc::Path(path.to_vec()), off });
    }

    fn paras(s: &Session) -> Vec<&ew_doc::Paragraph> {
        s.doc.body.iter().filter_map(|b| b.as_para()).collect()
    }

    #[test]
    fn every_rule_pattern_compiles() {
        assert!(super::rules().is_some());
    }

    #[test]
    fn a_hash_and_a_space_make_a_heading() {
        let mut s = session();
        typ(&mut s, "### ");
        let p = paras(&s)[0];
        assert_eq!((p.props.style.as_deref(), p.text.as_str()), (Some("Heading3"), ""));
        // One Undo takes the heading away and puts the typed "### " back.
        s.run("edit.undo", &json!({})).unwrap();
        let p = paras(&s)[0];
        assert_eq!((p.props.style.as_deref(), p.text.as_str()), (None, "### "));
    }

    #[test]
    fn a_dash_a_star_or_a_plus_makes_a_bullet_list() {
        let mut s = session();
        typ(&mut s, "- ");
        typ(&mut s, "one");
        assert_eq!(paras(&s)[0].props.numbering, Some(ew_doc::props::NumRef { num: 1, level: 0 }));
        assert_eq!(s.doc.numbering.nums[0].abstract_id, post::BULLET_ABSTRACT);
        // Two Enters end the list; a bullet typed below it joins the list above (Tiptap joins an adjacent list).
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "* ");
        assert_eq!(paras(&s)[1].props.numbering, Some(ew_doc::props::NumRef { num: 1, level: 0 }));
    }

    #[test]
    fn a_typed_number_starts_an_ordered_list_at_that_number_and_continues_it() {
        let mut s = session();
        typ(&mut s, "3. ");
        typ(&mut s, "three");
        let ps = paras(&s);
        assert_eq!(ps[0].props.numbering, Some(ew_doc::props::NumRef { num: 1, level: 0 }));
        assert_eq!(s.doc.numbering.nums[0].start_overrides, [(0, 3)]);
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "four");
        // Two Enters end the list: the plain paragraph below it takes a number that continues it.
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "5. ");
        assert_eq!(paras(&s)[2].props.numbering, Some(ew_doc::props::NumRef { num: 1, level: 0 }), "5 continues 3 and two items");
        // A number that does not continue starts a list of its own.
        typ(&mut s, "five");
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "9. ");
        assert_eq!(paras(&s)[3].props.numbering, Some(ew_doc::props::NumRef { num: 2, level: 0 }));
        assert_eq!(s.doc.numbering.nums[1].start_overrides, [(0, 9)]);
    }

    #[test]
    fn a_greater_than_and_a_space_make_a_quote() {
        let mut s = session();
        typ(&mut s, "> ");
        typ(&mut s, "quoted");
        let Block::Container(c) = s.doc.body[0].as_ref() else { panic!("not a quote: {:?}", s.doc.body[0]) };
        assert_eq!((c.role, c.style.as_deref()), (ContainerRole::Quote, Some(post::QUOTE)));
        assert_eq!(c.blocks[0].as_para().unwrap().text, "quoted");
    }

    #[test]
    fn a_backtick_or_tilde_fence_makes_a_code_block_with_its_language() {
        for fence in ["```rust ", "~~~rust "] {
            let mut s = session();
            typ(&mut s, fence);
            typ(&mut s, "let x = 1;");
            let Block::Container(c) = s.doc.body[0].as_ref() else { panic!("not a code block: {:?}", s.doc.body[0]) };
            assert_eq!((c.role, c.style.as_deref(), c.language.as_deref()), (ContainerRole::Code, Some(post::CODE_BLOCK), Some("rust")), "{fence}");
            assert_eq!(c.blocks[0].as_para().unwrap().props.style.as_deref(), Some(post::CODE_TEXT));
        }
    }

    #[test]
    fn three_dashes_make_a_rule() {
        let mut s = session();
        typ(&mut s, "---");
        assert_eq!(paras(&s)[0].props.style.as_deref(), Some(post::RULE));
        assert!(paras(&s)[0].is_empty());
        // The caret is in the paragraph after the rule, where typing continues.
        assert_eq!(s.sel.focus.path, ew_doc::Path(vec![1]));
    }

    #[test]
    fn a_bold_italic_or_struck_pair_marks_the_text_between_it() {
        for (keys, name) in [("**bold**", "bold"), ("__bold__", "bold"), ("*it*", "italic"), ("_it_", "italic"), ("~~gone~~", "strike")] {
            let mut s = session();
            typ(&mut s, keys);
            let p = paras(&s)[0];
            let (text, props) = (p.text.as_str(), p.runs[0].props.clone());
            let on = match name {
                "bold" => props.bold == Some(true),
                "italic" => props.italic == Some(true),
                _ => props.strike == Some(true),
            };
            assert_eq!((text, on), (if name == "bold" { "bold" } else if name == "italic" { "it" } else { "gone" }, true), "{keys}");
            // The caret ends after the marked text.
            assert_eq!(s.sel.focus.off, text.len(), "{keys}");
        }
    }

    #[test]
    fn a_backtick_pair_makes_inline_code_and_drops_the_other_marks() {
        let mut s = session();
        typ(&mut s, "**bold `code`");
        let p = paras(&s)[0];
        let last = p.runs.last().unwrap();
        assert_eq!((last.len, last.props.style.as_deref()), (4, Some(post::CODE)));
        assert_eq!((last.props.bold, p.text.as_str()), (None, "**bold code"));
    }

    #[test]
    fn no_rule_runs_in_code_or_with_autocorrect_off() {
        let mut s = session();
        typ(&mut s, "``` ");
        // Inside the code block "# " stays text.
        typ(&mut s, "# ");
        assert_eq!(s.doc.body[0].as_container().unwrap().blocks[0].as_para().unwrap().text, "# ");
        let mut s = session();
        s.prefs.autocorrect.enabled = false;
        typ(&mut s, "### ");
        assert_eq!((paras(&s)[0].props.style.as_deref(), paras(&s)[0].text.as_str()), (None, "### "));
    }

    #[test]
    fn text_typed_after_a_mark_pair_is_plain() {
        for (pair, inner) in [("**b**", "b"), ("*i*", "i"), ("~~s~~", "s"), ("`c`", "c")] {
            let mut s = session();
            typ(&mut s, pair);
            typ(&mut s, " x");
            let p = paras(&s)[0];
            assert_eq!(p.text, format!("{inner} x"), "{pair}");
            let last = p.runs.last().unwrap();
            let plain = last.props.bold.is_none() && last.props.italic.is_none() && last.props.strike.is_none() && last.props.style.is_none();
            assert_eq!((last.len, plain), (2, true), "{pair}: {:?}", last.props);
        }
    }

    #[test]
    fn a_rule_does_not_run_inside_inline_code() {
        let mut s = session_of(json!([{"type": "paragraph", "content": [{"type": "text", "text": "ab", "marks": [{"type": "code"}]}]}]));
        caret(&mut s, &[0], 1);
        typ(&mut s, " **x**");
        let p = paras(&s)[0];
        assert_eq!(p.text, "a **x**b");
        assert!(p.runs.iter().all(|r| r.props.bold.is_none()), "{:?}", p.runs.iter().map(|r| &r.props).collect::<Vec<_>>());
    }

    #[test]
    fn a_mark_pair_inside_a_link_keeps_the_link() {
        let link = json!([{"type": "paragraph", "content": [
            {"type": "text", "text": "ab", "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}]}
        ]}]);
        let mut s = session_of(link);
        caret(&mut s, &[0], 1);
        typ(&mut s, " **b**");
        let p = paras(&s)[0];
        assert_eq!(p.text, "a bb");
        let bold = p.runs.iter().find(|r| r.props.bold == Some(true)).unwrap();
        assert!(bold.props.link.is_some(), "the link stays on the bold text");
        typ(&mut s, " x");
        let p = paras(&s)[0];
        let last = p.runs.last().unwrap();
        assert_eq!((last.props.bold.is_none(), last.props.link.is_some()), (true, true), "{:?}", last.props);
    }

    #[test]
    fn a_list_items_first_paragraph_refuses_heading_quote_list_and_fence_rules() {
        for keys in ["# ", "> ", "``` ", "* ", "1. "] {
            let mut s = session();
            typ(&mut s, "1. ");
            typ(&mut s, keys);
            let p = paras(&s)[0];
            assert_eq!((p.text.as_str(), p.props.style.as_deref()), (keys, None), "{keys} stays as typed");
            assert_eq!(p.props.numbering, Some(ew_doc::props::NumRef { num: 1, level: 0 }), "{keys}");
            assert_eq!(s.doc.body.len(), 1, "{keys} adds no block");
        }
    }

    #[test]
    fn a_rule_in_a_list_items_first_paragraph_goes_after_it() {
        let mut s = session();
        typ(&mut s, "1. ");
        typ(&mut s, "item");
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "---");
        let ps = paras(&s);
        assert_eq!(ps.len(), 4, "{:?}", ps.iter().map(|p| p.text.as_str()).collect::<Vec<_>>());
        assert_eq!((ps[0].text.as_str(), ps[1].text.as_str()), ("item", ""));
        assert!(ps[1].props.numbering.is_some() && ps[1].is_empty(), "the item's paragraph stays numbered");
        assert_eq!((ps[2].props.style.as_deref(), ps[2].is_empty()), (Some(post::RULE), true));
        assert!(ps[3].is_empty() && ps[3].props.numbering.is_none());
        assert_eq!(s.sel.focus.path, ew_doc::Path(vec![3]));
    }

    #[test]
    fn a_rule_inside_a_box_goes_between_its_paragraphs() {
        let mut s = session();
        typ(&mut s, "hi");
        s.run("post.toggle", &json!({"kind": "box"})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        typ(&mut s, "---");
        let Block::Container(c) = s.doc.body[0].as_ref() else { panic!("not a box: {:?}", s.doc.body[0]) };
        let ps: Vec<&ew_doc::Paragraph> = c.blocks.iter().filter_map(|b| b.as_para()).collect();
        assert_eq!(ps.len(), 3, "{:?}", ps.iter().map(|p| p.text.as_str()).collect::<Vec<_>>());
        assert_eq!(ps[0].text, "hi");
        assert_eq!((ps[1].props.style.as_deref(), ps[1].is_empty()), (Some(post::RULE), true));
        assert!(ps[2].is_empty());
        assert!(s.doc.para_at(&s.sel.focus).is_some_and(ew_doc::Paragraph::is_empty), "the caret follows the rule");
    }
}
