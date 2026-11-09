//! Shape effects (DrawingML `a:effectLst`, ECMA-376 Part 1 §20.1.8): an outer shadow, a glow and
//! soft edges. Lengths are points, angles degrees, transparencies percent (0 = opaque).
//!
//! Renderers approximate the blurs with [`bands`]: a few copies of the shape's silhouette, grown
//! or shrunk by steps and overlaid with partial opacity, so the screen and PDF output (which has
//! no blur filter) match.

use serde::{Deserialize, Serialize};

use crate::props::Rgb;

/// Largest blur radius, points.
pub const MAX_BLUR: f32 = 100.0;
/// Largest shadow distance, points.
pub const MAX_DISTANCE: f32 = 200.0;
/// Largest glow size, points.
pub const MAX_GLOW: f32 = 150.0;
/// Largest soft-edge radius, points.
pub const MAX_SOFT_EDGE: f32 = 100.0;

/// The effects on a shape or picture. Empty (the default) draws it plainly.
#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeEffects {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<Shadow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glow: Option<Glow>,
    /// Soft-edge radius, points: the shape fades out over this distance inside its outline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soft_edge: Option<f32>,
    /// EasyWriter engine-gaps-pictures: a shadow cast inside the outline (`a:innerShdw`), with an outer shadow's colour,
    /// transparency, blur, distance and angle. The renderer draws it on pictures; shapes keep it for their files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner_shadow: Option<Shadow>,
    /// EasyWriter engine-gaps-pictures: a reflection under the object (`a:reflection`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reflection: Option<Reflection>,
    /// EasyWriter engine-gaps-pictures: a top bevel (`a:sp3d/a:bevelT`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bevel: Option<Bevel>,
    /// EasyWriter engine-gaps-pictures: a 3-D rotation (`a:scene3d/a:camera`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<Rotation3d>,
}

/// Largest reflection gap, points.
pub const MAX_REFLECTION_GAP: f32 = 100.0;
/// Largest bevel width or height, points.
pub const MAX_BEVEL: f32 = 1584.0;

/// A reflection: the object mirrored under its bottom edge, `distance` points below it, fading from `100 - transparency`
/// percent opaque to clear over `size` percent of its height, blurred by `blur` points.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Reflection {
    pub size: f32,
    pub distance: f32,
    pub transparency: f32,
    pub blur: f32,
}

impl Default for Reflection {
    /// "Half Reflection: Touching".
    fn default() -> Self {
        Reflection { size: 50.0, distance: 0.0, transparency: 50.0, blur: 0.5 }
    }
}

impl Reflection {
    /// Finite, in range.
    pub fn sanitized(self) -> Reflection {
        Reflection {
            size: clamp(self.size, 0.0, 100.0, 50.0),
            distance: clamp(self.distance, 0.0, MAX_REFLECTION_GAP, 0.0),
            transparency: clamp(self.transparency, 0.0, 100.0, 50.0),
            blur: clamp(self.blur, 0.0, MAX_BLUR, 0.0),
        }
    }
}

/// A bevel's profile: DrawingML's `ST_BevelPresetType` names (Picture Effects › Bevel's items).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BevelKind {
    #[default]
    Circle,
    RelaxedInset,
    Cross,
    CoolSlant,
    Angle,
    SoftRound,
    Convex,
    Slope,
    Divot,
    Riblet,
    HardEdge,
    ArtDeco,
}

impl BevelKind {
    const ALL: [(BevelKind, &'static str); 12] = [
        (BevelKind::Circle, "circle"),
        (BevelKind::RelaxedInset, "relaxedInset"),
        (BevelKind::Cross, "cross"),
        (BevelKind::CoolSlant, "coolSlant"),
        (BevelKind::Angle, "angle"),
        (BevelKind::SoftRound, "softRound"),
        (BevelKind::Convex, "convex"),
        (BevelKind::Slope, "slope"),
        (BevelKind::Divot, "divot"),
        (BevelKind::Riblet, "riblet"),
        (BevelKind::HardEdge, "hardEdge"),
        (BevelKind::ArtDeco, "artDeco"),
    ];
    pub fn from_ooxml(v: &str) -> Option<BevelKind> {
        Self::ALL.iter().find(|(_, n)| *n == v).map(|(k, _)| *k)
    }
    pub fn ooxml(self) -> &'static str {
        Self::ALL.iter().find(|(k, _)| *k == self).map_or("circle", |(_, n)| n)
    }
}

