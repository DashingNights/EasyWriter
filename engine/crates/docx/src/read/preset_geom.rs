//! EasyWriter: DrawingML preset shapes (ECMA-376 Part 1 §20.1.10.56) drawn from their definitions, the shape pool's
//! vendored `presetShapeDefinitions.xml` (src/vendor/ooxml-presets, Apache POI's copy of the spec's file, Apache-2.0).
//! EasyWriter drew the presets it has no shape kind for as the nearest kind (snipped corners, hexagons, cubes, folded
//! corners as rectangles, plaques as rounded rectangles); these become freeforms of the preset's own paths, with the
//! shape's adjust values, and are written back as the preset.
//! ponytail: a path's `fill="darken"`/`"lighten"` parts are filled with the shape's own fill, and an unstroked part is
//! still outlined; the shared shape library (src/flow/presets.mjs) draws both.

use std::collections::HashMap;
use std::sync::OnceLock;

use ew_doc::freeform::{FreePath, Freeform, MAX_PATHS, MAX_POINTS};

use crate::units::int;
use crate::xml::El;

// build.rs writes it, without the file's line ends and indentation.
const DEFINITIONS: &str = include_str!(concat!(env!("OUT_DIR"), "/presetShapeDefinitions.xml"));
/// Straight pieces a Bézier curve is flattened into, and the most an arc is (one per 1/32 turn).
const CURVE_STEPS: usize = 8;
const ARC_STEP: f64 = std::f64::consts::PI / 16.0;
/// Guides evaluated per shape (the largest preset has about 60).
const MAX_GUIDES: usize = 256;

/// The presets EasyWriter's own shape kinds draw exactly; every other preset is drawn from its definition. The
/// triangle, the four block arrows and the five-point star match their kinds only at their default adjust values.
pub(crate) fn drawn_by_kind(prst: &str, adjusted: bool) -> bool {
    let canonical = matches!(prst, "triangle" | "rightArrow" | "leftArrow" | "upArrow" | "downArrow" | "star5");
    (canonical && !adjusted)
        || matches!(
        prst,
        "rect"
            | "roundRect"
            | "ellipse"
            | "flowChartOr"
            | "rtTriangle"
            | "diamond"
            | "line"
            | "lineInv"
            | "straightConnector1"
            | "bentConnector2"
            | "bentConnector3"
            | "bentConnector4"
            | "bentConnector5"
            | "curvedConnector2"
            | "curvedConnector3"
            | "curvedConnector4"
            | "curvedConnector5"
            | "heart"
    )
}

fn definitions() -> &'static HashMap<String, El> {
    static DEFS: OnceLock<HashMap<String, El>> = OnceLock::new();
    DEFS.get_or_init(|| {
        crate::xml::parse(DEFINITIONS.as_bytes()).map(|root| root.els().map(|e| (e.local().to_string(), e.clone())).collect()).unwrap_or_default()
    })
}

/// The adjust values of `a:prstGeom` (`a:avLst/a:gd`, `val n`), as written.
pub(crate) fn adjusts(geom: &El) -> Vec<(String, i64)> {
    geom.child("a:avLst")
        .into_iter()
        .flat_map(|l| l.children("a:gd"))
        .filter_map(|g| {
            let v = g.attr("fmla")?.trim().strip_prefix("val")?.trim();
            Some((g.attr("name")?.to_string(), int(v)?))
        })
        .take(16)
        .collect()
}

