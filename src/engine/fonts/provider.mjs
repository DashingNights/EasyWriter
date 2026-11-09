// The engine's font provider (docs/plans/engine/plan.md section 1, Fonts). The engine's worker starts with only its bundled faces
// and reports the families a document names that it lacks (the fonts.missing event: the font table's, the styles', the theme's and
// the runs' families, and the scripts its text needs a fallback for). The provider finds each family in its sources (on the
// desktop the installed fonts, then the app's open fonts; in the web app the open fonts and the user's) and hands the files to the
// worker (addFont), which lays out again the paragraphs set in it. The engine decides the stand-in for a family no source has
// (the engine's word.rs): each missing family comes with the font it is drawn in now and the fonts word.rs picks from, and the
// provider loads the first of those a source has (Carlito for Calibri, Caladea for Cambria), so the engine moves to it.
// Plain web code: it runs on the page, and Node tests drive it with stub sources.

/** The fonts each script falls back to where the document's own fonts lack its characters, first found wins: Windows' fonts, the
 * Mac's, then the open ones. Keys are ISO 15924 codes. ponytail: a fixed list of the scripts the user's documents use; add a
 * script when a document needs it. */
export const SCRIPT_FONTS = {
  Hant: ['Microsoft JhengHei', 'PMingLiU', 'PingFang TC', 'Noto Sans TC'],
  Hans: ['Microsoft YaHei', 'SimSun', 'PingFang SC'],
  Jpan: ['Yu Gothic', 'Meiryo', 'MS Mincho', 'Hiragino Sans'],
  Kore: ['Malgun Gothic', 'Batang', 'Apple SD Gothic Neo'],
  Arab: ['Segoe UI', 'Traditional Arabic', 'Geeza Pro'],
  Hebr: ['Segoe UI', 'David', 'Arial Hebrew'],
  Thai: ['Leelawadee UI', 'Tahoma', 'Thonburi'],
  Deva: ['Nirmala UI', 'Mangal', 'Kohinoor Devanagari'],
};

/** Runs `fn` over `items`, `n` at a time, so a document of 80 font files does not hold all their bytes at once. */
async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const now = () => globalThis.performance?.now() ?? Date.now();

/** A provider for `engine` ({on(event, fn) → off, addFont(bytes) → promise}) from `sources` ([{name, faces(family) → promise of
 * [{name, bytes}]}], first that has a family wins). It answers the engine's fonts.missing events by itself; request() asks the same
 * directly. → {request, results, label, ready, stop}. */
export function createFontProvider({ engine, sources, scripts = SCRIPT_FONTS, parallel = 4 }) {
  const loads = new Map(); // lower-case family → promise of {from, files, bytes, ms} or null
  const results = new Map(); // lower-case family asked for → its result
  let pending = Promise.resolve();

  /** Loads `family` from the first source that has it, once → {from, files, bytes, ms} or null. */
  const load = (family) => {
    const key = family.toLowerCase();
    if (!loads.has(key)) {
      loads.set(key, (async () => {
        const t0 = now();
        for (const s of sources) {
          let files = [];
          try {
            files = await s.faces(family);
          } catch { /* this source failed: try the next */ }
          if (!files?.length) continue;
          let bytes = 0;
          for (const f of files) {
            bytes += f.bytes.byteLength;
            await engine.addFont(f.bytes);
          }
          return { from: s.name, files: files.length, bytes, ms: Math.round(now() - t0) };
        }
        return null;
      })());
    }
    return loads.get(key);
  };

  /** `family` itself, else the stand-in word.rs ends on: the first of `standIns` that the engine draws in now (`standIn`) or a
   * source has → its result {family, from, standIn, files, bytes, ms, missing}. ponytail: for a Thai family word.rs also weighs
   * which faces cover Thai and Latin letters, so the first one loaded may not be the one it picks. */
  const provide = async ({ family, standIn: drawnIn = null, standIns = [] }) => {
    const t0 = now();
    let r = await load(family);
    let standIn = null;
    if (!r) {
      for (const s of standIns) {
        if (s.toLowerCase() === drawnIn?.toLowerCase() || (r = await load(s))) {
          standIn = s;
          break;
        }
      }
      standIn ??= drawnIn;
    }
    const out = { family, standIn, from: r?.from ?? null, files: r?.files ?? 0, bytes: r?.bytes ?? 0, ms: Math.round(now() - t0), missing: !r };
    results.set(family.toLowerCase(), out);
    return out;
  };

  /** Supplies `families` (names, or the engine's {family, standIn, standIns}) and a fallback font for each of `scriptCodes` →
   * their results (a family asked for again answers at once). */
  const request = (families = [], scriptCodes = []) => {
    // Family names compare in any case, as Word's and the engine's do; the first spelling is kept.
    const seen = new Set();
    const names = families.map((f) => (typeof f === 'object' && f ? { ...f, family: String(f.family ?? '').trim() } : { family: String(f ?? '').trim() }))
      .filter(({ family: f }) => f && !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase()));
    const fallbacks = scriptCodes.map((c) => scripts[c]).filter(Boolean)
      .map((list) => async () => {
        for (const f of list) {
          const r = await load(f);
          if (r) return { family: f, script: true, standIn: null, ...r, missing: false };
        }
        return null;
      });
    const job = pending.then(() => Promise.all([
      pool(names, parallel, (f) => results.get(f.family.toLowerCase()) ?? provide(f)),
      pool(fallbacks, parallel, (fn) => fn()),
    ])).then(([fams, scr]) => [...fams, ...scr.filter(Boolean)]);
    // The worker holds layout back while files arrive and lays out once the answer is complete.
    pending = job.catch(() => {}).then(() => engine.fontsDone?.()).catch(() => {});
    return job;
  };

  const off = engine.on?.('fonts.missing', (e) => { request(e?.families ?? [], e?.scripts ?? []).catch(() => {}); });

  return {
    request,
    /** What each family asked for drew with so far: [{family, standIn, from, files, bytes, ms, missing}]. */
    results: () => [...results.values()],
    /** How the app names `family`: the font it is drawn in first and the family it stands in for in brackets ("Carlito
     * (Calibri)"), else plainly. A stand-in that is missing too names its own stand-in (Caladea for Cambria where Cambria is
     * not installed). */
    label: (family) => {
      const r = results.get(String(family).toLowerCase());
      let name = r?.standIn;
      for (let i = 0; name && i < 4 && results.get(name.toLowerCase())?.standIn; i++) name = results.get(name.toLowerCase()).standIn;
      return name ? `${name} (${r.family})` : family;
    },
    /** Resolves once every request so far has been answered. */
    ready: () => pending,
    stop: () => off?.(),
  };
}
