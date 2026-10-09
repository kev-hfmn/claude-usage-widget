// Self-check for the tray image: renders the stacked macOS layout through the
// real hidden-canvas path and writes /tmp/tray-check.png for eyeballing.
// Run: npx electron test-tray-render.js
const { app, BrowserWindow, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(__dirname + '/main.js', 'utf8');
const grab = (n) => { let s = src.indexOf(`function ${n}(`); if (src.startsWith('async ', s - 6)) s -= 6; return src.slice(s, src.indexOf('\n}\n', s) + 3); };
const render = new Function('BrowserWindow', 'nativeImage', 'nativeTheme', [
  'const TRAY_ICON_SCALE = 2; let trayCanvasWin = null;', grab('drawTrayImage'), grab('renderTrayImage'), 'return renderTrayImage;',
].join('\n'))(BrowserWindow, nativeImage, nativeTheme);
const y = { r: 253, g: 224, b: 71 }, b = { r: 147, g: 197, b: 253 }, o = { r: 249, g: 115, b: 22 }, f = { r: 217, g: 70, b: 239 };
app.whenReady().then(async () => {
  console.log("ready");
  console.log('rendering');
  const stacked = await render([
    { kind: 'ring', color: o, elapsed: 0.36, text: '41%' },
    { kind: 'ring', color: b, elapsed: 0.11, text: '11%' },
  ], true);
  const { width, height } = stacked.getSize();
  assert(height === 22 && width < 60, `unexpected size ${width}x${height}pt`);
  const modes = await Promise.all([
    render([{ kind: 'ring', color: y, elapsed: 0.05, text: null }, { kind: 'ring', color: b, elapsed: 0.5, text: null }], true),
    render([{ kind: 'dot', color: o, elapsed: 0.7, text: '41% · 2h 14m' }, { kind: 'dot', color: b, elapsed: 0.1, text: '11% · 3d 4h' }], true),
    render([{ kind: 'noentry', color: o, elapsed: 1, text: '100%' }, { kind: 'ring', color: null || b, elapsed: null, text: '11%' }], true),
    render([{ kind: 'ring', color: o, elapsed: 0.36, text: null }], false),
    render([{ kind: 'ring', color: o, elapsed: 0.36, text: '41%', ringScale: 0.5 }, { kind: 'ring', color: b, elapsed: 0.11, text: '11%', ringScale: 0.5 }], true),
    render([{ kind: 'ring', color: o, elapsed: 0.36, text: '55m', ringScale: 0 }, { kind: 'noentry', color: b, elapsed: 1, text: '2d 15h', ringScale: 0 }], true),
    render([{ kind: 'ring', color: o, elapsed: 0.36, text: '41%' }, { kind: 'ring', color: f, elapsed: 0.11, text: '67%' }], true),
    render([{ kind: 'ring', color: o, elapsed: 0.36, text: '55m', ringScale: 0 }, { kind: 'ring', color: f, elapsed: 0.11, text: '6d 2h', ringScale: 0, extra: { kind: 'ring', color: b, elapsed: 0.11, text: 'Weekly 11% · Sat', ringScale: 0 } }], true),
    render([{ kind: 'gauge', fill: 0.47, color: y, text: '47%', extra: { kind: 'text', text: '3h 10m' } }, { kind: 'gauge', fill: 0.07, color: b, text: '7%', extra: { kind: 'gauge', fill: 0.01, color: f, text: '1%' } }], true),
    render([{ kind: 'gauge', fill: 0.47, color: y, text: '3h 10m', extra: { kind: 'text', text: '7:30 PM' } }, { kind: 'gauge', fill: 0.07, color: b, text: 'Sun', extra: { kind: 'gauge', fill: 0.01, color: f, text: '2d 13h' } }], true),
    render([{ kind: 'gauge', fill: 0.93, color: { r: 239, g: 68, b: 68 }, text: '93%' }, { kind: 'gauge', fill: 0.62, color: b, text: '62%', extra: { kind: 'gauge', fill: 0.3, color: f, text: '30%' } }], true),
  ]);
  assert(modes[8].getSize().width <= 100, `text-mode percent view too wide: ${modes[8].getSize().width}pt`);
  assert(modes[6].getSize().width === width, 'percent view with Fable must stay one compact column');
  assert(modes[7].getSize().width > width + 30, 'countdown view should carry the Weekly detail');
  // Composite all variants onto one strip for viewing.
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('about:blank');
  const urls = [stacked, ...modes].map((i) => i.toDataURL());
  const out = await win.webContents.executeJavaScript(`(async () => {
    const imgs = await Promise.all(${JSON.stringify(urls)}.map((u) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = u; })));
    const c = document.createElement('canvas'); c.width = imgs.reduce((w, i) => w + i.width + 20, 20); c.height = 84;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#1c1e5a'; ctx.fillRect(0, 0, c.width, c.height);
    let x = 20; for (const im of imgs) { ctx.drawImage(im, x, 20); x += im.width + 20; }
    return c.toDataURL();
  })()`);
  fs.writeFileSync('/tmp/tray-check.png', Buffer.from(out.split(',')[1], 'base64'));
  console.log(`ok stacked=${width}x${height}pt`);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
