//! EasyWriter engine-gaps-pictures: a picture's outline and effects from its `pic:spPr` (Picture Format › Picture Border and
//! Picture Effects): `a:ln` with its dashes and Word 365's sketched look, `a:effectLst`, and the 3-D rotation and bevel of
//! `a:scene3d` and `a:sp3d`.

use ew_doc::adjust::{Artistic, PictureAdjust, Recolor};
use ew_doc::effects::{Bevel, BevelKind, Rotation3d, ShapeEffects};
use ew_doc::line_dash::{Outline, Sketch};

use super::{El, Rgb, int, measure};

/// The picture's outline: `a:ln` with a colour (`a:noFill`, or no fill at all, is none), its width (Word's 0.75 pt when the
/// file gives none), dashes and sketched look.
pub(super) fn outline(sppr: &El, theme: &[Rgb]) -> Option<Outline> {
    let ln = sppr.child("a:ln")?;
    if ln.child("a:noFill").is_some() {
        return None;
    }
    let color = crate::read::drawing_color::fill_colour(ln, theme)?;
    let width = ln.attr("w").and_then(|v| measure(v, 12_700.0)).unwrap_or(0.75);
    let sketch = ln
        .child("a:extLst")
        .into_iter()
        .flat_map(|l| l.els())
        .filter(|e| e.attr("uri") == Some(crate::SKETCH_URI))
        .flat_map(|e| e.els())
        .flat_map(|p| p.els().filter(|t| t.local() == "type"))
        .flat_map(|t| t.els())
        .map(|k| Sketch::from_ooxml(k.local()))
        .next()
        .unwrap_or_default();
    let o = Outline { color, width, dash: crate::read::shape_style::line_dash(Some(ln)), sketch };
    Some(Outline { width: o.width(), ..o })
}

/// The picture's effects: its effect list, then its 3-D rotation and top bevel.
pub(super) fn effects(sppr: &El) -> ShapeEffects {
    let mut fx = sppr.child("a:effectLst").map(super::drawing::effect_list).unwrap_or_default();
    let deg = |e: &El, n: &str| e.attr(n).and_then(int).map(|v| (v.rem_euclid(21_600_000) as f32) / 60_000.0);
    if let Some(cam) = sppr.child("a:scene3d").and_then(|s| s.child("a:camera")) {
        let rot = cam.child("a:rot").map(|r| [deg(r, "lat").unwrap_or(0.0), deg(r, "lon").unwrap_or(0.0), deg(r, "rev").unwrap_or(0.0)]);
        let fov = deg(cam, "fov");
        fx.rotation = Some(Rotation3d::from_camera(cam.attr("prst").unwrap_or("orthographicFront"), rot, fov));
    }
    if let Some(b) = sppr.child("a:sp3d").and_then(|s| s.child("a:bevelT")) {
        let len = |n: &str| b.attr(n).and_then(|v| measure(v, 12_700.0)).unwrap_or(6.0);
        let kind = b.attr("prst").map_or(Some(BevelKind::Circle), BevelKind::from_ooxml);
        fx.bevel = kind.map(|kind| Bevel { kind, width: len("w"), height: len("h") });
    }
    fx.sanitized()
}

/// EasyWriter engine-pictures-2: the `a:blip` extension holding Word 2010's corrections (`a14:imgProps`), and the one
/// holding an SVG picture (`asvg:svgBlip`), whose own `a:blip` is the SVG's PNG copy.
pub(crate) const IMG_PROPS_URI: &str = "{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}";
pub(crate) const SVG_URI: &str = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}";
/// EasyWriter engine-pictures-3: the `a:blip` extension holding the picture Word showed over an HD Photo original
/// (`Float::word_copy`), written when the picture shows a later change drawn on it. Word ignores it; the engine draws the
/// next change from it instead of over the shown picture, so changes don't stack once more at each reload.
pub(crate) const WORD_COPY_URI: &str = "{4C5E2B7A-9D13-4F86-A0B1-6E2D8C3F5A47}";
/// The namespace of EasyWriter's own elements in it.
pub(crate) const EW_DRAWING_NS: &str = "urn:easywriter:drawing:2026";

/// What `ew:wordCopy` records of the picture it was written beside: the SHA-256 of its bytes, in lower-case hex.
pub(crate) fn shown_digest(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The child of `blip`'s extension `uri` named `local` (any prefix).
fn ext_el<'a>(blip: &'a El, uri: &str, local: &str) -> Option<&'a El> {
    let ext = blip.child("a:extLst")?.els().find(|e| e.name == "a:ext" && e.attr("uri") == Some(uri))?;
    ext.els().find(|e| e.local() == local)
}

