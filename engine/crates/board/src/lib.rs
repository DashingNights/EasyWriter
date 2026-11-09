//! The whiteboard's stamps (docs/plans/board/design.md sections 2 and 3). A stamp is the display list one board item draws.
//! src/board/model.mjs builds the item as a complete engine model; this opens it with the stored form's own reader in a scratch
//! session, lays it out, takes the first page's display list and wraps it in one group with the item's rotation, flips and
//! opacity. There is no draw or parse code here, and no serde: the model is read by the reader `open` uses, and the numbers
//! arrive as arguments.

use std::sync::Arc;

use ew_doc_edit::layout::display::page_layers;
use ew_doc_edit::layout::{Placed, ViewMode};
use ew_doc_edit::render::kurbo::{Affine, Point, Rect};
use ew_doc_edit::render::{DisplayList, Draw, Group, Layer, Media, bounds};
use ew_doc_edit::{Registry, Session};

/// The narrowest width the continuous views lay text out at (doc-layout `reflow_sect`): a text item narrower than this is laid
/// out as a page of its own width instead, so its wrap is the item's.
pub const MIN_WEB: f32 = 144.0;

/// Where a stamp sits and how big it is, in points: `ox`, `oy` the stamp's top left in the item's own frame (the page the model
/// laid out, before the item's position), so a rotation or an effect that reaches past the frame gives a negative offset;
/// `w`, `h` its size. `text_w` is the right edge of the widest line (a width-fitted text) or the item's width (one laid out as
/// a page), `text_h` its text's extent, for a text item ([`Look::text`]); 0 for any other.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stamp {
    pub ox: f32,
    pub oy: f32,
    pub w: f32,
    pub h: f32,
    pub text_w: f32,
    pub text_h: f32,
}

/// How the item shows: flipped in its own frame, then turned `rot` degrees clockwise about the stamp's box centre (the order of
/// Word and DrawingML, so an object looks the same on a board and on a page), at `opacity` (0 to 1). `text` is `Some(width)`
/// for text, laid out in Web view at that width with no margin, so it grows as high as it needs; under [`MIN_WEB`] its model's
/// own page (as wide as the item, margins 0) is the page instead. `width_fit` says the text fits its width to its words (a
/// width of several thousand points and a stamp as wide as its widest line); a height-fit or fixed text is as wide as the
/// width it was given, and its box turns about its own centre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub rot: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    pub opacity: f32,
    pub text: Option<f32>,
    pub width_fit: bool,
}

/// The bytes of the pictures the stamps draw, sorted by name: what their tiles are painted with. A sorted Vec, not the map a
/// document keeps its media in, because a map's removal alone added 4 KB to the .wasm.
pub struct Pictures(Vec<(String, Arc<Vec<u8>>)>);

impl Pictures {
    fn index(&self, name: &str) -> Result<usize, usize> {
        self.0.binary_search_by(|(k, _)| k.as_str().cmp(name))
    }
}

impl Media for Pictures {
    fn bytes(&self, key: &str) -> Option<&Arc<Vec<u8>>> {
        Some(&self.0[self.index(key).ok()?].1)
    }
}

/// One item's stamp, and the names of the pictures it draws.
struct Stamped {
    handle: u32,
    list: Arc<DisplayList>,
    pictures: Vec<String>,
}

/// The stamps of one board: one for each item handle, kept sorted by handle, the bytes of the pictures they draw, and the scratch
/// session that lays the models out.
pub struct Board {
    lists: Vec<Stamped>,
    media: Pictures,
    scratch: Session,
}

impl Board {
    pub fn new(registry: Arc<Registry>) -> Board {
        let mut scratch = Session::with_registry(ew_doc_edit::blank_document(&Default::default()), registry);
        scratch.view.proofing = false;
        Board { lists: Vec::new(), media: Pictures(Vec::new()), scratch }
    }

