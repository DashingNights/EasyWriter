use super::{Draw, Rect};
pub use ew_scene::{Paint, Stroke};

/// How shape fill `fill` paints the shape's frame `frame` (#1500). A linear gradient runs across
/// the frame at its angle (`scaled`: the angle of the frame squashed to a square); a path
/// gradient runs from the centre of its focus rectangle out to the farthest corner, drawn
/// circular whatever its outline (rectangular and shape-following ones are approximated).
/// `tileRect` and `flip` are kept but not drawn. `None` for no fill.
pub fn paint_for(fill: &ew_doc::fill::Fill, frame: Rect) -> Option<Paint> {
    use ew_doc::fill::{Fill, GradientKind};
    let g = match fill.sanitized()? {
        Fill::Solid { color, transparency } => return Some(Paint::Solid(color, 1.0 - transparency / 100.0)),
        Fill::Gradient(g) => g,
        Fill::Picture(p) => return Some(picture_paint(&p, frame)),
        Fill::Pattern(p) => return Some(pattern_paint(&p, (frame.x, frame.y))),
    };
    let stops = g.stops.iter().map(|s| (s.pos / 100.0, s.color, 1.0 - s.transparency / 100.0)).collect();
    let (cx, cy) = (frame.x + frame.w / 2.0, frame.y + frame.h / 2.0);
    Some(match g.kind {
        GradientKind::Linear { angle, scaled } => {
            let (s, c) = angle.to_radians().sin_cos();
            // Scaled: the isolines of the square's gradient stretched with the frame.
            let (dx, dy) = if scaled && frame.w > 0.0 && frame.h > 0.0 { (c / frame.w, s / frame.h) } else { (c, s) };
            let len = dx.hypot(dy);
            let (dx, dy) = if len > 0.0 && len.is_finite() { (dx / len, dy / len) } else { (1.0, 0.0) };
            let half = (frame.w * dx.abs() + frame.h * dy.abs()) / 2.0;
            Paint::Linear { p0: (cx - dx * half, cy - dy * half), p1: (cx + dx * half, cy + dy * half), stops }
        }
        GradientKind::Path { focus: [l, t, r, b], .. } => {
            let x0 = frame.x + frame.w * l / 100.0;
            let x1 = frame.right() - frame.w * r / 100.0;
            let y0 = frame.y + frame.h * t / 100.0;
            let y1 = frame.bottom() - frame.h * b / 100.0;
            let c = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
            let corners = [(frame.x, frame.y), (frame.right(), frame.y), (frame.x, frame.bottom()), (frame.right(), frame.bottom())];
            let r = corners.iter().map(|(x, y)| (x - c.0).hypot(y - c.1)).fold(0.0f32, f32::max);
            Paint::Radial { c, r: r.max(0.01), stops }
        }
    })
}

/// EasyWriter engine-gaps-shapes: a picture fill stretched over `frame`, or a texture repeated at its own size from the
/// frame's top left (stretched when its size is not known).
// ponytail: the fill's transparency is kept and saved but not drawn (Paint::Image has no opacity); fade it when a
// see-through picture fill matters.
fn picture_paint(p: &ew_doc::fill::PictureFill, frame: Rect) -> Paint {
    let [w, h] = p.size;
    let tiled = p.tile && w > 0.0 && h > 0.0;
    let rect = if tiled { [frame.x, frame.y, w, h] } else { [frame.x, frame.y, frame.w, frame.h] };
    Paint::Image { media: p.media.clone(), rect, repeat: tiled }
}

/// Points a pattern's cell spans: its 8 pixels at 96 dpi, as Word draws a preset pattern at 100%.
pub const PATTERN_CELL: f32 = 6.0;

/// EasyWriter engine-gaps-shapes: preset pattern `p` repeated from page point `at` (the shape's or page's top left): the
/// background colour over the cell, the set bits in the foreground colour.
pub fn pattern_paint(p: &ew_doc::fill::PatternFill, at: (f32, f32)) -> Paint {
    use kurbo::Shape;
    use ew_scene::{FillRule, VectorPath};
    let bits = ew_doc::fill::pattern_bits(&p.preset).unwrap_or([0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa]);
    let px = f64::from(PATTERN_CELL) / 8.0;
    let (x0, y0) = (f64::from(at.0), f64::from(at.1));
    let cell = kurbo::Rect::new(x0, y0, x0 + 8.0 * px, y0 + 8.0 * px).to_path(0.1);
    let mut ink = kurbo::BezPath::new();
    for (y, row) in bits.iter().enumerate() {
        for x in (0..8).filter(|x| row >> x & 1 == 1) {
            let (l, t) = (x0 + x as f64 * px, y0 + y as f64 * px);
            ink.extend(kurbo::Rect::new(l, t, l + px, t + px).path_elements(0.1));
        }
    }
    let shape = |path, c| Draw::Vector(Box::new(VectorPath { path, rule: FillRule::NonZero, fill: Some(Paint::solid(c)), pen: None }));
    let mut items = vec![shape(cell, p.bg)];
    if !ink.elements().is_empty() {
        items.push(shape(ink, p.fg));
    }
    Paint::Pattern { cell: [at.0, at.1, PATTERN_CELL, PATTERN_CELL], items }
}