/// A top bevel `width` by `height` points.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Bevel {
    pub kind: BevelKind,
    pub width: f32,
    pub height: f32,
}

impl Default for Bevel {
    /// DrawingML's default bevel: a 6 pt circle.
    fn default() -> Self {
        Bevel { kind: BevelKind::Circle, width: 6.0, height: 6.0 }
    }
}

impl Bevel {
    pub fn sanitized(self) -> Bevel {
        Bevel { kind: self.kind, width: clamp(self.width, 0.0, MAX_BEVEL, 6.0), height: clamp(self.height, 0.0, MAX_BEVEL, 6.0) }
    }
}

/// A 3-D rotation as Word's Format pane gives it: X, Y and Z rotations in degrees and the field of view (`fov`, 0 for a
/// parallel view). Word's preset cameras carry no angles in the file: [`CAMERAS`] holds them.
#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rotation3d {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub fov: f32,
}

/// Word's field of view for a perspective camera that names none (`a:camera/@fov`'s default).
pub const DEFAULT_FOV: f32 = 45.0;

/// The preset cameras (`ST_PresetCameraType`) the galleries use and Word writes: name, [latitude, longitude, revolution] in
/// degrees, and whether it is a perspective one. The angles are those LibreOffice measured for each
/// (oox/source/drawingml/scene3dhelper.cxx), as src/tooling/rotation3d.mjs has them; any other camera reads as front-on.
pub const CAMERAS: &[(&str, [f32; 3], bool)] = &[
    ("orthographicFront", [0.0, 0.0, 0.0], false),
    ("isometricBottomDown", [35.4, 314.7, 299.8], false),
    ("isometricBottomUp", [35.4, 45.3, 60.2], false),
    ("isometricLeftDown", [35.0, 45.0, 0.0], false),
    ("isometricLeftUp", [325.0, 45.0, 0.0], false),
    ("isometricOffAxis1Left", [18.0, 64.0, 0.0], false),
    ("isometricOffAxis1Right", [18.0, 334.0, 0.0], false),
    ("isometricOffAxis1Top", [301.3, 306.5, 57.6], false),
    ("isometricOffAxis2Left", [18.0, 26.0, 0.0], false),
    ("isometricOffAxis2Right", [18.0, 296.0, 0.0], false),
    ("isometricOffAxis2Top", [301.3, 53.5, 302.4], false),
    ("isometricOffAxis3Bottom", [58.7, 306.5, 302.4], false),
    ("isometricOffAxis3Left", [342.0, 64.0, 0.0], false),
    ("isometricOffAxis3Right", [342.0, 334.0, 0.0], false),
    ("isometricOffAxis4Bottom", [58.7, 53.5, 57.6], false),
    ("isometricOffAxis4Left", [342.0, 26.0, 0.0], false),
    ("isometricOffAxis4Right", [342.0, 296.0, 0.0], false),
    ("isometricRightDown", [325.0, 315.0, 0.0], false),
    ("isometricRightUp", [35.0, 315.0, 0.0], false),
    ("isometricTopDown", [324.6, 45.3, 299.8], false),
    ("isometricTopUp", [324.6, 314.7, 60.2], false),
    ("perspectiveFront", [0.0, 0.0, 0.0], true),
    ("perspectiveLeft", [0.0, 20.0, 0.0], true),
    ("perspectiveRight", [0.0, 340.0, 0.0], true),
    ("perspectiveAbove", [340.0, 0.0, 0.0], true),
    ("perspectiveBelow", [20.0, 0.0, 0.0], true),
    ("perspectiveAboveLeftFacing", [39.3, 14.3, 341.1], true),
    ("perspectiveAboveRightFacing", [39.3, 345.7, 18.9], true),
    ("perspectiveContrastingLeftFacing", [10.4, 43.9, 356.4], true),
    ("perspectiveContrastingRightFacing", [10.4, 316.1, 3.6], true),
    ("perspectiveHeroicLeftFacing", [349.0, 14.3, 2.6], true),
    ("perspectiveHeroicRightFacing", [349.0, 345.7, 357.4], true),
    ("perspectiveHeroicExtremeLeftFacing", [8.1, 34.5, 357.1], true),
    ("perspectiveHeroicExtremeRightFacing", [8.1, 325.5, 2.9], true),
    ("perspectiveRelaxed", [309.6, 0.0, 0.0], true),
    ("perspectiveRelaxedModerately", [324.8, 0.0, 0.0], true),
];

