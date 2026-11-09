//! A page as the scene crate's display list (P6, docs/plans/engine/viewport-design.md section 3): its paper, its page
//! picture (a backdrop layer), its watermark, then its headers and footers and its body, each a layer. The scene crate
//! paints it and never sees the document; the functions at the end are the document-facing shorthand for that.

use kurbo::{Affine, Shape};
use ew_scene::{DisplayList, FillRule, Group, Layer, Media, PaintOptions, Rendered, VectorPath};

use super::{Document, Draw, Page, Paint, Rect, Rgb, page_layers};
use crate::display::DisplayOptions;

/// Largest page-background picture drawn, in pixels (hostile files).
const MAX_BACKGROUND_PIXELS: u64 = 64 * 1024 * 1024;

/// `page`'s display list. Its paper is the document's page colour, else white.
pub fn page_list(doc: &Document, page: &Page, opts: &DisplayOptions) -> DisplayList {
    let mut layers = Vec::new();
    // EasyWriter engine-gaps-shapes: a gradient or pattern page fill under any page picture.
    if let Some(fill) = doc.settings.page_fill.as_ref().and_then(|f| page_fill(f, page)) {
        layers.push(Layer { backdrop: true, ..Layer::of(vec![fill]) });
    }
    if let Some(p) = page_picture(doc, page) {
        layers.push(Layer { backdrop: true, ..Layer::of(vec![p]) });
    }
    if let Some(r) = rule_lines(doc, page) {
        layers.push(Layer::of(vec![r]));
    }
    if let Some(w) = watermark(doc, page) {
        layers.push(Layer::of(vec![w]));
    }
    for (opacity, items) in page_layers(doc, page, opts) {
        layers.push(Layer { opacity, ..Layer::of(items) });
    }
    DisplayList::new(page.w, page.h, Some(doc.settings.page_color.unwrap_or(Rgb::WHITE)), layers)
}

/// EasyWriter engine-gaps-shapes: a gradient or pattern page fill (Design › Page Color › Fill Effects) over the whole page,
/// a pattern repeated from the page's top left.
fn page_fill(fill: &ew_doc::fill::Fill, page: &Page) -> Option<Draw> {
    let (w, h) = (page.w, page.h.min(1e6));
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return None;
    }
    let paint = super::paint_for(fill, ew_geom::Rect::new(0.0, 0.0, w, h))?;
    let path = kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)).to_path(0.1);
    Some(Draw::Vector(Box::new(VectorPath { path, rule: FillRule::NonZero, fill: Some(paint), pen: None })))
}

/// The page's picture or texture fill (Design › Page Color › Fill Effects) behind the content: tiled at its natural size
/// (96 dpi) for a `tile` fill, stretched over the page otherwise.
fn page_picture(doc: &Document, page: &Page) -> Option<Draw> {
    let pic = doc.settings.page_picture.as_ref()?;
    let bytes = doc.media.get(&pic.media)?;
    let (nw, nh) = match ew_scene::image_size(bytes) {
        Some((w, h)) if w > 0 && h > 0 && (w as u64) * (h as u64) <= MAX_BACKGROUND_PIXELS => (w as f64, h as f64),
        _ => return None,
    };
    let (w, h) = (page.w, page.h.min(1e6));
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return None;
    }
    let tile = pic.fill_type.eq_ignore_ascii_case("tile");
    let rect = if tile { [0.0, 0.0, (0.75 * nw) as f32, (0.75 * nh) as f32] } else { [0.0, 0.0, w, h] };
    let path = kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)).to_path(0.1);
    let fill = Some(Paint::Image { media: pic.media.clone(), rect, repeat: tile });
    Some(Draw::Vector(Box::new(VectorPath { path, rule: FillRule::NonZero, fill, pen: None })))
}

/// Draw › Format Background's rule or grid lines: one hairline every spacing down the text area (the whole page with Apply to
/// Full Page), across it too for a grid, starting at the area's top and left edges.
fn rule_lines(doc: &Document, page: &Page) -> Option<Draw> {
    let rule = doc.settings.page_rule.as_ref()?;
    let gap = f64::from(rule.spacing()?);
    let pw = (page.w - page.markup.max(0.0)).max(1.0);
    let b = page.body;
    let (x0, y0, w, h) = if rule.full || !(b.w > 0.0 && b.h > 0.0) { (0.0, 0.0, pw, page.h.min(1e5)) } else { (b.x, b.y, b.w, b.h) };
    let (x0, y0, x1, y1) = (f64::from(x0), f64::from(y0), f64::from(x0 + w), f64::from(y0 + h));
    if !(gap >= 1.0 && x1 > x0 && y1 > y0) {
        return None;
    }
    let mut path = kurbo::BezPath::new();
    let mut y = y0 + gap;
    while y < y1 {
        path.move_to((x0, y));
        path.line_to((x1, y));
        y += gap;
    }
    if rule.grid() {
        let mut x = x0 + gap;
        while x < x1 {
            path.move_to((x, y0));
            path.line_to((x, y1));
            x += gap;
        }
    }
    let pen = Some(ew_scene::Pen::solid(ew_doc::PageRule::COLOR, 0.75));
    Some(Draw::Vector(Box::new(VectorPath { path, rule: FillRule::NonZero, fill: None, pen })))
}

