//! Freeform shapes: the geometry of a shape drawn point by point (DrawingML `a:custGeom`), such as
//! an ink stroke drawn with a pen, pencil or highlighter (Draw tab).

use serde::{Deserialize, Serialize};

/// Most points one path keeps (hostile files and commands): a long pen stroke has a few hundred.
pub const MAX_POINTS: usize = 5_000;
/// Most paths one freeform keeps.
pub const MAX_PATHS: usize = 256;
/// Most ink strokes on one page: drawing more is refused.
pub const MAX_INK_PER_PAGE: usize = 2_000;
/// Largest coordinate kept, in the path's own coordinate space.
const MAX_COORD: f32 = 1.0e6;

/// The pen an ink stroke was drawn with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InkTool {
    #[default]
    Pen,
    Pencil,
    Highlighter,
}

impl InkTool {
    pub fn parse(s: &str) -> Option<InkTool> {
        match s.to_ascii_lowercase().as_str() {
            "pen" => Some(InkTool::Pen),
            "pencil" => Some(InkTool::Pencil),
            "highlighter" => Some(InkTool::Highlighter),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            InkTool::Pen => "pen",
            InkTool::Pencil => "pencil",
            InkTool::Highlighter => "highlighter",
        }
    }
    /// The colour a new stroke gets (black pen, grey pencil, yellow highlighter).
    pub fn default_color(self) -> crate::props::Rgb {
        match self {
            InkTool::Pen => crate::props::Rgb(0, 0, 0),
            InkTool::Pencil => crate::props::Rgb(0x59, 0x59, 0x59),
            InkTool::Highlighter => crate::props::Rgb(0xFF, 0xFF, 0x00),
        }
    }
    /// The width a new stroke gets, points.
    pub fn default_width(self) -> f32 {
        match self {
            InkTool::Pen => 1.5,
            InkTool::Pencil => 1.0,
            InkTool::Highlighter => 12.0,
        }
    }
    /// How opaque its strokes are: a highlighter's let the text show through, a pencil's are a
    /// little lighter than a pen's.
    pub fn alpha(self) -> f32 {
        match self {
            InkTool::Pen => 1.0,
            InkTool::Pencil => 0.85,
            InkTool::Highlighter => 0.5,
        }
    }
}

/// One path of a freeform: points joined by straight lines, closed back to the first or not.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FreePath {
    pub pts: Vec<[f32; 2]>,
    pub closed: bool,
}

/// EasyWriter engine-tools-2: how Edit Points moves a point's two handles: apart (corner), in line and equally long
/// (smooth), in line (straight), or placed from the neighbouring points (auto).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    #[default]
    Corner,
    Smooth,
    Straight,
    Auto,
}

/// One point of a path as Edit Points shows it: where it is, and the control points of the curves into it (`c_in`) and out
/// of it (`c_out`); a side without one is straight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditNode {
    pub at: [f32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c_in: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c_out: Option<[f32; 2]>,
    #[serde(default)]
    pub kind: NodeKind,
}

/// A path of points and curves as Edit Points left it, in its freeform's coordinate space. The freeform draws its
/// [`EditPath::flatten`]ed polyline, which every reader of the freeform takes; this keeps the points and handles behind it.
// Derived, so the stored form's field list (scripts/schema-fields.mjs) sees its fields (engine-fixes-2-layout); `closed`
// comes first as the hand-written form, a sorted JSON object, wrote it. Read through [`read_edit_paths`].
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct EditPath {
    pub closed: bool,
    pub nodes: Vec<EditNode>,
}

