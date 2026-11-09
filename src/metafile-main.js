// The fallback for EMF and WMF pictures of a .docx that WordCraft's metafile reader (WebAssembly, src/vendor/wordcraft-metafile)
// cannot draw: EMF+ only files, whose drawing is in EMF+ records the reader does not read, and files it cannot read at all. They
// come here as PNGs (IPC word.metafiles), drawn by the system's own renderer: GDI+ through .NET (System.Drawing.Imaging.Metafile
// into a Bitmap) in one Windows PowerShell process per call, for all of a file's such pictures. Other systems return null for
// each, and the import shows a placeholder. Results are cached by content hash and size for the session.
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_SIDE = 4096;
const MAX_PIXELS = 16e6;
const cache = new Map(); // sha256@WxH → PNG data URL

/** The PNG's pixel size for a picture drawn at `w` x `h` CSS px: twice that (crisp at 200% zoom) within the caps. 0 x 0: the
 * metafile's own size. */
function pixels(w, h) {
  if (!(w > 0 && h > 0)) return [0, 0];
  const k = Math.min(2, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

const SCRIPT = (jobs) => `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($j in (Get-Content -Raw -Encoding UTF8 -LiteralPath '${jobs.replace(/'/g, "''")}' | ConvertFrom-Json)) {
  try {
    $m = New-Object System.Drawing.Imaging.Metafile($j.in)
    $w = [int]$j.w; $h = [int]$j.h
    if ($w -le 0 -or $h -le 0) { $w = [Math]::Min(${MAX_SIDE}, $m.Width); $h = [Math]::Min(${MAX_SIDE}, $m.Height) }
    $b = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.DrawImage($m, 0, 0, $w, $h)
    $b.Save($j.out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $b.Dispose(); $m.Dispose()
  } catch { }
}`;

/** [{data (base64 EMF or WMF), w, h (CSS px)}] → [PNG data URL | null], in order. */
async function toPng(list) {
  if (!Array.isArray(list)) return [];
  const jobs = list.map((p) => {
    const bytes = Buffer.from(typeof p?.data === 'string' ? p.data : '', 'base64');
    const [w, h] = pixels(+p?.w, +p?.h);
    return { bytes, w, h, key: `${crypto.createHash('sha256').update(bytes).digest('hex')}@${w}x${h}` };
  });
  const todo = [...new Map(jobs.filter((j) => j.bytes.length && !cache.has(j.key)).map((j) => [j.key, j])).values()];
  if (todo.length && process.platform === 'win32') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easywriter-metafile-'));
    try {
      const spec = await Promise.all(todo.map(async (j, i) => {
        await fs.writeFile(path.join(dir, `${i}.bin`), j.bytes);
        return { in: path.join(dir, `${i}.bin`), out: path.join(dir, `${i}.png`), w: j.w, h: j.h };
      }));
      const file = path.join(dir, 'jobs.json');
      await fs.writeFile(file, JSON.stringify(spec));
      const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const command = Buffer.from(SCRIPT(file), 'utf16le').toString('base64');
      await new Promise((resolve) => {
        execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command], { windowsHide: true, timeout: 60000 }, () => resolve());
      });
      await Promise.all(todo.map(async (j, i) => {
        const png = await fs.readFile(spec[i].out).catch(() => null);
        if (png?.length) cache.set(j.key, `data:image/png;base64,${png.toString('base64')}`);
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return jobs.map((j) => cache.get(j.key) ?? null);
}

module.exports = { toPng, pixels };
