//! EasyWriter engine-gaps-pictures: a picture's outline and effects into its `pic:spPr`, after its geometry and in the
//! schema's order (`a:ln`, `a:effectLst`, `a:scene3d`, `a:sp3d`), as Word writes Picture Border and Picture Effects.

use ew_doc::adjust::{PictureAdjust, Recolor};
use ew_doc::effects::ShapeEffects;
use ew_doc::line_dash::Outline;
use ew_doc::props::Rgb;

use crate::read::{EW_DRAWING_NS, IMG_PROPS_URI, SVG_URI, WORD_COPY_URI, shown_digest};

use super::{W, emu, n};

/// The outline, effects, 3-D rotation and bevel of a picture.
pub(super) fn picture_look(w: &mut W, outline: Option<&Outline>, fx: &ShapeEffects) {
    if let Some(o) = outline {
        line(w, o);
    }
    super::drawing::effect_list(w, fx);
    three_d(w, fx);
}

/// `a:ln`: a solid colour, its dashes and, when sketched, Word 365's sketched-line extension (which Word versions before it
/// leave out, drawing the line plainly).
fn line(w: &mut W, o: &Outline) {
    w.open("a:ln", &[("w", &emu(o.width()))]);
    w.open("a:solidFill", &[]);
    w.empty("a:srgbClr", &[("val", &o.color.hex())]);
    w.close("a:solidFill");
    super::drawing::line_dash(w, &o.dash);
    if let Some(kind) = o.sketch.ooxml() {
        w.open("a:extLst", &[]);
        w.open("a:ext", &[("uri", crate::SKETCH_URI)]);
        // `sd` seeds Word's hand-drawn wobble; any number draws.
        w.open("ask:lineSketchStyleProps", &[("xmlns:ask", "http://schemas.microsoft.com/office/drawing/2018/sketchyshapes"), ("sd", "1219033472")]);
        w.open("a:prstGeom", &[("prst", "rect")]);
        w.empty("a:avLst", &[]);
        w.close("a:prstGeom");
        w.open("ask:type", &[]);
        w.empty(&format!("ask:{kind}"), &[]);
        w.close("ask:type");
        w.close("ask:lineSketchStyleProps");
        w.close("a:ext");
        w.close("a:extLst");
    }
    w.close("a:ln");
}

/// `a:scene3d` (the camera, Word's three-point light from the top) and `a:sp3d` (the top bevel), when there is a rotation or a
/// bevel.
fn three_d(w: &mut W, fx: &ShapeEffects) {
    let fx = fx.sanitized();
    if fx.rotation.is_none() && fx.bevel.is_none() {
        return;
    }
    let deg = |v: f32| n((v * 60_000.0).round() as i64 % 21_600_000);
    w.open("a:scene3d", &[]);
    let rot = fx.rotation.unwrap_or_default();
    let (prst, angles) = rot.camera();
    let mut attrs = vec![("prst", prst.to_string())];
    if rot.fov > 0.0 && (rot.fov - ew_doc::effects::DEFAULT_FOV).abs() > 0.05 {
        attrs.push(("fov", deg(rot.fov)));
    }
    let attrs: Vec<(&str, &str)> = attrs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match angles {
        Some([lat, lon, rev]) => {
            w.open("a:camera", &attrs);
            w.empty("a:rot", &[("lat", &deg(lat)), ("lon", &deg(lon)), ("rev", &deg(rev))]);
            w.close("a:camera");
        }
        None => w.empty("a:camera", &attrs),
    }
    w.empty("a:lightRig", &[("rig", "threePt"), ("dir", "t")]);
    w.close("a:scene3d");
    if let Some(b) = fx.bevel {
        w.open("a:sp3d", &[]);
        w.empty("a:bevelT", &[("w", &emu(b.width)), ("h", &emu(b.height)), ("prst", b.kind.ooxml())]);
        w.close("a:sp3d");
    }
}

/// The relationship type of the picture Word 2010's corrections were drawn from (`a14:imgLayer`).
pub(super) const HDPHOTO: &str = "http://schemas.microsoft.com/office/2007/relationships/hdphoto";