/// The watermark: its text stretched over its box (Word's `v:textpath fitshape`), its advance across the box, its em down
/// it with the em's foot on the box's bottom; the box centred on the margins of the document page (not a Print Markup
/// area beside it) and, when diagonal, turned 45°.
fn watermark(doc: &Document, page: &Page) -> Option<Draw> {
    let wm = doc.settings.watermark.as_ref()?;
    if let Some(p) = &wm.picture {
        return picture_watermark(p, page);
    }
    let face = ew_fonts::word::resolve(&wm.font, false, false).face;
    let shaped = ew_fonts::shape(&face, &wm.text, &[], |c| c);
    let upem = face.upem.max(1.0);
    let raw_w: f64 = shaped.iter().map(|g| g.x_advance as f64).sum::<f64>() / upem;
    if raw_w <= 0.0 {
        return None;
    }
    let pw = (page.w - page.markup.max(0.0)).max(1.0) as f64;
    let [bw, bh] = wm.frame(pw as f32, page.h).map(f64::from);
    let size = bh.min(2000.0);
    let k = size / upem;
    let stretch = bw / (raw_w * size);
    let descent = (ew_fonts::word::line_metrics(&face).1 / upem).clamp(0.0, 1.0);
    let angle = if wm.diagonal { -std::f64::consts::FRAC_PI_4 } else { 0.0 };
    let b = page.body;
    let (cx, cy) =
        if b.w > 0.0 && b.h > 0.0 { (f64::from(b.x + b.w / 2.0), f64::from(b.y + b.h / 2.0)) } else { (pw / 2.0, page.h.min(2000.0) as f64 / 2.0) };
    let transform = Affine::translate((cx, cy))
        * Affine::rotate(angle)
        * Affine::translate((-bw / 2.0, bh / 2.0 - descent * bh))
        * Affine::scale_non_uniform(stretch, 1.0);
    let mut x = 0.0;
    let mut glyphs = Vec::with_capacity(shaped.len());
    for g in &shaped {
        glyphs.push((g.gid, x as f32, 0.0));
        x += g.x_advance as f64 * k;
    }
    let run = Draw::Glyphs {
        face,
        size: size as f32,
        glyphs,
        color: wm.color,
        alpha: if wm.semitransparent { 0.35 } else { 0.8 },
        synth_bold: false,
        synth_italic: false,
        text: wm.text.clone(),
        link: None,
        ranges: Vec::new(),
        text_bg: None,
        x_scale: 1.0,
    };
    Some(Draw::Group(Box::new(Group { transform, ..Group::of(vec![run]) })))
}

/// EasyWriter engine-gaps-rest: a picture watermark, its box centred on the margins of the document page, washed out (Word's
/// `gain` and `blacklevel`) as the picture drawn faint on the paper. ponytail: the fade is an opacity, by eye against Word's.
fn picture_watermark(p: &ew_doc::WatermarkPicture, page: &Page) -> Option<Draw> {
    let [w, h] = p.size;
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) || p.media.is_empty() {
        return None;
    }
    let pw = (page.w - page.markup.max(0.0)).max(1.0);
    let b = page.body;
    let (cx, cy) = if b.w > 0.0 && b.h > 0.0 { (b.x + b.w / 2.0, b.y + b.h / 2.0) } else { (pw / 2.0, page.h / 2.0) };
    let rect = Rect::new(cx - w / 2.0, cy - h / 2.0, w, h);
    Some(Draw::Image { rect, media: p.media.clone(), crop: [0.0; 4], alpha: if p.washout { 0.3 } else { 1.0 }, alt: String::new(), decorative: true })
}

/// How a page is drawn on screen: which items it has, and how they are painted.
#[derive(Clone, Debug, Default)]
pub struct RenderOptions {
    pub display: DisplayOptions,
    pub paint: PaintOptions,
}

impl RenderOptions {
    /// The on-screen colour of the paper under `doc`'s pages.
    pub fn paper_of(&self, doc: &Document) -> Rgb {
        self.paint.ink(self.paint.read_paper.or(doc.settings.page_color).unwrap_or(Rgb::WHITE))
    }
}

fn media(doc: &Document) -> &dyn Media {
    &doc.media
}

/// `page` painted whole at `scale` pixels a point.
pub fn render_page(doc: &Document, page: &Page, scale: f32, opts: &RenderOptions) -> Rendered {
    ew_scene::render_list(&page_list(doc, page, &opts.display), media(doc), scale, &opts.paint)
}

/// The page `area` (points) at `scale` pixels a point: previews and thumbnails.
pub fn render_area(doc: &Document, page: &Page, area: ew_geom::Rect, scale: f32, opts: &RenderOptions) -> Rendered {
    ew_scene::render_list_area(&page_list(doc, page, &opts.display), media(doc), area, scale, &opts.paint)
}

/// `items` alone over the page `area`, with `doc`'s pictures: a dragged object's preview.
pub fn render_items(doc: &Document, items: &[Draw], area: ew_geom::Rect, scale: f32, opts: &RenderOptions) -> Rendered {
    ew_scene::render_items(items, media(doc), area, scale, &opts.paint)
}

/// The on-screen colour behind page point (`x`, `y`) (see [`ew_scene::background_at`]).
pub fn background_at(doc: &Document, page: &Page, opts: &RenderOptions, x: f32, y: f32) -> Rgb {
    ew_scene::background_at(&page_list(doc, page, &opts.display), &opts.paint, x, y)
}