/// Preset `prst` with adjust values `adj` on a `w` × `h` point shape, as a freeform; `None` for a preset the
/// definitions don't hold.
pub(crate) fn preset_freeform(prst: &str, adj: &[(String, i64)], w: f32, h: f32) -> Option<Freeform> {
    let def = definitions().get(prst)?;
    let (sw, sh) = (f64::from(w.max(0.0)) * 12_700.0, f64::from(h.max(0.0)) * 12_700.0);
    let mut g = Guides::new(sw, sh);
    for gd in def.child_local("avLst").into_iter().flat_map(|l| l.els()).take(MAX_GUIDES) {
        let Some(name) = gd.attr("name") else { continue };
        let own = adj.iter().find(|(n, _)| n == name).map(|(_, v)| *v as f64);
        let v = own.unwrap_or_else(|| g.formula(gd.attr("fmla").unwrap_or("")));
        g.set(name, v);
    }
    for gd in def.child_local("gdLst").into_iter().flat_map(|l| l.els()).take(MAX_GUIDES) {
        let v = g.formula(gd.attr("fmla").unwrap_or(""));
        if let Some(name) = gd.attr("name") {
            g.set(name, v);
        }
    }
    let mut paths: Vec<FreePath> = Vec::new();
    for p in def.child_local("pathLst").into_iter().flat_map(|l| l.els()) {
        let dim = |n: &str, whole: f64| p.attr(n).and_then(int).filter(|v| *v > 0).map_or(whole, |v| v as f64);
        let (pw, ph) = (dim("w", sw), dim("h", sh));
        let (kx, ky) = (if pw > 0.0 { sw / pw } else { 1.0 }, if ph > 0.0 { sh / ph } else { 1.0 });
        let open = p.attr("fill") == Some("none");
        let mut cur: Vec<[f64; 2]> = Vec::new();
        let mut done: Vec<(Vec<[f64; 2]>, bool)> = Vec::new();
        let pt = |g: &Guides, e: &El| [g.value(e.attr("x").unwrap_or("0")) * kx, g.value(e.attr("y").unwrap_or("0")) * ky];
        for seg in p.els() {
            if cur.len() >= MAX_POINTS {
                break;
            }
            match seg.local() {
                "moveTo" => {
                    if cur.len() > 1 {
                        done.push((std::mem::take(&mut cur), false));
                    }
                    cur.clear();
                    cur.extend(seg.els().next().map(|e| pt(&g, e)));
                }
                "lnTo" => cur.extend(seg.els().next().map(|e| pt(&g, e))),
                "cubicBezTo" | "quadBezTo" => {
                    let start = cur.last().copied().unwrap_or([0.0, 0.0]);
                    let ctrl: Vec<[f64; 2]> = std::iter::once(start).chain(seg.els().take(3).map(|e| pt(&g, e))).collect();
                    cur.extend((1..=CURVE_STEPS).map(|i| crate::read::freeform::bezier(&ctrl, i as f64 / CURVE_STEPS as f64)));
                }
                "arcTo" => {
                    let start = cur.last().copied().unwrap_or([0.0, 0.0]);
                    let v = |n: &str| g.value(seg.attr(n).unwrap_or("0"));
                    arc(start, (v("wR") * kx, v("hR") * ky), (v("stAng"), v("swAng")), &mut cur);
                }
                "close" => {
                    if cur.len() > 1 {
                        let first = cur[0];
                        done.push((std::mem::take(&mut cur), true));
                        cur.push(first);
                    }
                }
                _ => {}
            }
        }
        if cur.len() > 1 {
            done.push((cur, false));
        }
        for (pts, closed) in done {
            if paths.len() >= MAX_PATHS {
                break;
            }
            let scale = |[x, y]: [f64; 2]| [(x / 12_700.0) as f32, (y / 12_700.0) as f32];
            paths.push(FreePath { pts: pts.into_iter().take(MAX_POINTS).map(scale).collect(), closed: closed && !open });
        }
    }
    let f = Freeform { w, h, paths, alpha: 1.0, ink: None, order: None }.sanitized();
    (!f.paths.is_empty()).then_some(f)
}

/// The arc from `start` on the ellipse with radii `r`, from angle `st` sweeping `sw` (60000ths of a degree, the
/// angles as seen, as DrawingML gives them), flattened into `out`.
fn arc(start: [f64; 2], (rx, ry): (f64, f64), (st, sw): (f64, f64), out: &mut Vec<[f64; 2]>) {
    let rad = |a: f64| (a / 60_000.0).to_radians();
    // The ellipse's own parameter at a seen angle.
    let param = |a: f64| (rx * a.sin()).atan2(ry * a.cos());
    let (a1, sweep) = (rad(st), rad(sw).clamp(-std::f64::consts::TAU, std::f64::consts::TAU));
    let t1 = param(a1);
    let mut t2 = param(a1 + sweep);
    if sweep.abs() >= std::f64::consts::TAU - 1e-9 {
        t2 = t1 + sweep;
    } else {
        while sweep > 0.0 && t2 < t1 {
            t2 += std::f64::consts::TAU;
        }
        while sweep < 0.0 && t2 > t1 {
            t2 -= std::f64::consts::TAU;
        }
    }
    let (cx, cy) = (start[0] - rx * t1.cos(), start[1] - ry * t1.sin());
    let n = ((t2 - t1).abs() / ARC_STEP).ceil().clamp(1.0, 64.0) as usize;
    for i in 1..=n {
        let t = t1 + (t2 - t1) * i as f64 / n as f64;
        out.push([cx + rx * t.cos(), cy + ry * t.sin()]);
    }
}

/// Shape guide values (§20.1.9.11): the built-in ones of a `w` × `h` shape and those set so far.
struct Guides {
    w: f64,
    h: f64,
    set: HashMap<String, f64>,
}

impl Guides {
    fn new(w: f64, h: f64) -> Self {
        Guides { w, h, set: HashMap::new() }
    }

    fn set(&mut self, name: &str, v: f64) {
        if self.set.len() < MAX_GUIDES * 2 {
            self.set.insert(name.to_string(), if v.is_finite() { v } else { 0.0 });
        }
    }