/// Degrees in (-180, 180], to a tenth.
fn signed_degrees(d: f32) -> f32 {
    let a = clamp(d, -1e6, 1e6, 0.0).rem_euclid(360.0);
    let a = if a > 180.0 { a - 360.0 } else { a };
    (a * 10.0).round() / 10.0 + 0.0
}

impl Rotation3d {
    /// The rotation a camera gives: its own `rot` (latitude, longitude, revolution in degrees) when it has one, else the
    /// preset's; `fov` from the file, else the preset's kind of view. Word's X and Z turn the other way from the camera's
    /// longitude and revolution.
    pub fn from_camera(preset: &str, rot: Option<[f32; 3]>, fov: Option<f32>) -> Rotation3d {
        let cam = CAMERAS.iter().find(|(n, _, _)| *n == preset);
        let [lat, lon, rev] = rot.or(cam.map(|c| c.1)).unwrap_or([0.0; 3]);
        let persp = cam.is_some_and(|c| c.2) || preset.starts_with("perspective");
        let fov = if persp { fov.unwrap_or(DEFAULT_FOV) } else { 0.0 };
        Rotation3d { x: signed_degrees(-lon), y: signed_degrees(lat), z: signed_degrees(-rev), fov }.sanitized()
    }
    /// The camera to write: a preset whose angles and kind of view this still is (no `rot`), else the front camera of its
    /// kind with the angles written out ([latitude, longitude, revolution] in degrees, each in 0..360).
    pub fn camera(&self) -> (&'static str, Option<[f32; 3]>) {
        let r = self.sanitized();
        let persp = r.fov > 0.0;
        let same = |[lat, lon, rev]: [f32; 3]| {
            let near = |a: f32, b: f32| (signed_degrees(a - b)).abs() < 0.05;
            near(r.x, -lon) && near(r.y, lat) && near(r.z, -rev)
        };
        if let Some((name, _, _)) = CAMERAS.iter().find(|(_, a, p)| *p == persp && same(*a)) {
            return (name, None);
        }
        let deg = |v: f32| (v.rem_euclid(360.0) * 10.0).round() / 10.0 % 360.0;
        (if persp { "perspectiveFront" } else { "orthographicFront" }, Some([deg(r.y), deg(-r.x), deg(-r.z)]))
    }
    pub fn sanitized(self) -> Rotation3d {
        Rotation3d { x: signed_degrees(self.x), y: signed_degrees(self.y), z: signed_degrees(self.z), fov: clamp(self.fov, 0.0, 179.0, 0.0) }
    }
    /// The plane's turn seen in a parallel view: the 2×2 matrix (a, b, c, d: x' = a·x + c·y, y' = b·x + d·y) the picture's
    /// frame takes about its centre. Turned as CSS turns `rotateZ(z) rotateX(y) rotateY(-x)`, as Word's isometric presets
    /// draw (src/tooling/rotation3d.mjs).
    pub fn plane(&self) -> [f32; 4] {
        let r = self.sanitized();
        let (sx, cx) = (-r.x).to_radians().sin_cos();
        let (sy, cy) = r.y.to_radians().sin_cos();
        let (sz, cz) = r.z.to_radians().sin_cos();
        // rotateY(-x) · (1,0,0) and (0,1,0), then rotateX(y), then rotateZ(z); only the x and y rows matter for a flat plane.
        let ex = [cx, 0.0, -sx];
        let ey = [0.0, 1.0, 0.0];
        let rx = |v: [f32; 3]| [v[0], cy * v[1] - sy * v[2], sy * v[1] + cy * v[2]];
        let rz = |v: [f32; 3]| [cz * v[0] - sz * v[1], sz * v[0] + cz * v[1]];
        let (a, b) = (rz(rx(ex)), rz(rx(ey)));
        [a[0], a[1], b[0], b[1]]
    }
}