    /// Stamps `model` for `handle`. A model that cannot be read or laid out is an error and leaves the old stamp.
    pub fn set(&mut self, handle: u32, model: &[u8], look: &Look) -> Result<Stamp, String> {
        let (stamp, items) = self.stamp(model, look)?;
        let layer = Layer { opacity: opacity(look), ..Layer::of(items) };
        let list = Arc::new(DisplayList::new(stamp.w, stamp.h, None, vec![layer]));
        // The model carried its pictures into the scratch document. A name is a hash of the bytes, so the same name is the same
        // picture, whichever stamp brought it.
        let mut pictures = Vec::new();
        for (name, bytes) in &self.scratch.doc.media {
            pictures.push(name.clone());
            match self.media.index(name) {
                Ok(i) => self.media.0[i].1 = bytes.clone(),
                Err(i) => self.media.0.insert(i, (name.clone(), bytes.clone())),
            }
        }
        let stamped = Stamped { handle, list, pictures };
        // ponytail: a sorted Vec costs O(n) to insert or remove; a board of 100,000 items would want a map (a HashMap added 2.8 KB).
        let old = match self.lists.binary_search_by_key(&handle, |l| l.handle) {
            Ok(i) => Some(std::mem::replace(&mut self.lists[i], stamped)),
            Err(i) => {
                self.lists.insert(i, stamped);
                None
            }
        };
        self.forget(old);
        Ok(stamp)
    }

    /// The stamp of `model` as draw items (one group, drawn from the stamp's top left) without keeping it.
    pub fn draws(&mut self, model: &[u8], look: &Look) -> Result<(Stamp, Vec<Draw>), String> {
        let (stamp, mut items) = self.stamp(model, look)?;
        if let [Draw::Group(g)] = &mut items[..] {
            g.opacity = opacity(look);
        }
        Ok((stamp, items))
    }

    pub fn remove(&mut self, handle: u32) {
        let old = self.lists.binary_search_by_key(&handle, |l| l.handle).ok().map(|i| self.lists.remove(i));
        self.forget(old);
    }

    pub fn list(&self, handle: u32) -> Option<Arc<DisplayList>> {
        let i = self.lists.binary_search_by_key(&handle, |l| l.handle).ok()?;
        Some(self.lists[i].list.clone())
    }

    /// The bytes of every picture the stamps draw, which is what their tiles are painted with.
    pub fn media(&self) -> &Pictures {
        &self.media
    }

    /// Lets go of the pictures that only the stamp `old` (replaced or removed) drew.
    fn forget(&mut self, old: Option<Stamped>) {
        let Some(old) = old else { return };
        for name in &old.pictures {
            if let (false, Ok(i)) = (self.lists.iter().any(|s| s.pictures.contains(name)), self.media.index(name)) {
                self.media.0.remove(i);
            }
        }
    }

    /// Whether (`x`, `y`), in the stamp's own frame, is on what the stamp draws: a stroke within `tol` points, a fill inside.
    pub fn hit(&self, handle: u32, x: f32, y: f32, tol: f32) -> bool {
        self.list(handle).is_some_and(|l| l.hit(x, y, tol).is_some())
    }

