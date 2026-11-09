//! EasyWriter engine-pictures-2: a picture's colour and corrections (Picture Format › Adjust), kept as Word keeps them on the
//! picture's `a:blip`. Two kinds, as in Word:
//!
//! - Word 2007's blip effects (Recolor, Washout, a:lum, Transparency, Set Transparent Color) are settings over the picture's
//!   pixels: the painter draws them ([`Live::apply`]) and Word draws them too.
//! - Word 2010's (`a14:imgEffect`: Corrections, Color Saturation and Tone, Artistic Effects) are in the picture's pixels: Word
//!   keeps the picture they were drawn from beside it (`a14:imgLayer`, [`crate::para::PictureFloat::layer`]) and does not draw them
//!   itself (its probe: a file whose `a:blip` is the plain picture shows the plain picture). The engine draws them into a copy
//!   of that original at each change, so changes never stack, and Reset Picture gives the original back.

use serde::{Deserialize, Serialize};

use crate::props::Rgb;

/// A picture's adjustments. Percentages as Word's Format Picture pane shows them; the default changes nothing.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PictureAdjust {
    /// `a:lum`: brightness and contrast, -100 to 100 (Word's Washout is 70, -70). Drawn live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lum: Option<[f32; 2]>,
    /// Recolor (`a:grayscl`, `a:biLevel`, `a:duotone`). Drawn live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recolor: Option<Recolor>,
    /// Transparency, percent (`a:alphaModFix`). Drawn live.
    #[serde(skip_serializing_if = "is_zero")]
    pub transparency: f32,
    /// Set Transparent Color (`a:clrChange` to a clear colour). Drawn live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear: Option<Rgb>,
    /// Corrections: brightness and contrast (`a14:brightnessContrast`), sharpen (plus) or soften (minus)
    /// (`a14:sharpenSoften`), -100 to 100. In the pixels.
    #[serde(skip_serializing_if = "is_zero")]
    pub brightness: f32,
    #[serde(skip_serializing_if = "is_zero")]
    pub contrast: f32,
    #[serde(skip_serializing_if = "is_zero")]
    pub sharpen: f32,
    /// Color Saturation, percent, 100 unchanged (`a14:saturation`). In the pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saturation: Option<f32>,
    /// Color Tone, kelvin, 6500 unchanged (`a14:colorTemperature`). In the pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// An artistic effect (`a14:artistic*`). In the pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artistic: Option<Artistic>,
}

/// The picture Word showed for one whose original ([`crate::para::PictureFloat::layer`]) is HD Photo, which the engine can't decode:
/// its media key and the Word 2010 settings Word drew into its pixels. Each change is drawn from it rather than from the copy
/// an earlier change made, so changes stack at most once (on Word's own), also after a reload, and Reset Picture goes back to
/// it with Word's settings, the nearest the engine can come to the original.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WordCopy {
    pub media: String,
    pub adjust: PictureAdjust,
}

/// Recolor: grey, two-tone (`a:duotone`, black to a colour for a dark variation, a colour to white for a light one, Word's
/// Sepia) or black and white at a threshold (percent).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Recolor {
    Grayscale,
    BlackWhite(f32),
    Duotone(Rgb, Rgb),
}

/// An artistic effect as Word writes it: the element's name after `a14:artistic` (`Blur`, `PencilSketch`, ...) and its
/// attributes, kept to write back.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Artistic {
    pub effect: String,
    pub attrs: Vec<(String, i64)>,
}

/// Word's Washout (`a:lum bright="70000" contrast="-70000"`).
pub const WASHOUT: [f32; 2] = [70.0, -70.0];
/// Most attributes an artistic effect keeps.
const MAX_ARTISTIC_ATTRS: usize = 8;

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

fn pct(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() { v.clamp(lo, hi) } else { 0.0 }
}