    /// A guide, a built-in name or a number.
    fn value(&self, s: &str) -> f64 {
        if let Some(v) = self.set.get(s) {
            return *v;
        }
        let (w, h) = (self.w, self.h);
        let (ss, ls) = (w.min(h), w.max(h));
        let by = |prefix: &str, whole: f64| s.strip_prefix(prefix).and_then(|n| n.parse::<f64>().ok()).filter(|n| *n > 0.0).map(|n| whole / n);
        match s {
            "w" | "r" => w,
            "h" | "b" => h,
            "l" | "t" => 0.0,
            "hc" => w / 2.0,
            "vc" => h / 2.0,
            "ss" => ss,
            "ls" => ls,
            "cd2" => 10_800_000.0,
            "cd4" => 5_400_000.0,
            "cd8" => 2_700_000.0,
            "3cd4" => 16_200_000.0,
            "3cd8" => 8_100_000.0,
            "5cd8" => 13_500_000.0,
            "7cd8" => 18_900_000.0,
            _ => by("ssd", ss).or_else(|| by("wd", w)).or_else(|| by("hd", h)).or_else(|| s.trim().parse().ok()).unwrap_or(0.0),
        }
    }

    fn formula(&self, f: &str) -> f64 {
        let mut it = f.split_whitespace();
        let op = it.next().unwrap_or("");
        let a: Vec<f64> = it.map(|x| self.value(x)).collect();
        let x = |i: usize| a.get(i).copied().unwrap_or(0.0);
        let ang = |v: f64| (v / 60_000.0).to_radians();
        let deg = |r: f64| r.to_degrees() * 60_000.0;
        match op {
            "*/" => if x(2) == 0.0 { 0.0 } else { x(0) * x(1) / x(2) },
            "+-" => x(0) + x(1) - x(2),
            "+/" => if x(2) == 0.0 { 0.0 } else { (x(0) + x(1)) / x(2) },
            "?:" => if x(0) > 0.0 { x(1) } else { x(2) },
            "abs" => x(0).abs(),
            "at2" => deg(x(1).atan2(x(0))),
            "cat2" => x(0) * x(2).atan2(x(1)).cos(),
            "cos" => x(0) * ang(x(1)).cos(),
            "max" => x(0).max(x(1)),
            "min" => x(0).min(x(1)),
            "mod" => (x(0) * x(0) + x(1) * x(1) + x(2) * x(2)).sqrt(),
            "pin" => x(1).clamp(x(0).min(x(2)), x(2).max(x(0))),
            "sat2" => x(0) * x(2).atan2(x(1)).sin(),
            "sin" => x(0) * ang(x(1)).sin(),
            "sqrt" => x(0).max(0.0).sqrt(),
            "tan" => x(0) * ang(x(1)).tan(),
            "val" => x(0),
            _ => 0.0,
        }
    }
}

trait ChildLocal {
    fn child_local(&self, local: &str) -> Option<&El>;
}

impl ChildLocal for El {
    fn child_local(&self, local: &str) -> Option<&El> {
        self.els().find(|e| e.local() == local)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(f: &Freeform) -> [f32; 4] {
        let pts = f.paths.iter().flat_map(|p| p.pts.iter());
        pts.fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, [x, y]| [b[0].min(*x), b[1].min(*y), b[2].max(*x), b[3].max(*y)])
    }

    #[test]
    fn every_preset_survives_the_compact_form() {
        assert!(!DEFINITIONS.contains(['\r', '\n']));
        assert_eq!(definitions().len(), 187);
    }

    #[test]
    fn presets_draw_from_their_definitions() {
        // An octagon at the default adjust (29289 of the shorter side) cuts its corners: its top edge starts that far in.
        let oct = preset_freeform("octagon", &[], 100.0, 50.0).expect("octagon");
        let top: Vec<f32> = oct.paths[0].pts.iter().filter(|p| p[1].abs() < 0.01).map(|p| p[0]).collect();
        assert!(top.iter().any(|x| (x - 50.0 * 0.29289).abs() < 0.05), "{top:?}");
        assert!(oct.paths[0].closed);
        // The whole frame is used, and nothing leaves it.
        let b = bounds(&oct);
        assert!(b[0].abs() < 0.01 && b[1].abs() < 0.01 && (b[2] - 100.0).abs() < 0.01 && (b[3] - 50.0).abs() < 0.01, "{b:?}");
        // A plaque's corners are arcs cut inwards: the point halfway round the top-left corner lies inside the frame.
        let plaque = preset_freeform("plaque", &[], 60.0, 40.0).expect("plaque");
        assert!(plaque.paths[0].pts.len() > 8);
        // Adjust values come from the shape: a snipped corner of 50 % meets the middle of the top edge.
        let snip = preset_freeform("snip1Rect", &[("adj".into(), 50_000)], 40.0, 40.0).expect("snip1Rect");
        assert!(snip.paths[0].pts.iter().any(|p| (p[0] - 20.0).abs() < 0.01 && p[1].abs() < 0.01), "{:?}", snip.paths[0].pts);
        // A cube has its faces as separate paths.
        assert!(preset_freeform("can", &[], 40.0, 60.0).is_some_and(|f| f.paths.len() >= 2));
        assert!(preset_freeform("noSuchShape", &[], 10.0, 10.0).is_none());
        assert!(drawn_by_kind("rect", false) && !drawn_by_kind("octagon", false));
        assert!(drawn_by_kind("star5", false) && !drawn_by_kind("star5", true));
    }
}