/// EasyWriter engine-pictures-2: a picture's `a:blip` (`attrs`: its `r:embed` and `r:link`) with its colour settings as
/// Word writes them: Word 2007's blip effects, which Word draws live, then Word 2010's corrections over the picture `layer`
/// (the relationship of the picture they were drawn from; the shown one when the file gave none), and the SVG picture
/// `svg` the blip is the PNG copy of; EasyWriter's `copy` (the relationship of the picture Word showed over an HD Photo
/// original, the settings Word drew into it and the byte length of the blip's own picture) after them.
pub(super) fn blip(w: &mut W, attrs: &[(&str, &str)], a: &PictureAdjust, layer: Option<&str>, svg: Option<&str>, copy: Option<(&str, &PictureAdjust, &[u8])>) {
    let main = attrs.iter().find(|(k, _)| *k == "r:embed").map(|(_, v)| *v);
    let layer = layer.or(main).filter(|_| a.in_pixels());
    let live = a.lum.is_some() || a.recolor.is_some() || a.transparency > 0.0 || a.clear.is_some();
    if !live && layer.is_none() && svg.is_none() {
        w.empty("a:blip", attrs);
        return;
    }
    w.open("a:blip", attrs);
    if let Some(c) = a.clear {
        w.open("a:clrChange", &[]);
        w.open("a:clrFrom", &[]);
        w.empty("a:srgbClr", &[("val", &c.hex())]);
        w.close("a:clrFrom");
        w.open("a:clrTo", &[]);
        w.open("a:srgbClr", &[("val", &c.hex())]);
        w.empty("a:alpha", &[("val", "0")]);
        w.close("a:srgbClr");
        w.close("a:clrTo");
        w.close("a:clrChange");
    }
    match a.recolor {
        Some(Recolor::Grayscale) => w.empty("a:grayscl", &[]),
        Some(Recolor::BlackWhite(t)) => w.empty("a:biLevel", &[("thresh", &pct(t))]),
        Some(Recolor::Duotone(from, to)) => {
            w.open("a:duotone", &[]);
            for c in [from, to] {
                // Word's own black and white ends are preset colours.
                match c {
                    Rgb::BLACK => w.empty("a:prstClr", &[("val", "black")]),
                    Rgb::WHITE => w.empty("a:prstClr", &[("val", "white")]),
                    c => w.empty("a:srgbClr", &[("val", &c.hex())]),
                }
            }
            w.close("a:duotone");
        }
        None => {}
    }
    if let Some([b, c]) = a.lum {
        empty_with(w, "a:lum", &[("bright", b), ("contrast", c)]);
    }
    if a.transparency > 0.0 {
        w.empty("a:alphaModFix", &[("amt", &pct(100.0 - a.transparency))]);
    }
    if layer.is_some() || svg.is_some() {
        w.open("a:extLst", &[]);
        if let Some(l) = layer {
            w.open("a:ext", &[("uri", IMG_PROPS_URI)]);
            w.open("a14:imgProps", &[("xmlns:a14", "http://schemas.microsoft.com/office/drawing/2010/main")]);
            w.open("a14:imgLayer", &[("r:embed", l)]);
            img_effects(w, a);
            w.close("a14:imgLayer");
            w.close("a14:imgProps");
            w.close("a:ext");
        }
        if let Some(s) = svg {
            w.open("a:ext", &[("uri", SVG_URI)]);
            w.empty("asvg:svgBlip", &[("xmlns:asvg", "http://schemas.microsoft.com/office/drawing/2016/SVG/main"), ("r:embed", s)]);
            w.close("a:ext");
        }
        if let (Some((rid, word, shown)), Some(_)) = (copy, layer) {
            w.open("a:ext", &[("uri", WORD_COPY_URI)]);
            let shown = shown_digest(shown);
            w.open("ew:wordCopy", &[("xmlns:ew", EW_DRAWING_NS), ("xmlns:a14", "http://schemas.microsoft.com/office/drawing/2010/main"), ("r:embed", rid), ("sha256", &shown)]);
            img_effects(w, word);
            w.close("ew:wordCopy");
            w.close("a:ext");
        }
        w.close("a:extLst");
    }
    w.close("a:blip");
}

/// A percentage in Word's thousandths of a percent.
fn pct(v: f32) -> String {
    n((v * 1000.0).round() as i64)
}

/// Empty element `name` with the shares in `vals` that are not zero, in thousandths of a percent.
fn empty_with(w: &mut W, name: &str, vals: &[(&str, f32)]) {
    let vals: Vec<(&str, String)> = vals.iter().filter(|(_, v)| *v != 0.0).map(|(k, v)| (*k, pct(*v))).collect();
    let attrs: Vec<(&str, &str)> = vals.iter().map(|(k, v)| (*k, v.as_str())).collect();
    w.empty(name, &attrs);
}

/// Word 2010's corrections, each in its own `a14:imgEffect`, in Word's order.
fn img_effects(w: &mut W, a: &PictureAdjust) {
    let open = |w: &mut W| w.open("a14:imgEffect", &[]);
    if let Some(e) = &a.artistic {
        let vals: Vec<(String, String)> = e.attrs.iter().map(|(k, v)| (k.clone(), n(*v))).collect();
        let attrs: Vec<(&str, &str)> = vals.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        open(w);
        w.empty(&format!("a14:artistic{}", e.effect), &attrs);
        w.close("a14:imgEffect");
    }
    if a.sharpen != 0.0 {
        open(w);
        empty_with(w, "a14:sharpenSoften", &[("amount", a.sharpen)]);
        w.close("a14:imgEffect");
    }
    if let Some(t) = a.temperature {
        open(w);
        w.empty("a14:colorTemperature", &[("colorTemp", &n(t.round() as i64))]);
        w.close("a14:imgEffect");
    }
    if let Some(s) = a.saturation {
        open(w);
        w.empty("a14:saturation", &[("sat", &pct(s))]);
        w.close("a14:imgEffect");
    }
    if a.brightness != 0.0 || a.contrast != 0.0 {
        open(w);
        empty_with(w, "a14:brightnessContrast", &[("bright", a.brightness), ("contrast", a.contrast)]);
        w.close("a14:imgEffect");
    }
}
