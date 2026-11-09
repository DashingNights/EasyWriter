//! EasyWriter engine-gaps-rest: runs Word lays out as one unit in East Asian typography (`w:eastAsianLayout`, ISO/IEC 29500-1
//! §17.3.2.10): Two Lines in One (`w:combine`) and Horizontal in Vertical (`w:vert`). Each is one cluster over the run's text
//! with its glyphs drawn over it ([`EaRun`]), as ruby text is.
//!
//! Word's drawing, from its PDF of the fixture (all-features.pdf page 66, Aptos 12 pt) and probe g33 (Arial 12 pt):
//! - Two Lines in One sets the text on two rows at half the size, left-aligned, that fill the line's own box: the first row's
//!   baseline half the line's ascent up, the second half its descent down. The first row takes half the characters and then
//!   the rest of the word and the spaces after it ("two lines " over "in one"). Brackets are the run's size in its East Asian
//!   font on the line's baseline, and the run takes the brackets and the wider row.
//! - Horizontal in Vertical turns the text 90 degrees counterclockwise even in horizontal text: it takes the font's line
//!   height along the line (14.1 pt for Arial 12, plain "12" 13.3) and stands on it from 0.19 em below the baseline. In a
//!   vertical table cell the turned line turns it back, so it reads across. Fit in line (`w:vertCompress`) squeezes text
//!   longer than the line's height to it.

use super::bidi::Dir;
use super::builder::Builder;
use super::model::{ClKind, Cluster, EaRun, Glyph};
use super::{Arc, ResolvedChar};
use ew_doc::props::CombineBrackets;

/// Horizontal in Vertical's room beyond the font's line height, and where its turned baseline and first letter sit, as shares
/// of the size (probe g33). ponytail: one font at one size; probes at other sizes would confirm them.
const HIV_EXTRA: f32 = 0.06;
const HIV_BASE_IN: f32 = 0.04;
const HIV_DROP: f32 = 0.19;

/// Where the first row of Two Lines in One ends, as a byte offset of `text`: half its characters, then the rest of that word
/// and the spaces after it. A text that is one word splits at the half.
pub(super) fn two_lines_split(text: &str) -> usize {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let half = n.div_ceil(2);
    let byte = |i: usize| chars.get(i).map_or(text.len(), |(b, _)| *b);
    // A row may end after a space or an East Asian character (each is a word of its own).
    let ends_word = |i: usize| chars.get(i).is_some_and(|(_, c)| c.is_whitespace() || super::grid::east_asian(*c));
    let mut k = half;
    while k > 0 && k < n && !ends_word(k - 1) {
        k += 1;
    }
    if k >= n && n > 1 {
        return byte(half);
    }
    while k < n && chars.get(k).is_some_and(|(_, c)| c.is_whitespace()) {
        k += 1;
    }
    byte(k)
}

/// The characters of a bracket style.
fn bracket_pair(b: CombineBrackets) -> Option<(char, char)> {
    match b {
        CombineBrackets::None => None,
        CombineBrackets::Round => Some(('(', ')')),
        CombineBrackets::Square => Some(('[', ']')),
        CombineBrackets::Angle => Some(('<', '>')),
        CombineBrackets::Curly => Some(('{', '}')),
    }
}

/// A copy of `rc` without its East Asian layout, so shaping the run's pieces does not come back here.
fn plain(rc: &ResolvedChar) -> ResolvedChar {
    let mut r = rc.clone();
    r.east_asian_layout = None;
    r.fit_text = None;
    r
}