impl EditNode {
    /// {at, cIn?, cOut?, kind}, its numbers an f32's own shortest digits (as the stored form writes them): what commands
    /// give and take. Through the text, since `serde_json::to_value` widens an f32 (4.086914039611816 for 4.086914).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_string(self).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// A node from {at, cIn?, cOut?, kind?}: None without a finite `at` or with a kind it does not know; a handle that does
    /// not read as finite [x, y] is left out on its own, so one bad value loses only that handle (each field is read apart,
    /// not through the derive, which fails the whole node on any one of them).
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        let point = |k: &str| {
            let p = <[f32; 2]>::deserialize(v.get(k)?).ok()?;
            p.iter().all(|c| c.is_finite()).then_some(p)
        };
        let kind = match v.get("kind") {
            None | Some(serde_json::Value::Null) => NodeKind::default(),
            Some(k) => NodeKind::deserialize(k).ok()?,
        };
        Some(EditNode { at: point("at")?, c_in: point("cIn"), c_out: point("cOut"), kind })
    }
}

/// Reads `ShapeExtra::edit_paths`: a path or node that does not read is left out (Edit Points then shows the freeform's own
/// points, as for any freeform it did not make), and at most [`MAX_PATHS`] paths of [`MAX_POINTS`] nodes are kept.
pub(crate) fn read_edit_paths<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<EditPath>, D::Error> {
    use serde_json::Value;
    let v = Value::deserialize(d)?;
    let path = |p: &Value| EditPath {
        nodes: p.get("nodes").and_then(Value::as_array).into_iter().flatten().take(MAX_POINTS).filter_map(EditNode::from_json).collect(),
        closed: p.get("closed").and_then(Value::as_bool).unwrap_or(false),
    };
    Ok(v.as_array().into_iter().flatten().take(MAX_PATHS).map(path).collect())
}

/// Straight pieces a curve of an [`EditPath`] is drawn with.
pub const CURVE_STEPS: usize = 16;

impl EditPath {
    /// The polyline drawn for this path: a straight side as its end point, a curve (a cubic Bézier through the handles, an
    /// absent one at its own point) as [`CURVE_STEPS`] points; a closed path's closing side ends short of its first point.
    pub fn flatten(&self) -> FreePath {
        let n = self.nodes.len();
        let mut pts = Vec::with_capacity(n * 2);
        if let Some(first) = self.nodes.first() {
            pts.push(first.at);
        }
        let sides = if self.closed && n > 2 { n } else { n.saturating_sub(1) };
        for i in 0..sides {
            let (a, b) = (self.nodes[i], self.nodes[(i + 1) % n]);
            let last = i + 1 == n; // the closing side
            if a.c_out.is_none() && b.c_in.is_none() {
                if !last {
                    pts.push(b.at);
                }
                continue;
            }
            let (p1, p2) = (a.c_out.unwrap_or(a.at), b.c_in.unwrap_or(b.at));
            for k in 1..=CURVE_STEPS {
                if last && k == CURVE_STEPS {
                    break;
                }
                let t = k as f32 / CURVE_STEPS as f32;
                let u = 1.0 - t;
                let (c0, c1, c2, c3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                pts.push([0, 1].map(|j| c0 * a.at[j] + c1 * p1[j] + c2 * p2[j] + c3 * b.at[j]));
            }
        }
        FreePath { pts, closed: self.closed && n > 2 }
    }
}

/// A freeform shape's geometry: paths in a `w` × `h` coordinate space that is stretched over the
/// shape's frame (DrawingML's `a:path` `w` and `h`). Drawn with the shape's outline colour and
/// width (and its fill, for closed paths that aren't ink).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Freeform {
    pub w: f32,
    pub h: f32,
    pub paths: Vec<FreePath>,
    /// Opacity of the outline, 0–1.
    pub alpha: f32,
    /// Set when this is ink: drawn with a pen (Draw tab), hidden by Review › Hide Ink and removed
    /// by the eraser.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink: Option<InkTool>,
    /// Ink: its place in the order the strokes were drawn (1, 2, 3…), for Draw › Ink Replay.
    /// `None` for ink from files that don't record it (replayed first, in document order).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

impl Default for Freeform {
    fn default() -> Self {
        Freeform { w: 0.0, h: 0.0, paths: Vec::new(), alpha: 1.0, ink: None, order: None }
    }
}

impl Freeform {
    /// An ink stroke through `pts` (shape-local points, already in the `w` × `h` frame).
    pub fn ink(tool: InkTool, w: f32, h: f32, pts: Vec<[f32; 2]>) -> Freeform {
        Freeform { w, h, paths: vec![FreePath { pts, closed: false }], alpha: tool.alpha(), ink: Some(tool), order: None }.sanitized()
    }