    fn stamp(&mut self, model: &[u8], look: &Look) -> Result<(Stamp, Vec<Draw>), String> {
        let mut doc = ew_doc_edit::io::open_bytes("document.json", model).map_err(|e| ew_doc_edit::doc::refusal(model).unwrap_or(e))?;
        doc.upgrade()?;
        let s = &mut self.scratch;
        s.set_document(doc);
        s.reset_ids();
        let v = &mut s.view;
        (v.read_mode, v.immersive, v.web_margin) = (false, false, 0.0);
        // A narrow text item is a page of its own width: the continuous views' floor would wrap it wider than the item.
        let wide = look.text.is_some_and(|w| w >= MIN_WEB);
        match look.text {
            Some(w) if wide => (v.mode, v.web_width) = (ViewMode::Web, w),
            _ => v.mode = ViewMode::Print,
        }
        let layout = s.layout();
        let page = layout.pages.first().ok_or("the model laid out no page")?;
        // The page's own draws (headers and footers, then the body), without its paper, rule lines or watermark.
        let items: Vec<Draw> = page_layers(&s.doc, page, &ew_doc_edit::cmd::view::display_options(s)).into_iter().flat_map(|(_, items)| items).collect();
        // ponytail: only page 0 is stamped. A model whose content runs onto a second page is cut there.

        // A text item's stamp is its text: the widest line for one that fits its width to the text, else the item's width, and
        // the lines' extent as its height.
        let (text_w, text_h) = match look.text {
            Some(_) if wide => (widest(&page.items).max(1.0), page.h),
            Some(_) => (page.w, deepest(&page.items).min(page.h)),
            None => (0.0, 0.0),
        };

        // About the stamp's centre: the flips first, in the item's own frame, then the rotation. A width-fitted text's box is
        // its words; any other text's is the width the item was given, so it turns about the box the selection draws.
        let frame = match look.text {
            Some(_) if look.width_fit => Rect::new(0.0, 0.0, f64::from(text_w), f64::from(text_h)),
            Some(_) => Rect::new(0.0, 0.0, f64::from(page.w), f64::from(text_h)),
            None => Rect::new(0.0, 0.0, f64::from(page.w), f64::from(page.h)),
        };
        let (cx, cy) = (frame.x1 / 2.0, frame.y1 / 2.0);
        let finite = |v: f32| if v.is_finite() { f64::from(v) } else { 0.0 };
        let flip = Affine::translate((cx, cy)) * Affine::scale_non_uniform(sign(look.flip_x), sign(look.flip_y)) * Affine::translate((-cx, -cy));
        let turn = Affine::rotate_about(finite(look.rot).to_radians(), Point::new(cx, cy)) * flip;
        let b = turn.transform_rect_bbox(items.iter().filter_map(ink).fold(frame, |a, b| a.union(b)));
        let stamp = Stamp { ox: b.x0 as f32, oy: b.y0 as f32, w: b.width() as f32, h: b.height() as f32, text_w, text_h };
        let group = Group { transform: Affine::translate((-b.x0, -b.y0)) * turn, ..Group::of(items) };
        Ok((stamp, vec![Draw::Group(Box::new(group))]))
    }
}

/// The box a draw paints in, for sizing a stamp. The display list's own boxes are made for culling and are generous (a shape
/// counts its stroke width without a stroke and always adds a point), so a plain rectangle would not stamp at its own size.
/// A shape is its frame grown by its stroke's width and by its effects' reach. A glyph run is left to the frame: its lines
/// lie inside it. Anything else keeps its display box.
/// The stroke's whole width, not half, is deliberate: a stamp clips at its edge, and a mitred corner reaches past half the width.
/// A wide stroke on a star, a triangle and a diamond stays inside it (`a_wide_stroke_keeps_all_its_ink_inside_the_stamp`).
fn ink(d: &Draw) -> Option<Rect> {
    match d {
        Draw::Shape { rect: r, stroke, stroke_width, effects, .. } => {
            let [l, t, rt, bt] = effects.extent_for(r.h).map(f64::from);
            let w = if stroke.is_some() { f64::from(stroke_width.clamp(0.0, 200.0)) } else { 0.0 };
            Some(Rect::new(f64::from(r.x) - l - w, f64::from(r.y) - t - w, f64::from(r.right()) + rt + w, f64::from(r.bottom()) + bt + w))
        }
        Draw::Glyphs { .. } => None,
        _ => bounds(d),
    }
}

fn sign(flipped: bool) -> f64 {
    if flipped { -1.0 } else { 1.0 }
}

fn opacity(look: &Look) -> f32 {
    if look.opacity.is_finite() { look.opacity.clamp(0.0, 1.0) } else { 1.0 }
}

/// The right edge of the widest line on a page: where the text ends, for a text item that fits its width to it.
fn widest(items: &[Placed]) -> f32 {
    let lines = items.iter().filter_map(|it| match it {
        Placed::Lines { x, para, l0, l1, .. } => para.lines.get(*l0..*l1).map(|ls| ls.iter().filter_map(|l| l.xs.last()).fold(0.0f32, |m, e| m.max(x + e))),
        _ => None,
    });
    lines.fold(0.0, f32::max)
}