/// An outer shadow: a blurred copy of the shape's silhouette cast `distance` points away in
/// direction `angle` (degrees clockwise from the positive x axis, y pointing down).
///
/// `rot_with_shape` (DrawingML `rotWithShape`, true when absent) says whether that direction is
/// the shape's own, turning with it when it is rotated or flipped, or the page's. Word's shadow
/// presets write `rotWithShape="0"`: the light stays put as the shape turns.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shadow {
    pub color: Rgb,
    pub transparency: f32,
    pub blur: f32,
    pub distance: f32,
    pub angle: f32,
    pub rot_with_shape: bool,
}

impl Default for Shadow {
    /// "Offset: Bottom Right".
    fn default() -> Self {
        Shadow { color: Rgb::BLACK, transparency: 60.0, blur: 4.0, distance: 3.0, angle: 45.0, rot_with_shape: false }
    }
}

/// A glow: a soft band of colour `size` points wide around the shape's outline.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Glow {
    pub color: Rgb,
    pub size: f32,
    pub transparency: f32,
}

impl Default for Glow {
    fn default() -> Self {
        Glow { color: Rgb(0x15, 0x60, 0x82), size: 5.0, transparency: 60.0 }
    }
}

fn clamp(v: f32, lo: f32, hi: f32, dflt: f32) -> f32 {
    if v.is_finite() { v.clamp(lo, hi) } else { dflt }
}

/// The outer-shadow presets (no perspective shadows): id, label.
pub const SHADOW_PRESETS: [(&str, &str); 9] = [
    ("offsetBottomRight", "Offset: Bottom Right"),
    ("offsetBottom", "Offset: Bottom"),
    ("offsetBottomLeft", "Offset: Bottom Left"),
    ("offsetRight", "Offset: Right"),
    ("offsetCenter", "Offset: Center"),
    ("offsetLeft", "Offset: Left"),
    ("offsetTopRight", "Offset: Top Right"),
    ("offsetTop", "Offset: Top"),
    ("offsetTopLeft", "Offset: Top Left"),
];

impl Shadow {
    /// A preset by id (see [`SHADOW_PRESETS`]).
    pub fn preset(id: &str) -> Option<Shadow> {
        let d = Shadow::default();
        let angle = match id {
            "offsetBottomRight" => 45.0,
            "offsetBottom" => 90.0,
            "offsetBottomLeft" => 135.0,
            "offsetLeft" => 180.0,
            "offsetTopLeft" => 225.0,
            "offsetTop" => 270.0,
            "offsetTopRight" => 315.0,
            "offsetRight" => 0.0,
            "offsetCenter" => return Some(Shadow { distance: 0.0, blur: 5.0, ..d }),
            _ => return None,
        };
        Some(Shadow { angle, ..d })
    }
    /// Finite, in range.
    pub fn sanitized(self) -> Shadow {
        let angle = clamp(self.angle, -1e6, 1e6, 45.0).rem_euclid(360.0);
        Shadow {
            color: self.color,
            transparency: clamp(self.transparency, 0.0, 100.0, 60.0),
            blur: clamp(self.blur, 0.0, MAX_BLUR, 0.0),
            distance: clamp(self.distance, 0.0, MAX_DISTANCE, 0.0),
            angle: if angle.is_finite() && angle < 360.0 { angle } else { 0.0 },
            rot_with_shape: self.rot_with_shape,
        }
    }
    /// The shadow's offset from the shape, points (x right, y down).
    pub fn offset(&self) -> (f32, f32) {
        let s = self.sanitized();
        let a = s.angle.to_radians();
        (s.distance * a.cos(), s.distance * a.sin())
    }
    /// Opacity 0..1.
    pub fn opacity(&self) -> f32 {
        1.0 - self.sanitized().transparency / 100.0
    }
}

impl Glow {
    /// Finite, in range.
    pub fn sanitized(self) -> Glow {
        Glow { color: self.color, size: clamp(self.size, 0.0, MAX_GLOW, 0.0), transparency: clamp(self.transparency, 0.0, 100.0, 60.0) }
    }
    /// Opacity 0..1.
    pub fn opacity(&self) -> f32 {
        1.0 - self.sanitized().transparency / 100.0
    }
}

