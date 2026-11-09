// 3-D rotation as pictures, text boxes and shapes hold it ({x, y, z, perspective} in degrees, Word's X, Y and Z rotations and its
// field of view, 0 for a parallel view; `camera` names the preset camera it came from) and the CSS that draws it. Word's preset
// cameras (DrawingML's ST_PresetCameraType) carry no angles in the file: these are the latitude, longitude and revolution
// LibreOffice measured for each (oox/source/drawingml/scene3dhelper.cxx), checked against Word's own PDF of the fixture. Pure.

// [latitude, longitude, revolution] in degrees, by camera; perspective cameras are marked p.
const ISO = {
  isometricBottomDown: [35.4, 314.7, 299.8], isometricBottomUp: [35.4, 45.3, 60.2], isometricLeftDown: [35, 45, 0], isometricLeftUp: [325, 45, 0],
  isometricOffAxis1Left: [18, 64, 0], isometricOffAxis1Right: [18, 334, 0], isometricOffAxis1Top: [301.3, 306.5, 57.6], isometricOffAxis2Left: [18, 26, 0],
  isometricOffAxis2Right: [18, 296, 0], isometricOffAxis2Top: [301.3, 53.5, 302.4], isometricOffAxis3Bottom: [58.7, 306.5, 302.4], isometricOffAxis3Left: [342, 64, 0],
  isometricOffAxis3Right: [342, 334, 0], isometricOffAxis4Bottom: [58.7, 53.5, 57.6], isometricOffAxis4Left: [342, 26, 0], isometricOffAxis4Right: [342, 296, 0],
  isometricRightDown: [325, 315, 0], isometricRightUp: [35, 315, 0], isometricTopDown: [324.6, 45.3, 299.8], isometricTopUp: [324.6, 314.7, 60.2],
};
const PERSPECTIVE = {
  perspectiveFront: [0, 0, 0], perspectiveLeft: [0, 20, 0], perspectiveRight: [0, 340, 0], perspectiveAbove: [340, 0, 0], perspectiveBelow: [20, 0, 0],
  perspectiveAboveLeftFacing: [39.3, 14.3, 341.1], perspectiveAboveRightFacing: [39.3, 345.7, 18.9], perspectiveContrastingLeftFacing: [10.4, 43.9, 356.4],
  perspectiveContrastingRightFacing: [10.4, 316.1, 3.6], perspectiveHeroicLeftFacing: [349, 14.3, 2.6], perspectiveHeroicRightFacing: [349, 345.7, 357.4],
  perspectiveHeroicExtremeLeftFacing: [8.1, 34.5, 357.1], perspectiveHeroicExtremeRightFacing: [8.1, 325.5, 2.9], perspectiveRelaxed: [309.6, 0, 0],
  perspectiveRelaxedModerately: [324.8, 0, 0],
};
// The obliques slant a shape's depth, which a flat picture or box does not have: Word draws them unturned, as these do.
const FLAT = ['orthographicFront', ...['TopLeft', 'Top', 'TopRight', 'Left', 'Right', 'BottomLeft', 'Bottom', 'BottomRight'].map((s) => `oblique${s}`)];
/** Word's field of view for a perspective camera that names none (a:camera fov's default). */
export const FOV = 45;

const r1 = (n) => Math.round(n * 10) / 10;
// Degrees in (-180, 180].
const norm = (d) => { const a = ((d % 360) + 360) % 360; return r1(a > 180 ? a - 360 : a) || 0; };
// Word's X and Z rotations turn the other way from the camera's longitude and revolution (the fixture's "X 45 degrees" is a
// longitude of 315).
const rotation = ([lat, lon, rev], perspective) => ({ x: norm(-lon), y: norm(lat), z: norm(-rev), perspective });

/** Each preset camera's rotation: name → {x, y, z, perspective}. */
export const CAMERAS = Object.fromEntries([
  ...Object.entries(ISO).map(([k, v]) => [k, rotation(v, 0)]),
  ...Object.entries(PERSPECTIVE).map(([k, v]) => [k, rotation(v, FOV)]),
  ...FLAT.map((k) => [k, rotation([0, 0, 0], 0)]),
]);

/** Rotation `r` with its angles: its own where it has them, else its preset camera's (`camera`, or `preset` as Shape Effects on a
 * text box stores it) → {x, y, z, perspective, camera?} or null. */
export function rotationOf(r) {
  if (!r) return null;
  const name = r.camera ?? r.preset ?? null;
  const cam = CAMERAS[name];
  const own = ['x', 'y', 'z'].some((k) => Number.isFinite(r[k]));
  const base = own ? { x: r.x ?? 0, y: r.y ?? 0, z: r.z ?? 0, perspective: r.perspective ?? 0 } : cam ?? null;
  return base && { ...base, ...(name && cam && { camera: name }) };
}

const same = (a, b) => ['x', 'y', 'z'].every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.05);
/** The camera rotation `r` (rotationOf) still is: its preset while its angles and its kind of view (parallel or perspective) are
 * the preset's → {camera, rot: false}; else the plain front camera of its kind with the angles written out → {camera, rot: true}. */
export function cameraOf(r) {
  const cam = CAMERAS[r.camera];
  const persp = (r.perspective ?? 0) > 0;
  if (cam && !!cam.perspective === persp) return { camera: r.camera, rot: !same(r, cam) };
  return { camera: persp ? 'perspectiveFront' : 'orthographicFront', rot: true };
}

/** The CSS transform that draws rotation `r` (rotationOf's terms): the camera turns by its longitude, then its latitude, then its
 * revolution, which on screen is rotateZ, rotateX, rotateY in that order (the fixture's isometric presets drawn by Word match it).
 * The perspective distance shrinks as the field of view widens; a parallel view is drawn from far away. → '' for none. */
export function rotationCss(r) {
  const t = rotationOf(r);
  if (!t) return '';
  const p = t.perspective > 0 ? r1(1200 / Math.max(0.1, t.perspective / FOV)) : 2000;
  return `perspective(${p}px) rotateZ(${t.z}deg) rotateX(${t.y}deg) rotateY(${-t.x}deg)`;
}