    /// The same geometry with non-finite points dropped, coordinates clamped, the counts capped
    /// and the opacity in 0–1: safe to draw whatever file or command it came from.
    pub fn sanitized(mut self) -> Freeform {
        let fin = |v: f32| if v.is_finite() { v.clamp(-MAX_COORD, MAX_COORD) } else { 0.0 };
        self.w = fin(self.w).max(0.0);
        self.h = fin(self.h).max(0.0);
        self.alpha = if self.alpha.is_finite() { self.alpha.clamp(0.0, 1.0) } else { 1.0 };
        self.paths.truncate(MAX_PATHS);
        for p in &mut self.paths {
            p.pts.retain(|[x, y]| x.is_finite() && y.is_finite());
            p.pts.truncate(MAX_POINTS);
            for pt in &mut p.pts {
                *pt = pt.map(fin);
            }
        }
        self.paths.retain(|p| !p.pts.is_empty());
        self
    }

    pub fn is_ink(&self) -> bool {
        self.ink.is_some()
    }

    /// The paths mapped onto a frame at (`x`, `y`) of size `fw` × `fh` (page points). A zero
    /// coordinate space takes the frame's own size.
    pub fn placed(&self, x: f32, y: f32, fw: f32, fh: f32) -> Vec<(Vec<[f32; 2]>, bool)> {
        let sx = if self.w > 0.0 { fw / self.w } else { 1.0 };
        let sy = if self.h > 0.0 { fh / self.h } else { 1.0 };
        let (sx, sy) = (if sx.is_finite() { sx } else { 1.0 }, if sy.is_finite() { sy } else { 1.0 });
        self.paths
            .iter()
            .take(MAX_PATHS)
            .map(|p| (p.pts.iter().take(MAX_POINTS).map(|[px, py]| [x + px * sx, y + py * sy]).collect(), p.closed))
            .collect()
    }

    /// Distance from (`px`, `py`) to the nearest path of this freeform placed on a frame at
    /// (`x`, `y`), `fw` × `fh` (page points); `None` when it has no points.
    pub fn distance(&self, x: f32, y: f32, fw: f32, fh: f32, px: f32, py: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        for (pts, closed) in self.placed(x, y, fw, fh) {
            let n = pts.len();
            let segs = if closed && n > 2 { n } else { n.saturating_sub(1) };
            let mut consider = |a: [f32; 2], b: [f32; 2]| {
                let d = seg_distance(a, b, [px, py]);
                if d.is_finite() && best.is_none_or(|bd| d < bd) {
                    best = Some(d);
                }
            };
            if n == 1
                && let Some(a) = pts.first()
            {
                consider(*a, *a);
            }
            for i in 0..segs {
                if let (Some(a), Some(b)) = (pts.get(i), pts.get((i + 1) % n)) {
                    consider(*a, *b);
                }
            }
        }
        best
    }
}

/// Distance from `p` to the segment `a`–`b`.
fn seg_distance(a: [f32; 2], b: [f32; 2], p: [f32; 2]) -> f32 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let (cx, cy) = (a[0] + t * dx, a[1] + t * dy);
    ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_geometry_is_sanitized() {
        let mut pts = vec![[f32::NAN, 1.0], [2.0, f32::INFINITY], [1.0, 2.0], [1e30, -1e30]];
        pts.extend(std::iter::repeat_n([3.0, 3.0], MAX_POINTS * 2));
        let f = Freeform { w: f32::NAN, h: -4.0, paths: vec![FreePath { pts, closed: false }], alpha: 7.0, ink: None, order: None }.sanitized();
        assert_eq!((f.w, f.h, f.alpha), (0.0, 0.0, 1.0));
        let p = &f.paths[0].pts;
        assert_eq!(p.len(), MAX_POINTS);
        assert_eq!(p[0], [1.0, 2.0]);
        assert_eq!(p[1], [MAX_COORD, -MAX_COORD]);
    }