impl PictureAdjust {
    pub fn is_empty(&self) -> bool {
        *self == PictureAdjust::default()
    }
    /// Whether any of Word 2010's adjustments (those in the pixels) is set.
    pub fn in_pixels(&self) -> bool {
        self.brightness != 0.0
            || self.contrast != 0.0
            || self.sharpen != 0.0
            || self.saturation.is_some_and(|s| s != 100.0)
            || self.temperature.is_some_and(|t| t != 6500.0)
            || self.artistic.is_some()
    }
    /// Whether `other` has the same adjustments in the pixels as this one (neutral values counting as unset).
    pub fn same_pixels(&self, other: &PictureAdjust) -> bool {
        let part = |a: &PictureAdjust| {
            let a = a.clone().sanitized();
            (a.brightness, a.contrast, a.sharpen, a.saturation, a.temperature, a.artistic)
        };
        part(self) == part(other)
    }
    /// These settings with the ones in the pixels (Word 2010's) of `from` instead of their own.
    pub fn with_pixels_of(&self, from: &PictureAdjust) -> PictureAdjust {
        PictureAdjust { lum: self.lum, recolor: self.recolor, transparency: self.transparency, clear: self.clear, ..from.clone() }
    }
    /// What the painter draws over the picture.
    pub fn live(&self) -> Live {
        Live { lum: self.lum, recolor: self.recolor, alpha: 1.0 - pct(self.transparency, 0.0, 100.0) / 100.0, clear: self.clear }
    }
    /// Finite and in range, neutral values dropped (a file or a command may give anything).
    pub fn sanitized(mut self) -> PictureAdjust {
        self.lum = self.lum.map(|[b, c]| [pct(b, -100.0, 100.0), pct(c, -100.0, 100.0)]).filter(|l| *l != [0.0, 0.0]);
        self.recolor = self.recolor.map(|r| match r {
            Recolor::BlackWhite(t) => Recolor::BlackWhite(pct(t, 0.0, 100.0)),
            r => r,
        });
        self.transparency = pct(self.transparency, 0.0, 100.0);
        self.brightness = pct(self.brightness, -100.0, 100.0);
        self.contrast = pct(self.contrast, -100.0, 100.0);
        self.sharpen = pct(self.sharpen, -100.0, 100.0);
        self.saturation = self.saturation.map(|s| pct(s, 0.0, 400.0)).filter(|s| *s != 100.0);
        self.temperature = self.temperature.map(|t| if t.is_finite() { t.clamp(1500.0, 11500.0) } else { 6500.0 }).filter(|t| *t != 6500.0);
        if let Some(a) = &mut self.artistic {
            a.effect.retain(|c| c.is_ascii_alphanumeric());
            a.effect.truncate(40);
            a.attrs.truncate(MAX_ARTISTIC_ATTRS);
            a.attrs.retain(|(k, _)| !k.is_empty() && k.len() <= 40 && k.bytes().all(|b| b.is_ascii_alphanumeric()));
        }
        self.artistic = self.artistic.filter(|a| !a.effect.is_empty());
        self
    }
    /// The Recolor gallery's name for the picture's recolour, as the Format Picture pane shows it: `grayscale`, `sepia`,
    /// `washout`, `blackAndWhite`, `dark` (black to a colour), `light` (a colour to white), `duotone` or `none`.
    pub fn recolor_name(&self) -> &'static str {
        match self.recolor {
            Some(Recolor::Grayscale) => "grayscale",
            Some(Recolor::BlackWhite(_)) => "blackAndWhite",
            Some(Recolor::Duotone(a, b)) if a == Rgb::BLACK && b == sepia() => "sepia",
            Some(Recolor::Duotone(a, _)) if a == Rgb::BLACK => "dark",
            Some(Recolor::Duotone(_, b)) if b == Rgb::WHITE => "light",
            Some(Recolor::Duotone(..)) => "duotone",
            None if self.lum == Some(WASHOUT) => "washout",
            None => "none",
        }
    }
}

/// Word's Sepia: a duotone from black to D9C3A5 at a 50 % tint and 180 % saturation.
pub fn sepia() -> Rgb {
    Rgb(0xD9, 0xC3, 0xA5).modified("tint", 0.5).modified("satMod", 1.8)
}

/// The blip effects drawn over a picture, in Word's order: the transparent colour, the recolour, brightness and contrast,
/// then the transparency.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Live {
    pub lum: Option<[f32; 2]>,
    pub recolor: Option<Recolor>,
    /// Opacity 0 to 1.
    pub alpha: f32,
    pub clear: Option<Rgb>,
}

impl Default for Live {
    fn default() -> Self {
        Live { lum: None, recolor: None, alpha: 1.0, clear: None }
    }
}

