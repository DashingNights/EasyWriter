// Renders an SVG into a multi-size Windows .ico plus a 256px PNG, using Electron's Chromium (no extra deps).
// Usage: electron scripts/make-icon.js [in.svg] [outDir]   (defaults: build/icon.svg, build/)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('make-icon.js') && a !== '.');
const input = path.resolve(args[0] || 'build/icon.svg');
const outDir = path.resolve(args[1] || 'build');
const base = path.basename(input, '.svg');

// PNG-compressed ICO entries (supported since Windows Vista).
function packIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(input, 'utf8');
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');
    // Draw the SVG straight onto a canvas at each size so small sizes are rasterized crisply, not downscaled.
    const urls = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
      await img.decode();
      return ${JSON.stringify(SIZES)}.map((s) => {
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, s, s);
        return c.toDataURL('image/png');
      });
    })()`);
    const pngs = urls.map((u, i) => ({ size: SIZES[i], data: Buffer.from(u.split(',')[1], 'base64') }));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${base}.ico`), packIco(pngs));
    fs.writeFileSync(path.join(outDir, `${base}.png`), pngs.at(-1).data);
    if (process.argv.includes('--sizes')) pngs.forEach((p) => fs.writeFileSync(path.join(outDir, `${base}-${p.size}.png`), p.data));
    console.log(`wrote ${path.join(outDir, base)}.ico/.png`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