impl ShapeEffects {
    pub fn is_empty(&self) -> bool {
        self.shadow.is_none()
            && self.glow.is_none()
            && self.soft_edge.is_none()
            && self.inner_shadow.is_none()
            && self.reflection.is_none()
            && self.bevel.is_none()
            && self.rotation.is_none()
    }
    /// Finite, in range; zero-size glows and soft edges dropped, and a rotation that turns nothing.
    pub fn sanitized(self) -> ShapeEffects {
        ShapeEffects {
            shadow: self.shadow.map(Shadow::sanitized),
            glow: self.glow.map(Glow::sanitized).filter(|g| g.size > 0.0),
            soft_edge: self.soft_edge.map(|r| clamp(r, 0.0, MAX_SOFT_EDGE, 0.0)).filter(|r| *r > 0.0),
            inner_shadow: self.inner_shadow.map(Shadow::sanitized),
            reflection: self.reflection.map(Reflection::sanitized).filter(|r| r.size > 0.0 && r.transparency < 100.0),
            bevel: self.bevel.map(Bevel::sanitized).filter(|b| b.width > 0.0 && b.height > 0.0),
            rotation: self.rotation.map(Rotation3d::sanitized).filter(|r| *r != Rotation3d::default()),
        }
    }
    /// [`ShapeEffects::extent`] for an object `h` points tall: a reflection reaches below it by its gap and its share of
    /// that height.
    pub fn extent_for(&self, h: f32) -> [f32; 4] {
        let mut out = self.extent();
        if let Some(r) = self.sanitized().reflection {
            let h = if h.is_finite() { h.clamp(0.0, 4000.0) } else { 0.0 };
            out[3] = out[3].max(((r.distance + h * r.size / 100.0) * 100.0).round() / 100.0);
        }
        out
    }
    /// How far the effects reach beyond the shape's frame on each side (left, top, right,
    /// bottom), points — what `wp:effectExtent` records.
    pub fn extent(&self) -> [f32; 4] {
        let e = self.sanitized();
        let mut out = [0.0f32; 4];
        if let Some(g) = e.glow {
            out = [g.size; 4];
        }
        if let Some(s) = e.shadow {
            let (dx, dy) = s.offset();
            let r = s.blur / 2.0;
            let reach = [r - dx, r - dy, r + dx, r + dy];
            for (o, v) in out.iter_mut().zip(reach) {
                *o = o.max(v.max(0.0));
            }
        }
        out.map(|v| (v * 100.0).round() / 100.0)
    }
}

