//! EasyWriter engine-gaps-shapes: a gradient or pattern page background (Design › Page Color › Fill Effects), read from
//! `w:background/v:background/v:fill` as Word writes it. A picture or texture one is the page picture (read.rs).

use ew_doc::fill::{Fill, PatternFill, pattern_named};
use ew_doc::props::Rgb;

use super::shape_style::{vml_color, vml_fill};
use crate::xml::El;

/// The gradient or pattern fill of `w:background` `bg`, or `None` for a solid colour, a picture or texture, or none.
/// A pattern's set bits take the background's `fillcolor` (else `w:color`) and the rest `color2`, as VML's pattern fill
/// draws the black and white of its picture; the preset is named by its title (Word's label).
pub(crate) fn page_fill(bg: &El) -> Option<Fill> {
    let vb = bg.child("v:background")?;
    let fill = vb.child("v:fill")?;
    let color = || vb.attr("fillcolor").and_then(vml_color).or_else(|| bg.attr("w:color").and_then(Rgb::parse));
    match fill.attr("type")?.trim() {
        "gradient" | "gradientRadial" => vml_fill(vb, None).filter(|f| matches!(f, Fill::Gradient(_))),
        "pattern" => {
            let preset = fill.attr("o:title").and_then(pattern_named).unwrap_or("pct50");
            let fg = color().unwrap_or(Rgb::BLACK);
            let bg = fill.attr("color2").and_then(vml_color).unwrap_or(Rgb::WHITE);
            Some(Fill::Pattern(PatternFill { preset: preset.into(), fg, bg }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(xml: &str) -> El {
        let ns = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;
        crate::xml::parse(xml.replacen("<w:background", &format!("<w:background {ns}"), 1).as_bytes()).unwrap_or_else(|e| panic!("{e:?}"))
    }

    #[test]
    fn gradient_and_pattern_backgrounds_read() {
        let g = el(r##"<w:background w:color="FF0000"><v:background fillcolor="red"><v:fill color2="blue" type="gradient" angle="-90"/></v:background></w:background>"##);
        let Some(Fill::Gradient(gr)) = page_fill(&g) else { panic!("{:?}", page_fill(&g)) };
        assert_eq!((gr.stops[0].color, gr.stops[1].color), (Rgb(255, 0, 0), Rgb(0, 0, 255)));
        let p = el(r##"<w:background w:color="00FF00"><v:background><v:fill r:id="rId4" o:title="Light upward diagonal" color2="#0000ff" type="pattern"/></v:background></w:background>"##);
        assert_eq!(page_fill(&p), Some(Fill::Pattern(PatternFill { preset: "ltUpDiag".into(), fg: Rgb(0, 255, 0), bg: Rgb(0, 0, 255) })));
        // Word draws a pattern's set bits in fillcolor and the rest in color2 (a pdf.ps1 render of this markup, 2026-10-31:
        // red 5% dots on yellow), so fillcolor is the foreground.
        let p = el(r##"<w:background w:color="FF0000"><v:background fillcolor="#FF0000"><v:fill r:id="rId1" o:title="5%" color2="#FFFF00" type="pattern"/></v:background></w:background>"##);
        assert_eq!(page_fill(&p), Some(Fill::Pattern(PatternFill { preset: "pct5".into(), fg: Rgb(255, 0, 0), bg: Rgb(255, 255, 0) })));
        let t = el(r##"<w:background><v:background><v:fill r:id="rId4" o:title="Papyrus" type="tile"/></v:background></w:background>"##);
        assert_eq!(page_fill(&t), None);
    }
}