/// The relationship of the SVG picture a blip stands for.
pub(super) fn svg_rid(blip: &El) -> Option<&str> {
    ext_el(blip, SVG_URI, "svgBlip")?.attr("r:embed")
}

/// Word 2010's corrections (`a14:imgLayer`): the relationship of the picture they were drawn from, and the effects.
fn img_layer(blip: &El) -> Option<&El> {
    ext_el(blip, IMG_PROPS_URI, "imgProps")?.els().find(|e| e.local() == "imgLayer")
}

pub(super) fn layer_rid(blip: &El) -> Option<&str> {
    img_layer(blip)?.attr("r:embed")
}

/// A picture's colour and corrections from its `a:blip`: Word 2007's blip effects (drawn live) and Word 2010's
/// (`a14:imgEffect`, in the picture's pixels). Shares in thousandths of a percent become percent.
pub(super) fn adjust(blip: &El, theme: &[Rgb]) -> PictureAdjust {
    let pct = |e: &El, k: &str| e.attr(k).and_then(int).map(|v| v as f32 / 1000.0);
    let mut a = PictureAdjust::default();
    for e in blip.els() {
        match e.name.as_str() {
            "a:alphaModFix" => a.transparency = 100.0 - pct(e, "amt").unwrap_or(100.0),
            "a:lum" => a.lum = Some([pct(e, "bright").unwrap_or(0.0), pct(e, "contrast").unwrap_or(0.0)]),
            "a:grayscl" => a.recolor = Some(Recolor::Grayscale),
            "a:biLevel" => a.recolor = Some(Recolor::BlackWhite(pct(e, "thresh").unwrap_or(50.0))),
            "a:duotone" => {
                let cs: Vec<Rgb> = e.els().filter_map(|c| crate::read::drawing_color::color(c, theme)).collect();
                if let [from, to] = cs[..] {
                    a.recolor = Some(Recolor::Duotone(from, to));
                }
            }
            // Set Transparent Color: a colour changed to the same one fully clear.
            "a:clrChange" => {
                let to = e.child("a:clrTo").and_then(|t| crate::read::drawing_color::color_alpha(t, theme, None));
                if to.is_some_and(|(_, t)| t >= 100.0) {
                    a.clear = e.child("a:clrFrom").and_then(|f| crate::read::drawing_color::color(f, theme));
                }
            }
            _ => {}
        }
    }
    if let Some(l) = img_layer(blip) {
        img_effects(&mut a, l);
    }
    a.sanitized()
}

/// Word 2010's corrections (`a14:imgEffect`) under `el` into `a`.
fn img_effects(a: &mut PictureAdjust, el: &El) {
    let pct = |e: &El, k: &str| e.attr(k).and_then(int).map(|v| v as f32 / 1000.0);
    for fx in el.els().filter(|e| e.local() == "imgEffect").flat_map(|e| e.els()) {
        match fx.local() {
            "brightnessContrast" => {
                a.brightness = pct(fx, "bright").unwrap_or(0.0);
                a.contrast = pct(fx, "contrast").unwrap_or(0.0);
            }
            "sharpenSoften" => a.sharpen = pct(fx, "amount").unwrap_or(0.0),
            "saturation" => a.saturation = pct(fx, "sat"),
            "colorTemperature" => a.temperature = fx.attr("colorTemp").and_then(int).map(|v| v as f32),
            n => {
                if let Some(effect) = n.strip_prefix("artistic") {
                    let attrs = fx.attrs.iter().filter_map(|(k, v)| Some((k.rsplit(':').next().unwrap_or(k).to_string(), int(v)?))).collect();
                    a.artistic = Some(Artistic { effect: effect.to_string(), attrs });
                }
            }
        }
    }
}

/// EasyWriter engine-pictures-3: the picture Word showed over an HD Photo original ([`WORD_COPY_URI`]): its relationship and
/// the settings Word drew into it, while the picture beside it is still the one EasyWriter wrote, `shown` its bytes (a file
/// another program changed draws the next change over the picture it shows). engine-fixes-2-edit: the record is the shown
/// picture's SHA-256 ([`shown_digest`]); its byte length, before, let a changed picture of the same length keep the copy.
pub(super) fn word_copy<'a>(blip: &'a El, shown: &[u8]) -> Option<(&'a str, PictureAdjust)> {
    let el = ext_el(blip, WORD_COPY_URI, "wordCopy")?;
    if el.attr("sha256")? != shown_digest(shown) {
        return None;
    }
    let mut a = PictureAdjust::default();
    img_effects(&mut a, el);
    Some((el.attr("r:embed")?, a.sanitized()))
}