impl Builder<'_> {
    /// `text` shaped on its own in `rc` → its glyphs with their styles (dx from its start), each glyph's byte range in `text`, and
    /// its width. Nothing stays in the paragraph's clusters or glyphs.
    fn glyphs_of(&mut self, text: &str, rc: &Arc<ResolvedChar>) -> (Vec<(u32, Glyph)>, Vec<std::ops::Range<usize>>, f32) {
        let (c0, g0) = (self.clusters.len(), self.glyphs.len());
        self.shape_with(text, 0, rc, None, Dir::Guess);
        let added: Vec<Cluster> = self.clusters.drain(c0..).collect();
        let (mut glyphs, mut ranges, mut x) = (Vec::new(), Vec::new(), 0.0f32);
        for c in &added {
            for g in self.glyphs.get(c.g0 as usize..c.g1 as usize).into_iter().flatten() {
                glyphs.push((c.style, Glyph { dx: g.dx + x, ..*g }));
                ranges.push(c.start..c.end);
            }
            x += c.adv;
        }
        self.glyphs.truncate(g0);
        (glyphs, ranges, x)
    }

    /// The cluster for an East Asian layout run at `start..end` (`adv` wide, reaching `obj_h` above the baseline), in the run's
    /// own style.
    fn ea_cluster(&mut self, (start, end): (usize, usize), rc: &Arc<ResolvedChar>, adv: f32, obj_h: f32) -> usize {
        let style = self.style(rc, None, false);
        let g = self.glyphs.len() as u32;
        self.clusters.push(Cluster { start, end, adv, kind: ClKind::Text, style, g0: g, g1: g, break_after: false, obj_h, obj_d: 0.0, dec: super::Dec::Other });
        self.clusters.len() - 1
    }

    /// Two Lines in One over `text` at `start..end`, in brackets `brackets`.
    pub(super) fn two_lines(&mut self, text: &str, span: (usize, usize), rc: &Arc<ResolvedChar>, brackets: Option<CombineBrackets>) -> EaRun {
        let base = Arc::new(plain(rc));
        let si = self.style(&base, None, false);
        let (a, d) = self.styles.get(si as usize).map_or((rc.size * 0.8, rc.size * 0.2), |s| (s.ascent, s.descent));
        let mut half = plain(rc);
        (half.size, half.size_cs, half.position) = (rc.size / 2.0, rc.size_cs / 2.0, 0.0);
        let half = Arc::new(half);
        let mut bracket = plain(rc);
        if let Some(f) = rc.font_ea.clone() {
            bracket.font = f;
        }
        let bracket = Arc::new(bracket);
        let pair = brackets.and_then(bracket_pair);
        let split = two_lines_split(text);
        let (top, bottom) = (text.get(..split).unwrap_or(text), text.get(split..).unwrap_or(""));
        let mut run = EaRun { cluster: 0, glyphs: Vec::new(), text: String::new(), ranges: Vec::new(), turn: None };
        let put = |run: &mut EaRun, (glyphs, ranges, _): (Vec<(u32, Glyph)>, Vec<std::ops::Range<usize>>, f32), piece: &str, (x, dy): (f32, f32)| {
            let off = run.text.len();
            run.glyphs.extend(glyphs.into_iter().map(|(s, g)| (s, Glyph { dx: g.dx + x, dy: g.dy + dy, ..g })));
            run.ranges.extend(ranges.into_iter().map(|r| r.start + off..r.end + off));
            run.text.push_str(piece);
        };
        let open = pair.map(|(o, _)| o.to_string()).unwrap_or_default();
        let close = pair.map(|(_, c)| c.to_string()).unwrap_or_default();
        let o = self.glyphs_of(&open, &bracket);
        let ow = o.2;
        put(&mut run, o, &open, (0.0, 0.0));
        let t = self.glyphs_of(top, &half);
        let b = self.glyphs_of(bottom, &half);
        let rows = t.2.max(b.2);
        put(&mut run, t, top, (ow, a / 2.0));
        put(&mut run, b, bottom, (ow, -d / 2.0));
        let c = self.glyphs_of(&close, &bracket);
        let cw = c.2;
        put(&mut run, c, &close, (ow + rows, 0.0));
        run.cluster = self.ea_cluster(span, &base, ow + rows + cw, 0.0);
        run
    }

    /// Horizontal in Vertical over `text` at `start..end`, squeezed into the line's height when `compress`.
    pub(super) fn horizontal_in_vertical(&mut self, text: &str, span: (usize, usize), rc: &Arc<ResolvedChar>, compress: bool) -> EaRun {
        let base = Arc::new(plain(rc));
        let si = self.style(&base, None, false);
        let (a, d) = self.styles.get(si as usize).map_or((rc.size * 0.8, rc.size * 0.2), |s| (s.ascent, s.descent));
        let (glyphs, ranges, w) = self.glyphs_of(text, &base);
        let scale = if compress && w > a + d && w > 0.0 { (a + d) / w } else { 1.0 };
        let size = rc.size;
        // Squeezed text keeps to the line: it never makes it taller.
        let obj_h = (w * scale - HIV_DROP * size).max(0.0);
        let obj_h = if compress { obj_h.min(a) } else { obj_h };
        let run = EaRun { cluster: 0, glyphs, text: text.to_string(), ranges, turn: Some((a + HIV_BASE_IN * size, HIV_DROP * size, scale)) };
        EaRun { cluster: self.ea_cluster(span, &base, a + d + HIV_EXTRA * size, obj_h), ..run }
    }
}

#[cfg(test)]
mod tests {
    use super::two_lines_split;

    /// Word's split (fixture page 66): half the characters, then the rest of the word and its spaces.
    #[test]
    fn two_lines_split_as_word_does() {
        let t = "two lines in one";
        assert_eq!(&t[..two_lines_split(t)], "two lines ");
        let cjk = "二行の注釈";
        assert_eq!(&cjk[..two_lines_split(cjk)], "二行の");
        assert_eq!(&"abcdef"[..two_lines_split("abcdef")], "abc", "one word splits at the half");
        assert_eq!(two_lines_split("a"), 1);
    }
}