/// Bands approximating a blurred edge: `(grow, alpha)` pairs. Each is a copy of the silhouette
/// grown outward by `grow` points (negative shrinks it), filled with opacity `alpha`; overlaid in
/// any order, in one colour, they ramp linearly from `opacity` at `from` to nothing at `to`.
pub fn bands(from: f32, to: f32, opacity: f32) -> Vec<(f32, f32)> {
    let (from, to) = (clamp(from, -1000.0, 1000.0, 0.0), clamp(to, -1000.0, 1000.0, 0.0));
    let opacity = clamp(opacity, 0.0, 1.0, 0.0);
    if opacity <= 0.0 {
        return Vec::new();
    }
    let span = (to - from).max(0.0);
    if span < 0.25 {
        return vec![((from + to) / 2.0, opacity)];
    }
    let n = ((span / 1.5).ceil() as usize).clamp(3, 12);
    let nf = n as f32;
    (1..=n)
        .map(|m| {
            // The m-th band from the outside: after it, coverage is opacity·m/n.
            let grow = to - span * (m as f32 - 0.5) / nf;
            let before = 1.0 - opacity * (m as f32 - 1.0) / nf;
            let after = 1.0 - opacity * m as f32 / nf;
            let alpha = if before > 0.0 { 1.0 - after / before } else { 1.0 };
            (grow, alpha.clamp(0.0, 1.0))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_ramp_to_the_requested_opacity() {
        for (from, to, o) in [(-2.0, 2.0, 0.4), (-5.0, 0.0, 1.0), (0.0, 8.0, 0.6)] {
            let b = bands(from, to, o);
            assert!(b.iter().all(|(g, a)| *g > from && *g < to && (0.0..=1.0).contains(a)));
            let covered = 1.0 - b.iter().map(|(_, a)| 1.0 - a).product::<f32>();
            assert!((covered - o).abs() < 1e-4, "{covered} vs {o}");
        }
        assert_eq!(bands(0.0, 0.0, 0.5), vec![(0.0, 0.5)]);
        assert!(bands(f32::NAN, f32::INFINITY, f32::NAN).is_empty());
    }

    #[test]
    fn hostile_numbers_are_clamped() {
        let s = Shadow { color: Rgb::BLACK, transparency: f32::NAN, blur: 1e9, distance: -4.0, angle: -90.0, rot_with_shape: false }.sanitized();
        assert_eq!((s.transparency, s.blur, s.distance, s.angle), (60.0, MAX_BLUR, 0.0, 270.0));
        let e = ShapeEffects { shadow: None, glow: Some(Glow { size: 1e9, ..Glow::default() }), soft_edge: Some(-1.0), ..Default::default() }.sanitized();
        assert_eq!(e.glow.map(|g| g.size), Some(MAX_GLOW));
        assert_eq!(e.soft_edge, None);
        let e = ShapeEffects { glow: Some(Glow { size: f32::INFINITY, ..Glow::default() }), ..Default::default() }.sanitized();
        assert!(e.is_empty(), "a non-finite size is no glow");
        let (dx, dy) = Shadow::preset("offsetBottomRight").unwrap().offset();
        assert!(dx > 2.0 && dy > 2.0);
    }

    /// EasyWriter engine-gaps-pictures: a preset camera reads as its angles and goes back out as itself; turned further, it
    /// goes out as the front camera of its kind with the angles written.
    #[test]
    fn cameras_read_as_angles_and_write_back() {
        let iso = Rotation3d::from_camera("isometricLeftDown", None, None);
        assert_eq!((iso.x, iso.y, iso.z, iso.fov), (-45.0, 35.0, 0.0, 0.0));
        assert_eq!(iso.camera(), ("isometricLeftDown", None));
        let persp = Rotation3d::from_camera("perspectiveRelaxed", None, None);
        assert_eq!((persp.y, persp.fov), (-50.4, DEFAULT_FOV));
        assert_eq!(persp.camera().0, "perspectiveRelaxed");
        let own = Rotation3d { x: 20.0, y: 10.0, z: 5.0, fov: 0.0 };
        let (name, rot) = own.camera();
        assert_eq!(name, "orthographicFront");
        let back = Rotation3d::from_camera(name, rot, None);
        assert!((back.x - 20.0).abs() < 0.05 && (back.y - 10.0).abs() < 0.05 && (back.z - 5.0).abs() < 0.05, "{back:?}");
        // Front-on turns nothing: no rotation is kept.
        assert!(ShapeEffects { rotation: Some(Rotation3d::from_camera("orthographicFront", None, None)), ..Default::default() }.sanitized().is_empty());
    }

    #[test]
    fn a_turned_plane_is_foreshortened_and_a_z_turn_is_a_rotation() {
        let [a, b, c, d] = Rotation3d { x: 60.0, ..Default::default() }.plane();
        assert!((a - 0.5).abs() < 1e-4 && b.abs() < 1e-4 && c.abs() < 1e-4 && (d - 1.0).abs() < 1e-4, "{a} {b} {c} {d}");
        let [a, b, c, d] = Rotation3d { z: 90.0, ..Default::default() }.plane();
        assert!(a.abs() < 1e-4 && (b - 1.0).abs() < 1e-4 && (c + 1.0).abs() < 1e-4 && d.abs() < 1e-4, "{a} {b} {c} {d}");
    }

    #[test]
    fn a_reflection_reaches_below_by_its_share_of_the_height() {
        let e = ShapeEffects { reflection: Some(Reflection { size: 50.0, distance: 4.0, ..Default::default() }), ..Default::default() };
        assert_eq!(e.extent_for(100.0), [0.0, 0.0, 0.0, 54.0]);
        assert!(ShapeEffects { reflection: Some(Reflection { size: f32::NAN, transparency: 100.0, ..Default::default() }), ..Default::default() }
            .sanitized()
            .is_empty());
    }
}