/// How far a pixel may be from Set Transparent Color's colour and still turn clear, per channel: JPEG noise near it counts.
const CLEAR_TOLERANCE: i32 = 12;

impl Live {
    pub fn is_empty(&self) -> bool {
        *self == Live::default()
    }
    /// One straight (not premultiplied) RGBA pixel with the effects drawn on it.
    pub fn apply(&self, [r, g, b, a]: [u8; 4]) -> [u8; 4] {
        if let Some(c) = self.clear {
            let near = |x: u8, y: u8| (i32::from(x) - i32::from(y)).abs() <= CLEAR_TOLERANCE;
            if near(r, c.0) && near(g, c.1) && near(b, c.2) {
                return [r, g, b, 0];
            }
        }
        let mut px = [f32::from(r), f32::from(g), f32::from(b)];
        if let Some(rc) = self.recolor {
            let l = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
            px = match rc {
                Recolor::Grayscale => [l; 3],
                Recolor::BlackWhite(t) => [if l >= t * 2.55 { 255.0 } else { 0.0 }; 3],
                Recolor::Duotone(from, to) => {
                    let k = l / 255.0;
                    let mix = |a: u8, b: u8| f32::from(a) + (f32::from(b) - f32::from(a)) * k;
                    [mix(from.0, to.0), mix(from.1, to.1), mix(from.2, to.2)]
                }
            };
        }
        if let Some([bright, contrast]) = self.lum {
            px = px.map(|v| lum(v, bright, contrast));
        }
        let alpha = if self.alpha.is_finite() { self.alpha.clamp(0.0, 1.0) } else { 1.0 };
        let [r, g, b] = px.map(|v| v.round().clamp(0.0, 255.0) as u8);
        [r, g, b, (f32::from(a) * alpha).round() as u8]
    }
}

/// A channel (0 to 255) at brightness and contrast `bright` and `contrast` (-100 to 100), as Word draws `a:lum` (its
/// probe: red 192 at brightness 40 is 255, grey 128 is 230; at contrast 40 red is 234): contrast turns about mid grey, by
/// 1 / (1 - c) above zero and 1 + c below, then brightness adds.
pub fn lum(v: f32, bright: f32, contrast: f32) -> f32 {
    let c = pct(contrast, -100.0, 100.0) / 100.0;
    let slope = if c >= 0.0 { (1.0 / (1.0 - c).max(0.01)).min(100.0) } else { 1.0 + c };
    ((v / 255.0 - 0.5) * slope + 0.5 + pct(bright, -100.0, 100.0) / 100.0) * 255.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lum_draws_as_word_draws_it() {
        // Word's own drawing of a:lum (the engine-pictures-2 probe).
        let lit = Live { lum: Some([40.0, 0.0]), ..Live::default() };
        assert_eq!(lit.apply([192, 0, 0, 255]), [255, 102, 102, 255]);
        assert_eq!(lit.apply([128, 128, 128, 255]), [230, 230, 230, 255]);
        let sharp = Live { lum: Some([0.0, 40.0]), ..Live::default() };
        let [r, ..] = sharp.apply([192, 0, 0, 255]);
        assert!((233..=236).contains(&r), "{r}");
    }

    #[test]
    fn recolours_and_transparency() {
        let dark = Live { recolor: Some(Recolor::Duotone(Rgb::BLACK, Rgb(0xC0, 0, 0))), alpha: 0.5, ..Live::default() };
        assert_eq!(dark.apply([255, 255, 255, 255]), [192, 0, 0, 128]);
        let clear = Live { clear: Some(Rgb(10, 20, 30)), ..Live::default() };
        assert_eq!(clear.apply([15, 20, 25, 255])[3], 0);
        assert_eq!(clear.apply([100, 20, 25, 255])[3], 255);
    }

    #[test]
    fn neutral_values_are_dropped() {
        let a = PictureAdjust { saturation: Some(100.0), temperature: Some(6500.0), lum: Some([0.0, 0.0]), ..Default::default() }.sanitized();
        assert!(a.is_empty() && !a.in_pixels());
        let w = PictureAdjust { lum: Some(WASHOUT), ..Default::default() };
        assert_eq!(w.recolor_name(), "washout");
    }
}