/// The bottom of the lowest line on a page: how high the text is, for a text item laid out as a page of its own width. `y` is
/// line `l0`'s top, as `line_boxes` (a11y.rs) reads it.
fn deepest(items: &[Placed]) -> f32 {
    let lines = items.iter().filter_map(|it| match it {
        Placed::Lines { y, para, l0, l1, .. } => {
            let first = para.lines.get(*l0)?;
            para.lines.get(*l0..*l1).map(|ls| ls.iter().fold(0.0f32, |m, l| m.max(y + (l.top - first.top) + l.height)))
        }
        _ => None,
    });
    lines.fold(0.0, f32::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ew_doc_edit::render::PaintOptions;
    use serde_json::{Value, json};

    /// A floating red rectangle 100 x 50 pt at the page's corner, as the item session saved it after `insert.shape`,
    /// `arrange.wrap` and `arrange.float` (test/fixtures/board/shape-model.json).
    const FIXTURE: &str = include_str!("../../../../test/fixtures/board/shape-model.json");

    fn board() -> Board {
        Board::new(Arc::new(ew_doc_edit::cmd::registry()))
    }

    fn plain() -> Look {
        Look { rot: 0.0, flip_x: false, flip_y: false, opacity: 1.0, text: None, width_fit: false }
    }

    /// The fixture with its page sized `w` x `h` pt, no margins, and `edit` applied to its shape.
    fn shape(w: f64, h: f64, edit: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
        m["lastSection"].as_object_mut().unwrap().extend(
            [("pageW", w), ("pageH", h), ("marginTop", 0.0), ("marginBottom", 0.0), ("marginLeft", 0.0), ("marginRight", 0.0), ("header", 0.0), ("footer", 0.0)]
                .map(|(k, v)| (k.to_string(), json!(v))),
        );
        let s = &mut m["body"][0]["objects"][0];
        (s["w"], s["h"], s["stroke"]) = (json!(w), json!(h), Value::Null);
        edit(s);
        serde_json::to_vec(&m).unwrap()
    }

    /// A text item: one paragraph of `text` on the fixture's styles.
    fn text(text: &str) -> Vec<u8> {
        let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
        m["body"] = json!([{"kind": "para", "text": text, "runs": [{"len": text.len()}]}]);
        serde_json::to_vec(&m).unwrap()
    }

    fn pixels(b: &Board, handle: u32) -> ew_doc_edit::render::Rendered {
        b.list(handle).unwrap().render(b.media(), 1.0, &PaintOptions::default())
    }

    fn at(r: &ew_doc_edit::render::Rendered, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * r.width + x) * 4) as usize;
        r.pixels[i..i + 4].try_into().unwrap()
    }

    fn set(b: &mut Board, model: &[u8], look: Look) -> Stamp {
        b.set(1, model, &look).unwrap()
    }

    fn red(s: &mut Value) {
        s["fill"] = json!([255, 0, 0]);
    }

    #[test]
    fn a_red_rectangle_stamps_at_its_own_size() {
        let mut b = board();
        let s = set(&mut b, &shape(100.0, 50.0, red), plain());
        assert_eq!((s.ox, s.oy, s.w, s.h), (0.0, 0.0, 100.0, 50.0));
        assert_eq!(at(&pixels(&b, 1), 50, 25), [255, 0, 0, 255]);
    }

    #[test]
    fn an_ellipse_leaves_its_corner_clear() {
        let mut b = board();
        set(&mut b, &shape(100.0, 50.0, |s| (s["kind"], s["fill"]) = (json!("ellipse"), json!([255, 0, 0]))), plain());
        let r = pixels(&b, 1);
        assert_eq!(at(&r, 0, 0)[3], 0);
        assert_eq!(at(&r, 50, 25), [255, 0, 0, 255]);
    }

    #[test]
    fn a_quarter_turn_swaps_the_size_and_moves_the_offset() {
        let mut b = board();
        let s = set(&mut b, &shape(100.0, 50.0, red), Look { rot: 90.0, ..plain() });
        let near = |a: f32, e: f32| (a - e).abs() < 1e-3;
        assert!(near(s.w, 50.0) && near(s.h, 100.0) && near(s.ox, 25.0) && near(s.oy, -25.0), "{s:?}");
        let r = pixels(&b, 1);
        assert_eq!((r.width, r.height), (50, 100));
        assert_eq!([at(&r, 2, 2), at(&r, 47, 97)], [[255, 0, 0, 255]; 2], "the turned rectangle fills the stamp");
    }

    #[test]
    fn a_flip_moves_a_right_triangles_right_angle_across() {
        let mut b = board();
        let model = shape(100.0, 50.0, |s| (s["kind"], s["fill"]) = (json!("rightTriangle"), json!([255, 0, 0])));
        let (left, right) = ((4, 46), (95, 46));
        set(&mut b, &model, plain());
        let r = pixels(&b, 1);
        assert_eq!((at(&r, left.0, left.1)[3], at(&r, right.0, right.1)[3]), (255, 0), "the right angle is at the bottom left");
        set(&mut b, &model, Look { flip_x: true, ..plain() });
        let r = pixels(&b, 1);
        assert_eq!((at(&r, left.0, left.1)[3], at(&r, right.0, right.1)[3]), (0, 255), "a flip puts it at the bottom right");
    }

    #[test]
    fn text_lays_out_in_web_view_at_the_given_width() {
        let mut b = board();
        let look = |w| Look { text: Some(w), ..plain() };
        let narrow = set(&mut b, &text("Hello"), look(200.0));
        assert!(narrow.text_h > 1.0 && narrow.text_h < 40.0, "{narrow:?}");
        assert!(narrow.text_w > 5.0 && narrow.text_w < 100.0, "{narrow:?}");
        let wide = set(&mut b, &text("Hello"), look(16000.0));
        assert!(wide.text_w < 100.0, "the text ends where it ends, not at the width: {wide:?}");
        let long = set(&mut b, &text(&"Hello ".repeat(200)), look(200.0));
        assert!(long.text_h > 10.0 * narrow.text_h && long.text_w <= 200.0, "{long:?}");
    }

    #[test]
    fn a_rotated_height_fit_text_turns_about_its_own_box() {
        let mut b = board();
        let mut m: Value = serde_json::from_slice(&text("Hi")).unwrap();
        m["lastSection"].as_object_mut().unwrap().extend(
            [("pageW", 300.0), ("pageH", 20000.0), ("marginTop", 0.0), ("marginBottom", 0.0), ("marginLeft", 0.0), ("marginRight", 0.0),
                ("header", 0.0), ("footer", 0.0)]
                .map(|(k, v)| (k.to_string(), json!(v))),
        );
        let model = serde_json::to_vec(&m).unwrap();
        let near = |a: f32, e: f32| (a - e).abs() < 1e-2;
        let s = set(&mut b, &model, Look { rot: 90.0, text: Some(300.0), ..plain() });
        assert!(near(s.w, s.text_h) && near(s.h, 300.0), "a 300 pt box turned a quarter: {s:?}");
        assert!(near(s.ox + s.w / 2.0, 150.0) && near(s.oy + s.h / 2.0, s.text_h / 2.0), "it turns about the box's centre: {s:?}");
        let fitted = set(&mut b, &model, Look { rot: 90.0, text: Some(16000.0), width_fit: true, ..plain() });
        assert!(fitted.w < 100.0, "a width-fitted text's box is its words: {fitted:?}");
    }

    #[test]
    fn a_narrow_text_lays_out_at_its_own_width() {
        let mut b = board();
        let words = "one two three four five six seven eight nine ten";
        let mut m: Value = serde_json::from_slice(&text(words)).unwrap();
        m["lastSection"].as_object_mut().unwrap().extend(
            [("pageW", 80.0), ("pageH", 20000.0), ("marginTop", 0.0), ("marginBottom", 0.0), ("marginLeft", 0.0), ("marginRight", 0.0),
                ("header", 0.0), ("footer", 0.0)]
                .map(|(k, v)| (k.to_string(), json!(v))),
        );
        let s = set(&mut b, &serde_json::to_vec(&m).unwrap(), Look { text: Some(80.0), ..plain() });
        assert!((s.w - 80.0).abs() < 0.01, "the stamp is the item's width: {s:?}");
        assert!(s.text_w <= 80.01, "the lines wrap inside it: {s:?}");
        assert!(s.text_h > 40.0, "ten words wrap onto several lines: {s:?}");
    }

    #[test]
    fn a_stroke_is_hit_near_it_and_the_hollow_is_not() {
        let mut b = board();
        set(&mut b, &shape(100.0, 100.0, |s| (s["fill"], s["stroke"], s["stroke_width"]) = (Value::Null, json!([0, 0, 0]), json!(2))), plain());
        assert!(b.hit(1, 1.0, 50.0, 1.0));
        assert!(!b.hit(1, 50.0, 50.0, 1.0));
        b.remove(1);
        assert!(!b.hit(1, 1.0, 50.0, 1.0), "a removed stamp is not hit");
    }

    #[test]
    fn a_shadow_reaches_past_the_frame() {
        let mut b = board();
        let shadow = json!({"shadow": {"color": [0, 0, 0], "transparency": 60, "blur": 10, "distance": 3, "angle": 45, "rotWithShape": false}});
        let s = set(&mut b, &shape(100.0, 50.0, |s| (s["fill"], s["effects"]) = (json!([255, 0, 0]), shadow)), plain());
        assert!(s.ox < 0.0 && s.oy < 0.0 && s.w > 100.0 && s.h > 50.0, "{s:?}");
    }

    #[test]
    fn a_line_with_no_height_gets_its_size_from_the_stroke() {
        let mut b = board();
        let s = set(&mut b, &shape(100.0, 1.0, |s| (s["kind"], s["h"], s["stroke"], s["stroke_width"]) = (json!("line"), json!(0), json!([0, 0, 0]), json!(4))), plain());
        assert!(s.w >= 100.0 && s.h >= 4.0, "{s:?}");
    }

    #[test]
    fn a_bad_model_is_an_error_and_keeps_the_old_stamp() {
        let mut b = board();
        set(&mut b, &shape(100.0, 50.0, red), plain());
        let before = b.list(1).unwrap();
        assert!(b.set(1, b"{ not a model", &plain()).is_err());
        assert!(b.set(1, br#"{"schema": "easywriter.document", "version": 9999}"#, &plain()).is_err());
        assert!(Arc::ptr_eq(&before, &b.list(1).unwrap()));
    }

    #[test]
    fn draws_gives_the_stamps_group_without_keeping_it() {
        let mut b = board();
        let (s, items) = b.draws(&shape(100.0, 50.0, red), &Look { opacity: 0.5, ..plain() }).unwrap();
        assert_eq!((s.w, s.h), (100.0, 50.0));
        assert!(matches!(&items[..], [Draw::Group(g)] if g.opacity == 0.5), "{items:?}");
        assert!(b.list(1).is_none());
    }

    /// A red 8 x 8 PNG.
    const RED_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

    /// A picture `media` 40 x 40 pt, whose bytes the model carries under its name.
    fn picture(media: &str) -> Vec<u8> {
        let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
        m["lastSection"].as_object_mut().unwrap().extend(
            [("pageW", 40.0), ("pageH", 40.0), ("marginTop", 0.0), ("marginBottom", 0.0), ("marginLeft", 0.0), ("marginRight", 0.0), ("header", 0.0), ("footer", 0.0)]
                .map(|(k, v)| (k.to_string(), json!(v))),
        );
        let mut float = m["body"][0]["objects"][0]["float"].take();
        float["wrap"] = json!("inFrontOfText");
        m["body"][0]["objects"] = json!([{"type": "image", "media": media, "w": 40, "h": 40, "alt": "", "float": float, "crop": [0, 0, 0, 0]}]);
        m["media"] = json!({ media: RED_PNG });
        serde_json::to_vec(&m).unwrap()
    }

    #[test]
    fn a_picture_stamp_paints_the_pictures_pixels() {
        let mut b = board();
        set(&mut b, &picture("red.png"), plain());
        assert_eq!(at(&pixels(&b, 1), 20, 20), [255, 0, 0, 255]);
    }

    #[test]
    fn the_boards_media_follows_the_stamps_that_use_it() {
        let mut b = board();
        let keys = |b: &Board| b.media().0.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
        b.set(1, &picture("a.png"), &plain()).unwrap();
        b.set(2, &picture("a.png"), &plain()).unwrap();
        b.set(3, &picture("b.png"), &plain()).unwrap();
        assert_eq!(keys(&b), ["a.png", "b.png"]);
        b.remove(1);
        assert_eq!(keys(&b), ["a.png", "b.png"], "a picture another stamp uses stays");
        b.remove(2);
        assert_eq!(keys(&b), ["b.png"]);
        b.set(3, &shape(100.0, 50.0, red), &plain()).unwrap();
        assert!(keys(&b).is_empty(), "a stamp made again without the picture lets it go");
        b.set(4, &picture("a.png"), &plain()).unwrap();
        b.set(4, &picture("a.png"), &plain()).unwrap();
        assert_eq!(keys(&b), ["a.png"], "a stamp made again with the picture keeps it");
    }

    #[test]
    fn a_flip_is_made_in_the_items_own_frame_and_then_the_item_turns() {
        let mut b = board();
        let model = shape(100.0, 50.0, |s| (s["kind"], s["fill"]) = (json!("rightTriangle"), json!([255, 0, 0])));
        let s = set(&mut b, &model, Look { rot: 90.0, flip_x: true, ..plain() });
        assert_eq!((s.w.round(), s.h.round()), (50.0, 100.0));
        // Flipped, the right angle is at the frame's bottom right; a quarter turn clockwise takes that corner to the bottom left.
        let r = pixels(&b, 1);
        assert_eq!((at(&r, 4, 95)[3], at(&r, 45, 4)[3], at(&r, 45, 95)[3]), (255, 0, 255), "the right angle is at the bottom left");
    }

    /// The pixels of `kind` drawn with a black 8 pt stroke that lie outside its stamp: the stamp is drawn in the middle of a plane
    /// a margin larger on each side, where nothing may reach the margin.
    fn ink_outside_stamp(kind: &str, w: f64, h: f64) -> (usize, Stamp) {
        let mut b = board();
        let model = shape(w, h, |s| (s["kind"], s["fill"], s["stroke"], s["stroke_width"]) = (json!(kind), json!([255, 0, 0]), json!([0, 0, 0]), json!(8)));
        let (stamp, items) = b.draws(&model, &plain()).unwrap();
        let m = 40.0;
        let moved = Group { transform: Affine::translate((m, m)), ..Group::of(items) };
        let plane = DisplayList::new(stamp.w + 2.0 * m as f32, stamp.h + 2.0 * m as f32, None, vec![Layer::of(vec![Draw::Group(Box::new(moved))])]);
        let r = plane.render(b.media(), 1.0, &PaintOptions::default());
        let (lo, hx, hy) = (m as u32, m as u32 + stamp.w.ceil() as u32, m as u32 + stamp.h.ceil() as u32);
        let outside = (0..r.height).flat_map(|y| (0..r.width).map(move |x| (x, y))).filter(|&(x, y)| (x < lo || x >= hx || y < lo || y >= hy) && at(&r, x, y)[3] != 0).count();
        (outside, stamp)
    }

    #[test]
    fn a_wide_stroke_keeps_all_its_ink_inside_the_stamp() {
        for (kind, w, h) in [("star", 100.0, 100.0), ("triangle", 100.0, 100.0), ("triangle", 60.0, 100.0), ("diamond", 100.0, 60.0), ("rightTriangle", 100.0, 50.0), ("rectangle", 100.0, 50.0)] {
            let (outside, stamp) = ink_outside_stamp(kind, w, h);
            assert_eq!(outside, 0, "{kind} {w} x {h}: {outside} inked pixels outside the stamp {stamp:?}");
        }
    }

    /// Timing: 2,000 shapes and 200 text items. `cargo test -p ew-board --release timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn timing() {
        let mut b = board();
        let (shapes, texts) = (shape(100.0, 50.0, red), text("The quick brown fox jumps over the lazy dog. ".repeat(4).as_str()));
        let t0 = std::time::Instant::now();
        for h in 0..2000 {
            b.set(h, &shapes, &plain()).unwrap();
        }
        let t1 = std::time::Instant::now();
        for h in 2000..2200 {
            b.set(h, &texts, &Look { text: Some(300.0), ..plain() }).unwrap();
        }
        eprintln!("2,000 shapes {:?}, 200 text items {:?}", t1 - t0, t1.elapsed());
    }
}