    #[test]
    fn an_edit_path_flattens_its_curves_and_keeps_straight_sides() {
        let node = |x: f32, y: f32| EditNode { at: [x, y], ..Default::default() };
        let mut p = EditPath { nodes: vec![node(0.0, 0.0), node(30.0, 0.0), node(30.0, 30.0)], closed: true };
        assert_eq!(p.flatten().pts, vec![[0.0, 0.0], [30.0, 0.0], [30.0, 30.0]]);
        // A curve out of the first point: CURVE_STEPS points ending at the second, which the closed path then joins.
        p.nodes[0].c_out = Some([10.0, -10.0]);
        p.nodes[1].c_in = Some([20.0, -10.0]);
        let f = p.flatten();
        assert_eq!(f.pts.len(), 1 + CURVE_STEPS + 1);
        assert_eq!(f.pts[CURVE_STEPS], [30.0, 0.0]);
        assert!(f.pts[CURVE_STEPS / 2][1] < -5.0, "the curve bows out: {:?}", f.pts[CURVE_STEPS / 2]);
        assert!(f.closed);
    }

    #[test]
    fn a_bad_handle_loses_only_that_handle() {
        let v = serde_json::json!([{"closed": true, "nodes": [
            {"at": [1.0, 2.0], "cIn": "bad", "cOut": [3.0, 4.0], "kind": "smooth"},
            {"at": [5.0, 6.0], "cIn": [7.0], "cOut": [8.0, 9.0]},
            {"at": [10.0, 11.0], "cOut": [1e300, 0.0]},
        ]}]);
        let paths = read_edit_paths(&v).unwrap();
        let n = &paths[0].nodes;
        assert_eq!(n.len(), 3, "{n:?}");
        assert_eq!((n[0].at, n[0].c_in, n[0].c_out, n[0].kind), ([1.0, 2.0], None, Some([3.0, 4.0]), NodeKind::Smooth));
        assert_eq!((n[1].c_in, n[1].c_out), (None, Some([8.0, 9.0])));
        assert_eq!((n[2].at, n[2].c_out), ([10.0, 11.0], None));
    }

    #[test]
    fn serde_writes_some_coordinates_in_the_other_notation_since_version_9() {
        // Version 8's hand-written form wrote an f32 through f64 (`[1e-6,10000000000000.0]` for these); serde writes an
        // f32's own notation, decimal from 1e-6 and exponent from 1e13 (1e+13). Both read back as the same f32.
        let n = EditNode { at: [1e-6, 1e13], ..Default::default() };
        assert_eq!(serde_json::to_string(&n).unwrap(), r#"{"at":[0.000001,1e+13],"kind":"corner"}"#);
        assert_eq!(EditNode::from_json(&n.to_json()), Some(n));
    }

    #[test]
    fn distance_to_a_stroke_scales_with_its_frame() {
        let f = Freeform::ink(InkTool::Pen, 10.0, 10.0, vec![[0.0, 0.0], [10.0, 0.0]]);
        // Frame twice the size at (100, 100): the stroke runs from (100,100) to (120,100).
        assert_eq!(f.distance(100.0, 100.0, 20.0, 20.0, 110.0, 103.0), Some(3.0));
        assert_eq!(Freeform::default().distance(0.0, 0.0, 1.0, 1.0, 0.0, 0.0), None);
    }
}
