const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage, screen } = require('electron');
const path = require('path');
const https = require('https');
const Store = require('electron-store');
const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');
const { normalizeUsageLimits } = require('./src/normalize-usage-limits');

const GITHUB_OWNER = 'SlavomirDurej';
const GITHUB_REPO = 'claude-usage-widget';

// Required for Windows taskbar features (notifications, Jump List tasks) to register
// reliably under one stable identity — without this, dev (npm start) and packaged
// builds show up as generic "Electron" and custom Jump List tasks may not appear.
// Matches package.json build.appId so dev and packaged runs share the same identity.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.claudeusage.widget');
}


// Profile isolation: --profile=<name> launches a fully separate instance with its own
// session, cookies, and settings. Must be set before anything reads app.getPath('userData').
const fs = require('fs');
const os = require('os');
const profileArg = process.argv.find(a => a.startsWith('--profile='));
if (profileArg) {
  const profileName = profileArg.split('=')[1].replace(/[^a-zA-Z0-9_-]/g, '_');
  const profilePath = path.join(app.getPath('userData'), 'profiles', profileName);
  app.setPath('userData', profilePath);
  // Always logged (not gated behind DEBUG_LOG) so multi-instance bug reports can be
  // triaged from terminal output alone: confirms which profile resolved to which
  // userData root, distinguishing profile-folder isolation from org-ID isolation.
  console.log(`[Profile] Using profile "${profileName}" -> userData: ${profilePath}`);
}

// Migration: Handle old encrypted config files from v1.7.0 and earlier
// Must happen BEFORE creating Store instance to prevent parse errors.
// Skipped for profile instances — they are always fresh installs.
if (!profileArg) {
  let configPath;
  if (process.platform === 'darwin') {
    configPath = path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');
  } else if (process.platform === 'win32') {
    configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-usage-widget', 'config.json');
  } else {
    // Linux
    configPath = path.join(os.homedir(), '.config', 'claude-usage-widget', 'config.json');
  }

  try {
    if (fs.existsSync(configPath)) {
      const rawData = fs.readFileSync(configPath, 'utf-8');
      // Check if file looks encrypted (contains non-JSON garbage or doesn't start with {)
      if (rawData.includes('\u0000') || !rawData.trim().startsWith('{')) {
        console.log('[Migration] Detected old encrypted config from v1.7.0, deleting for fresh start');
        fs.unlinkSync(configPath);
      }
    }
  } catch (err) {
    console.error('[Migration] Error checking config file:', err.message);
    // If we can't read it, try to delete it
    try {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch {}
  }
}

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage

// Set on 'before-quit', which fires before any window's 'close' event on
// every genuine quit path (Exit menu item, Cmd+Q, OS shutdown). Without
// this, app.quit() can't be told apart from a user clicking the close
// button to just minimize -- both arrive as the same window 'close' event.
let isQuitting = false;

// Single source of truth for "is there a recovery surface to bring the
// window back via". Hiding/minimizing-to-tray is only ever safe when this
// is true; otherwise it must behave like a normal close/minimize so the
// taskbar (or the act of relaunching) can still reach it.
function hasTrayIcon() {
  return (sessionTray && !sessionTray.isDestroyed()) || (weeklyTray && !weeklyTray.isDestroyed());
}

const WIDGET_WIDTH = process.platform === 'darwin' ? 590 : 560;
const WIDGET_HEIGHT = 155;
const COMPACT_WIDTH = 290;
const COMPACT_HEIGHT = 105;
const COMPACT_ROW_HEIGHT = 28; // extra height per optional row (Fable, Spend)
const COMPACT_CHEVRON_HEIGHT = 15; // the always-visible spend toggle chevron
const COMPACT_BANNER_HEIGHT = 28; // matches BANNER_HEIGHT in the renderer's resizeWidget()
const HISTORY_RETENTION_DAYS = 8;

// Compact mode always shows Session + Weekly plus the spend chevron; grows by
// one row when the account has a scoped Fable weekly limit
// (data.seven_day_fable, populated by normalize-usage-limits.js), by another
// when the user has toggled the spend row open (settings.compactSpendOpen),
// and by the banner height when an update is available (updateBannerVisible,
// set by the check-for-update handler below — compact mode has no separate
// update-check path of its own, it shares this one).
function getCompactHeight() {
  const data = store.get('latestUsageData');
  let height = COMPACT_HEIGHT + COMPACT_CHEVRON_HEIGHT;
  if (data?.seven_day_fable) height += COMPACT_ROW_HEIGHT;
  if (store.get('settings.compactSpendOpen', false)) height += COMPACT_ROW_HEIGHT;
  if (store.get('updateBannerVisible', false)) height += COMPACT_BANNER_HEIGHT;
  return height;
}
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

function storeUsageHistory(data) {
  // Skip write if the session is invalid — a live session always has resets_at timestamps.
  // Absent timestamps mean the API returned empty/zeroed data (dead session, removed device, etc.)
  if (!data.five_hour?.resets_at && !data.seven_day?.resets_at) {
    debugLog('[History] Skipping write — no reset timestamps, likely invalid session data');
    return;
  }

  const organizationId = store.get('organizationId');
  const historyKey = organizationId ? `usageHistory_${organizationId}` : 'usageHistory';

  const timestamp = Date.now();
  let history = store.get(historyKey, []);

  history.push({
    timestamp,
    session: data.five_hour?.utilization || 0,
    weekly: data.seven_day?.utilization || 0,
    sonnet: data.seven_day_sonnet?.utilization || 0,
    opus: data.seven_day_opus?.utilization || 0,
    fable: data.seven_day_fable?.utilization || 0, // requires feature/fable-usage (normalize-usage-limits.js)
    cowork: data.seven_day_cowork?.utilization || 0,
    design: data.seven_day_omelette?.utilization || 0,
    oauthApps: data.seven_day_oauth_apps?.utilization || 0,
    extraUsage: data.extra_usage?.utilization || 0
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set(historyKey, history);
}

// Migrate legacy single-key history to the per-org namespaced key at startup,
// so get-usage-history reads from the right place before any fetch has run.
function migrateUsageHistoryKey() {
  const organizationId = store.get('organizationId');
  if (!organizationId) return;
  const historyKey = `usageHistory_${organizationId}`;
  if (store.has(historyKey)) return;
  const legacy = store.get('usageHistory', []);
  if (legacy.length > 0) {
    store.set(historyKey, legacy);
    store.delete('usageHistory');
    debugLog('[History] Migrated legacy usageHistory →', historyKey);
  }
}

// Prune all per-org history keys at startup. Trims entries older than the retention
// window and deletes the key entirely if nothing remains — cleans up abandoned accounts.
function pruneStaleHistoryKeys() {
  const cutoff = Date.now() - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') && key !== 'usageHistory') continue;
    const history = store.get(key, []);
    const fresh = history.filter((entry) => entry.timestamp > cutoff);
    if (fresh.length === 0) {
      store.delete(key);
      debugLog('[History] Deleted stale key:', key);
    } else if (fresh.length < history.length) {
      store.set(key, fresh);
      debugLog('[History] Pruned', history.length - fresh.length, 'old entries from', key);
    }
  }
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session
async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog('sessionKey cookie set in Electron session');
}

// Returns true if a rect at (x, y) with the given width/height overlaps
// at least one currently connected display's work area. Used to recover
// from saved window positions left over from a different monitor setup
// (e.g. switching from an ultrawide to a laptop-only display).
function isPositionOnScreen(x, y, width, height) {
  const rect = { x, y, width, height };
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      rect.x < area.x + area.width &&
      rect.x + rect.width > area.x &&
      rect.y < area.y + area.height &&
      rect.y + rect.height > area.y
    );
  });
}

// Centered position on the primary display's work area, for the given window size.
function getCenteredPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  };
}

// True only if the window is actually shown AND within some display's bounds.
// Electron's isVisible() alone is true even when the window is fully
// off-screen, which previously made the tray click-to-hide toggle treat an
// invisible-to-the-user off-screen window as "currently shown."
function isMainWindowShownOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  const bounds = mainWindow.getBounds();
  return isPositionOnScreen(bounds.x, bounds.y, bounds.width, bounds.height);
}

// Implicit/automatic triggers (tray left-click, taskbar left-click/restore,
// app activate, "Show Widget" menu item). Re-validates the window's current
// position against connected displays first and only moves it if it's
// actually off-screen — a valid custom position is left untouched. This is
// the single recovery path for the whole app; any future trigger that brings
// the window forward should route through here too.
function showMainWindowSmart() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return;
  }
  const bounds = mainWindow.getBounds();
  if (!isPositionOnScreen(bounds.x, bounds.y, bounds.width, bounds.height)) {
    const { x, y } = getCenteredPosition(bounds.width, bounds.height);
    debugLog('[Window] Recentering off-screen window from', bounds, 'to', { x, y });
    mainWindow.setPosition(x, y);
    store.set('windowPosition', { x, y });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  let savedPosition = store.get('windowPosition');
  if (savedPosition && !isPositionOnScreen(savedPosition.x, savedPosition.y, WIDGET_WIDTH, WIDGET_HEIGHT)) {
    debugLog('[Window] Saved position', savedPosition, 'is off-screen on current display setup; centering instead');
    savedPosition = null;
  }
  const windowOptions = {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/logo.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedPosition) {
    windowOptions.x = savedPosition.x;
    windowOptions.y = savedPosition.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  let positionSaveTimer = null;
  mainWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      const position = mainWindow.getBounds();
      store.set('windowPosition', { x: position.x, y: position.y });
    }, 300);
  });

  // Single interception point for ANY close request — native taskbar
  // "Close window", Alt+F4, or the in-app close button (which now just
  // calls mainWindow.close() and lets this decide). Only hide-to-tray when
  // there's an actual tray icon to bring it back via; otherwise let it
  // close normally so window-all-closed below can quit the process.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (hasTrayIcon()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Taskbar left-click restore (Windows) lands here. Re-validate position —
  // covers the case where the window was minimized before a monitor change
  // and is now restoring to coordinates that no longer exist.
  mainWindow.on('restore', () => {
    showMainWindowSmart();
  });

  // Taskbar left-click on an off-screen-but-not-minimized window fires
  // 'focus' without ever firing 'restore' (Electron's isVisible() is true
  // even when fully off-screen, so the window was never "minimized" in the
  // first place). This is what makes the very first click self-correct
  // instead of needing a focus -> minimize -> restore cycle first. Cheap
  // check, only acts when actually off-screen, so no effect on normal use.
  mainWindow.on('focus', () => {
    showMainWindowSmart();
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Determine background color based on thresholds
 */
function getBackgroundColor(percent, isSession, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  } else {
    // Default colors
    if (isSession) {
      // Purple #8b5cf6
      return { r: 139, g: 92, b: 246 };
    } else {
      // Blue #3b82f6
      return { r: 59, g: 130, b: 246 };
    }
  }
}

// Tray images are rendered on a <canvas> in a hidden BrowserWindow: that gives
// real system-font text and anti-aliased arcs for free, then tagged with
// scaleFactor: 2 so macOS shows them crisply on Retina displays.
const TRAY_ICON_SCALE = 2;
const TRAY_IDLE_COLOR = { r: 120, g: 120, b: 128 };
let trayCanvasWin = null;

function lerpColor(colorA, colorB, t) {
  return {
    r: Math.round(colorA.r + (colorB.r - colorA.r) * t),
    g: Math.round(colorA.g + (colorB.g - colorA.g) * t),
    b: Math.round(colorA.b + (colorB.b - colorA.b) * t),
  };
}

// Walks a multi-stop gradient (stops sorted by `at`, 0-100) and returns the
// interpolated color at the given percent.
function colorAtStops(stops, percent) {
  const p = Math.max(0, Math.min(100, percent));
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    if (p <= to.at) {
      return lerpColor(from.color, to.color, (p - from.at) / (to.at - from.at));
    }
  }
  return stops[stops.length - 1].color;
}

// Session ring: bright yellow -> dark yellow -> orange -> red as usage climbs.
const SESSION_RING_STOPS = [
  { at: 0, color: { r: 253, g: 224, b: 71 } },  // #fde047
  { at: 40, color: { r: 202, g: 138, b: 4 } },  // #ca8a04
  { at: 70, color: { r: 249, g: 115, b: 22 } }, // #f97316
  { at: 100, color: { r: 239, g: 68, b: 68 } }, // #ef4444
];

// Weekly ring: light blue -> dark blue as usage climbs.
const WEEKLY_RING_STOPS = [
  { at: 0, color: { r: 147, g: 197, b: 253 } },  // #93c5fd
  { at: 100, color: { r: 30, g: 58, b: 138 } },  // #1e3a8a
];

// Fable ring: light -> dark fuchsia, matching the widget's Fable bar.
const FABLE_RING_STOPS = [
  { at: 0, color: { r: 240, g: 171, b: 252 } },  // #f0abfc
  { at: 100, color: { r: 162, g: 28, b: 175 } }, // #a21caf
];

// Usage-ring tray arcs: one fixed color per limit, [dark menu bar, light menu bar].
const TRAY_TEXT_COLORS = {
  session: [{ r: 253, g: 224, b: 71 }, { r: 161, g: 98, b: 7 }],    // #fde047 / #a16207
  weekly: [{ r: 147, g: 197, b: 253 }, { r: 29, g: 78, b: 216 }],   // #93c5fd / #1d4ed8
  fable: [{ r: 240, g: 171, b: 252 }, { r: 162, g: 28, b: 175 }],   // #f0abfc / #a21caf
};

/**
 * Draws the tray image. Runs INSIDE the hidden canvas window (serialized via
 * toString + executeJavaScript), so it must be self-contained: no closures
 * over main-process state, plain JSON in, data URL out.
 *
 * Each row is a pie clock: the wedge is how much of the window has ELAPSED
 * (empty = just reset, full = about to reset), matching the widget's elapsed
 * circles. The wedge color tracks usage % along the bright -> danger
 * gradient; the optional text carries the exact number. No backdrop: text and
 * outlines are white or black to match the menu bar's appearance (spec.dark).
 *
 * @param {{scale:number, stacked:boolean, rows:Array<{kind:'ring'|'dot'|'noentry'|'text', color:{r,g,b}, elapsed:number|null, text:string|null, textColor?:{r,g,b}, extra?:object}>}} spec
 *   stacked: rows share one badge, one above the other (macOS single tray item)
 *   otherwise: a single square 20pt badge (Windows/Linux, one tray per stat)
 */
function drawTrayImage(spec) {
  const { scale, stacked, rows } = spec;
  const ROW = stacked ? 11 : 20;   // pt per row; 22pt total is the macOS menu bar limit
  const RING = stacked ? 10 : 16;  // ring diameter
  const PAD = stacked ? 3 : 2;
  const GAP = 3;                   // ring -> text
  const FONT = `600 ${stacked ? 9.5 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const rgb = (c) => `rgb(${c.r},${c.g},${c.b})`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  const hasText = rows.some((r) => r.text);
  // ringScale < 1 shrinks the pie (and its slot) away for the click-to-countdown flip.
  const ringScale = Math.max(...rows.map((r) => r.ringScale ?? 1));
  const ringW = RING * ringScale;
  // Never narrower than "88%" so the badge doesn't jitter as digits change.
  const textWidth = (t) => Math.max(ctx.measureText('88%').width, ctx.measureText(t).width);
  const textW = hasText ? Math.max(...rows.map((r) => textWidth(r.text || ''))) : 0;
  const mainW = ringW + (hasText ? GAP * ringScale + textW : 0);
  // Optional trailing cell on a row (Fable after Weekly), SEP pt after the main column.
  const SEP = 5;
  const shapeW = (r) => (r.kind === 'text' ? 0 : ringW + GAP * ringScale); // 'text' cells: no shape slot
  const extraW = (r) => (r.extra ? SEP + shapeW(r.extra) + (r.extra.text ? textWidth(r.extra.text) : 0) : 0);
  const W = Math.ceil(PAD + mainW + Math.max(...rows.map(extraW)) + PAD);
  const H = ROW * rows.length;
  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.scale(scale, scale);
  ctx.font = FONT; // resizing the canvas resets state
  ctx.textBaseline = 'middle';

  rows.forEach((row, i) => {
    const cy = ROW * i + ROW / 2;
    drawCell(row, PAD, cy);
    if (row.extra) drawCell(row.extra, PAD + mainW + SEP, cy);
  });

  function drawCell(row, x, cy) {
    const cx = x + ringW / 2;
    const r = ringW / 2;
    const color = row.color && rgb(row.color);
    ctx.lineCap = 'butt';

    if (row.kind === 'text') {
      // Text only, no shape.
    } else if (row.kind === 'gauge') {
      // Thin usage ring: faint full track, colored arc clockwise from 12 o'clock.
      // Round caps keep even 1% visible as a dot.
      const lw = 1.8, rr = r - lw / 2;
      ctx.lineWidth = lw;
      ctx.strokeStyle = spec.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      const fill = Math.max(0, Math.min(1, row.fill || 0));
      if (fill > 0) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.01, fill) * Math.PI * 2); ctx.stroke();
      }
    } else if (row.kind === 'noentry') {
      ctx.fillStyle = 'rgb(220,53,69)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(cx - r * 0.6, cy - r * 0.18, r * 1.2, r * 0.36);
    } else if (row.kind === 'dot') {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.65, 0, Math.PI * 2); ctx.fill();
    } else {
      // Filled pie on a dim disc: at 10pt a stroked arc with a hand was mush,
      // a wedge is readable at a glance and its leading edge IS the hand.
      const rr = Math.max(0, r - 0.5);
      ctx.fillStyle = spec.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)';
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
      if (row.elapsed !== null && row.elapsed !== undefined) {
        // Sweeps clockwise from 12 o'clock.
        const sweep = Math.max(0, Math.min(1, row.elapsed)) * Math.PI * 2;
        const start = -Math.PI / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rr, start, start + sweep);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = spec.dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    }

    if (row.text) {
      ctx.fillStyle = row.textColor ? rgb(row.textColor) : spec.dark ? '#fff' : '#000';
      ctx.fillText(row.text, x + shapeW(row), cy + 0.5);
    }
  }

  return canvas.toDataURL('image/png');
}

async function renderTrayImage(rows, stacked) {
  if (!trayCanvasWin || trayCanvasWin.isDestroyed()) {
    trayCanvasWin = new BrowserWindow({
      show: false, width: 200, height: 60,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await trayCanvasWin.loadURL('about:blank');
  }
  // Always white text/outlines: the macOS menu bar tints with the wallpaper, not the system theme, so shouldUseDarkColors guesses wrong.
  const spec = JSON.stringify({ scale: TRAY_ICON_SCALE, stacked, rows, dark: true });
  const dataUrl = await trayCanvasWin.webContents.executeJavaScript(`(${drawTrayImage.toString()})(${spec})`);
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return nativeImage.createFromBuffer(png, { scaleFactor: TRAY_ICON_SCALE });
}


/**
 * Format remaining time until reset for tray display, e.g. "2h 14m", "3d 4h", "45m".
 * Mirrors the widget's own countdown formatting in src/renderer/app.js (updateTimer)
 * so the tray and the widget window never disagree.
 */
// Click-to-flip on the stacked macOS item: 0 = pies + percent, 1 = countdown
// text only. Each click animates to the other side in a few frames and stays.
let trayFlip = 0;
let trayFlipTarget = 0;
let trayFlipRun = 0;

async function toggleTrayFlip() {
  const run = ++trayFlipRun; // a newer click supersedes this animation
  trayFlipTarget = trayFlipTarget ? 0 : 1;
  const from = trayFlip;
  for (let f = 1; f <= 6; f++) {
    if (run !== trayFlipRun) return;
    trayFlip = from + (trayFlipTarget - from) * (f / 6);
    const data = store.get('latestUsageData');
    if (data) await updateTrayIcon(data);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function formatElapsedCountdown(diffMs) {
  if (diffMs <= 0) return 'resetting…';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}




function createTray() {
  // Respect the tray stats setting even when createTray is called from generic refresh paths.
  if (!store.get('settings.showTrayStats', false)) {
    destroyTrayIcons();
    return;
  }

  // macOS: ONE tray item showing both stats stacked (session over weekly), since
  // each NSStatusItem carries its own fixed padding and two of them ate the
  // menu bar. Elsewhere: one square icon per stat.
  const wantTrays = process.platform === 'darwin' ? 1 : 2;
  const alive = [sessionTray, weeklyTray].filter((t) => t && !t.isDestroyed()).length;
  if (alive === wantTrays) return;
  if (alive) destroyTrayIcons();

  try {
    const staticIconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : process.platform === 'linux' ? 'assets/tray-icon-linux.png' : 'assets/tray-icon.png');

    if (wantTrays === 2) {
      // Weekly tray icon FIRST (left position, blue)
      weeklyTray = new Tray(staticIconPath);
      weeklyTray.setToolTip('Weekly Usage');
    }

    // Session tray icon SECOND (right position, yellow/red); the only one on macOS.
    sessionTray = new Tray(staticIconPath);
    sessionTray.setToolTip(wantTrays === 2 ? 'Session Usage' : 'Claude Usage');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Widget',
        click: () => {
          showMainWindowSmart();
        }
      },
      {
        label: 'Refresh',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('refresh-usage');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Log Out',
        click: async () => {
          store.delete('sessionKey');
          store.delete('organizationId');
          // Clear all Claude.ai cookies and session storage
          const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
          for (const cookie of cookies) {
            await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
          }
          await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'sessionstorage', 'cachestorage'],
            origin: 'https://claude.ai'
          });
          if (mainWindow) {
            mainWindow.webContents.send('session-expired');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.quit();
        }
      }
    ]);

    for (const tray of [sessionTray, weeklyTray]) {
      if (!tray) continue;
      // macOS: an attached context menu swallows left-clicks (no 'click' event),
      // so pop it on right-click only. Left-click there toggles pies <-> countdown
      // and refreshes; the widget opens via the menu's "Show Widget".
      if (process.platform === 'darwin') {
        tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
        tray.on('click', () => {
          toggleTrayFlip();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('refresh-usage');
        });
        continue;
      }
      tray.setContextMenu(contextMenu);
      tray.on('click', () => {
        if (isMainWindowShownOnScreen()) {
          mainWindow.hide();
        } else {
          showMainWindowSmart();
        }
      });
    }
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [sessionTray, weeklyTray];
  sessionTray = null;
  weeklyTray = null;
  if (trayCanvasWin && !trayCanvasWin.isDestroyed()) trayCanvasWin.destroy();
  trayCanvasWin = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');

      // On Linux, some appindicator hosts repaint stale tray entries lazily.
      // Clearing the image before destroy gives the host an explicit update.
      if (process.platform === 'linux') {
        tray.setImage(nativeImage.createEmpty());
      }
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
async function updateTrayIcon(usageData) {
  const showTrayStats = store.get('settings.showTrayStats', false);

  if (!showTrayStats) return; // tray existence is owned by createTray()/destroyTrayIcons()

  createTray(); // no-op when the expected tray items are already alive
  if (!hasTrayIcon()) return;

  // Get threshold settings and time format
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const timeFormat = store.get('settings.timeFormat', '12h');
  // 'ring': usage ring only. 'text': flat status dot + text (percent +
  // countdown). 'both': usage ring + percent. Text only fits on macOS, where
  // the single stacked item is wide; Windows/Linux tray slots are square.
  const displayMode = store.get('settings.trayDisplayMode', 'both');
  const stacked = process.platform === 'darwin';

  // Extract percentages and reset times from usage data
  const sessionPercent = usageData?.five_hour?.utilization || 0;
  const sessionResetsAt = usageData?.five_hour?.resets_at;
  const weeklyPercent = usageData?.seven_day?.utilization || 0;
  const weeklyResetsAt = usageData?.seven_day?.resets_at;

  const now = Date.now();

  // Time-remaining string for the countdown shown in 'text' mode and the
  // tooltip, plus how much of the window has elapsed as a 0..1 fraction for
  // the ring. null when there's no active window yet (resets_at absent).
  function elapsedInfo(resetsAt, windowMs) {
    if (!resetsAt) return null;
    const diff = new Date(resetsAt).getTime() - now;
    return {
      remainingText: formatElapsedCountdown(diff),
      elapsedFraction: Math.max(0, Math.min(1, 1 - diff / windowMs)),
    };
  }

  const HOUR_MS = 60 * 60 * 1000;
  const sessionElapsed = elapsedInfo(sessionResetsAt, 5 * HOUR_MS);
  const weeklyElapsed = elapsedInfo(weeklyResetsAt, 7 * 24 * HOUR_MS);

  // One drawTrayImage row for a stat. 99-100% (maxed out) shows a "no entry"
  // sign regardless of mode: "you're capped" trumps "here's how much time is left".
  function rowSpec(percent, elapsed, stops, isSession) {
    const kind = percent >= 99 ? 'noentry' : displayMode === 'text' ? 'dot' : 'ring';
    const color = kind === 'dot'
      ? getBackgroundColor(percent, isSession, warnThreshold, dangerThreshold)
      : elapsed ? colorAtStops(stops, percent) : TRAY_IDLE_COLOR;
    const pct = `${Math.round(percent)}%`;
    let text = null;
    if (stacked && displayMode !== 'ring') {
      text = displayMode === 'text' && elapsed ? `${pct} · ${elapsed.remainingText}` : pct;
    }
    // Mid-flip: the pie shrinks away and the countdown takes the text slot.
    // 'text' mode already shows the countdown, so it doesn't flip.
    let ringScale = 1;
    if (stacked && trayFlip > 0 && kind !== 'dot') {
      ringScale = 1 - trayFlip;
      if (trayFlip >= 0.5) text = elapsed ? elapsed.remainingText : '—';
    }
    return { kind, color, elapsed: elapsed ? elapsed.elapsedFraction : null, text, ringScale };
  }

  function tooltip(label, percent, resetsAt, elapsed, isSession) {
    let tip = `${label}: ${Math.round(percent)}%`;
    const resetTime = formatResetTime(resetsAt, timeFormat, !isSession);
    if (resetTime) tip += `\nResets: ${resetTime}`;
    if (elapsed) tip += ` (in ${elapsed.remainingText})`;
    return tip;
  }

  const sessionRow = rowSpec(sessionPercent, sessionElapsed, SESSION_RING_STOPS, true);
  const weeklyRow = rowSpec(weeklyPercent, weeklyElapsed, WEEKLY_RING_STOPS, false);
  const sessionTip = tooltip('Session', sessionPercent, sessionResetsAt, sessionElapsed, true);
  let weeklyTip = tooltip('Weekly', weeklyPercent, weeklyResetsAt, weeklyElapsed, false);

  // Fable (scoped weekly limit) takes the slot under Session, keeping the
  // percent view one compact column. Weekly only appears on the wider
  // countdown side, as "Weekly 6% · Sat": it resets at the same hour:minute as
  // Fable, so the weekday is enough. It also stays visible when capped or in
  // 'text' mode (no flip there). Square Windows/Linux slots skip Fable.
  let bottomRow = weeklyRow;
  const fable = usageData?.seven_day_fable;
  const fablePercent = fable?.utilization || 0;
  const fableElapsed = fable ? elapsedInfo(fable.resets_at, 7 * 24 * HOUR_MS) : null;
  if (stacked && fable) {
    bottomRow = rowSpec(fablePercent, fableElapsed, FABLE_RING_STOPS, false);
    if (trayFlip >= 0.5 && weeklyRow.kind === 'ring') {
      const day = weeklyResetsAt ? new Date(weeklyResetsAt).toLocaleDateString(undefined, { weekday: 'short' }) : '—';
      weeklyRow.text = `Weekly ${Math.round(weeklyPercent)}% · ${day}`;
    }
    if (trayFlip >= 0.5 || weeklyRow.kind !== 'ring') bottomRow.extra = weeklyRow;
    weeklyTip += `\n${tooltip('Fable', fablePercent, fable.resets_at, fableElapsed, false)}`;
  }

  // 'text' mode on macOS: plain numbers, each behind a thin ring whose arc
  // is the usage in that limit's color (red at the danger threshold). Session
  // on top, Weekly then Fable below. Click flips the text to time remaining;
  // the rings stay put so it's clear which time is which. Weekly shows only
  // its reset weekday there, since it resets at the same hour:minute as Fable.
  let stackedRows = [sessionRow, bottomRow];
  if (stacked && displayMode === 'text') {
    const flipped = trayFlip >= 0.5;
    const cell = (percent, palette, flippedText) => ({
      kind: 'gauge',
      fill: percent / 100,
      color: percent >= dangerThreshold ? { r: 239, g: 68, b: 68 } : palette[0],
      text: flipped ? flippedText || '—' : `${Math.round(percent)}%`,
    });
    const weeklyDay = weeklyResetsAt ? new Date(weeklyResetsAt).toLocaleDateString(undefined, { weekday: 'short' }) : null;
    const weeklyCell = cell(weeklyPercent, TRAY_TEXT_COLORS.weekly, fable ? weeklyDay : weeklyElapsed?.remainingText);
    if (fable) weeklyCell.extra = cell(fablePercent, TRAY_TEXT_COLORS.fable, fableElapsed?.remainingText);
    const sessionCell = cell(sessionPercent, TRAY_TEXT_COLORS.session, sessionElapsed?.remainingText);
    // Second column on the top row too: Session's countdown, or its reset clock time once flipped.
    const sessionResetClock = sessionResetsAt
      ? new Date(sessionResetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: timeFormat === '12h' })
      : null;
    sessionCell.extra = { kind: 'text', text: (flipped ? sessionResetClock : sessionElapsed?.remainingText) || '—' };
    stackedRows = [sessionCell, weeklyCell];
  }

  try {
    if (stacked) {
      const image = await renderTrayImage(stackedRows, true);
      if (!sessionTray || sessionTray.isDestroyed()) return;
      sessionTray.setImage(image);
      sessionTray.setTitle('');
      sessionTray.setToolTip(`${sessionTip}\n${weeklyTip}`);
    } else {
      const [sessionImage, weeklyImage] = await Promise.all([
        renderTrayImage([sessionRow], false),
        renderTrayImage([weeklyRow], false),
      ]);
      if (sessionTray && !sessionTray.isDestroyed()) {
        sessionTray.setImage(sessionImage);
        sessionTray.setToolTip(sessionTip);
      }
      if (weeklyTray && !weeklyTray.isDestroyed()) {
        weeklyTray.setImage(weeklyImage);
        weeklyTray.setToolTip(weeklyTip);
      }
    }
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}


// IPC Handlers
ipcMain.handle('get-credentials', () => {
  let sessionKey = null;
  // Try safeStorage first (OS keychain)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    // Fallback: plain storage (legacy or safeStorage unavailable)
    sessionKey = store.get('sessionKey');
  }
  return {
    sessionKey,
    organizationId: store.get('organizationId')
  };
});

ipcMain.handle('save-credentials', async (event, { sessionKey, organizationId }) => {
  // Store session key in OS keychain if available
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set('sessionKey_encrypted', encrypted.toString('base64'));
    store.delete('sessionKey'); // Remove legacy plain storage
  } else {
    // Fallback: plain storage
    store.set('sessionKey', sessionKey);
  }
  if (organizationId) {
    store.set('organizationId', organizationId);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  // Remove all Claude.ai cookies
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  // Clear any cached data from the Electron session (storage, cache)
  // so nothing lingers on shared machines
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow
ipcMain.handle('validate-session-key', async (event, sessionKey) => {
  debugLog('Validating session key:', sessionKey.substring(0, 20) + '...');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter(org => 
        org.capabilities && org.capabilities.includes('chat')
      );

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritize Teams org if present, otherwise use first chat org
      const defaultOrg = chatOrgs.find(org => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;
      
      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);
      
      return { 
        success: true, 
        organizationId: orgId,
        organizations: chatOrgs.map(org => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      if (minimizeToTray && hasTrayIcon()) {
        mainWindow.hide();
      } else {
        mainWindow.minimize();
      }
    }
  }
});

// Delegates to the mainWindow 'close' handler, which is the single source of
// truth for hide-vs-quit (checks hasTrayIcon()). Keeps that decision in one
// place instead of duplicating it here and risking the two drifting apart.
ipcMain.on('close-window', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.on('resize-window', (event, height) => {
  if (mainWindow) {
    mainWindow.setContentSize(WIDGET_WIDTH, height);
  }
});

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'github.com', 'paypal.me'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-usage-history', () => {
  const organizationId = store.get('organizationId');
  const historyKey = organizationId ? `usageHistory_${organizationId}` : 'usageHistory';
  const history = store.get(historyKey, []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Resize window for compact vs normal mode
// Compact: 290px wide, normal: 530px wide. Height stays managed by renderer.
ipcMain.on('set-compact-mode', (event, compact) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    const width = compact ? COMPACT_WIDTH : WIDGET_WIDTH;
    const height = compact ? getCompactHeight() : WIDGET_HEIGHT;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
  }
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    compactMode: store.get('settings.compactMode', false),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    compactSpendOpen: store.get('settings.compactSpendOpen', false),
    showTrayStats: store.get('settings.showTrayStats', false),
    trayDisplayMode: store.get('settings.trayDisplayMode', 'both')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const supportsLoginItems = process.platform !== 'linux';
  const autoStart = supportsLoginItems ? settings.autoStart : false;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.compactMode', settings.compactMode);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  // Guarded: settings objects cached by the renderer before this field
  // existed would otherwise overwrite the stored value with undefined.
  if (settings.compactSpendOpen !== undefined) {
    store.set('settings.compactSpendOpen', settings.compactSpendOpen);
  }
  store.set('settings.showTrayStats', settings.showTrayStats);
  if (settings.trayDisplayMode) {
    store.set('settings.trayDisplayMode', settings.trayDisplayMode);
  }

  const isPortable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;

  // openAtLogin is not supported on Linux — Electron silently ignores it.
  // Skip the call entirely to avoid misleading behaviour.
  // Also skip for portable builds — autorun via registry is unreliable when the
  // exe path changes with each version. Users should use shell:startup instead.
  if (supportsLoginItems && !isPortable) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  if (!settings.showTrayStats) {
    // Remove tray icons immediately when the setting is turned off from the UI.
    destroyTrayIcons();
  } else {
    // Refresh tray icons immediately with new threshold settings
    const latestUsageData = store.get('latestUsageData');
    if (latestUsageData) {
      updateTrayIcon(latestUsageData);
    } else {
      // Create empty tray icons now; the next usage refresh will draw the stats.
      createTray();
    }
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
ipcMain.handle('detect-session-key', async () => {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

// Fetches and JSON-parses a GitHub API path. Resolves null on any failure
// (network error, timeout, non-JSON body) rather than rejecting, so callers
// can treat "couldn't check" the same as "nothing new" without a try/catch.
function fetchGithubJson(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Check GitHub releases for a newer version. Runs the stable-release check
// for everyone; if the local build is itself a pre-release and no stable
// update supersedes it, also checks for a newer pre-release specifically —
// GitHub's /releases/latest endpoint never returns pre-releases, so that
// requires a second call to the plural /releases endpoint, which returns
// every release (stable and pre-release) with a "prerelease" boolean.
ipcMain.handle('check-for-update', async () => {
  const current = app.getVersion();

  const latest = await fetchGithubJson(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
  const latestTag = (latest?.tag_name || '').replace(/^v/, '');
  if (latestTag && isNewerVersion(latestTag, current)) {
    store.set('updateBannerVisible', true);
    return { hasUpdate: true, version: latestTag };
  }

  // 'dev' is the constant placeholder version checked into develop itself —
  // not a numbered pre-release track like rc/beta. A dev-branch runner is
  // always at least as new as whatever RC was last cut from develop, so
  // "there's a newer pre-release" would be backwards information for them.
  const localVersion = parseVersion(current);
  if (localVersion.preRelease !== null && localVersion.preReleaseLabel !== 'dev') {
    const all = await fetchGithubJson(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`);
    const newestPreRelease = Array.isArray(all) ? all.find((r) => r.prerelease) : null;
    const preTag = (newestPreRelease?.tag_name || '').replace(/^v/, '');
    if (preTag && isNewerPreRelease(preTag, current)) {
      store.set('updateBannerVisible', true);
      return { hasUpdate: true, version: preTag };
    }
  }

  store.set('updateBannerVisible', false);
  return { hasUpdate: false, version: null };
});

// Parses "1.7.6-rc.10" into comparable parts. preReleaseNum is parsed as an
// integer specifically so "rc.10" sorts after "rc.9" — comparing the raw
// preRelease string ("rc.10" vs "rc.9") breaks past single digits.
function parseVersion(ver) {
  const [mainVer, preRelease] = ver.split('-');
  const parts = mainVer.split('.').map(Number);
  let preReleaseLabel = null;
  let preReleaseNum = 0;
  if (preRelease) {
    const match = preRelease.match(/^([a-zA-Z]+)\.?(\d+)?$/);
    if (match) {
      preReleaseLabel = match[1];
      preReleaseNum = match[2] ? parseInt(match[2], 10) : 0;
    } else {
      preReleaseLabel = preRelease; // unrecognized suffix format — fall back to raw string
    }
  }
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    preRelease: preRelease || null,
    preReleaseLabel,
    preReleaseNum
  };
}

// Returns 1 if a > b, -1 if a < b, 0 if equal. A stable version (no
// preRelease) outranks any pre-release of the same major.minor.patch.
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.preRelease === null && b.preRelease === null) return 0;
  if (a.preRelease === null) return 1;
  if (b.preRelease === null) return -1;
  if (a.preReleaseLabel !== b.preReleaseLabel) {
    return a.preReleaseLabel > b.preReleaseLabel ? 1 : -1; // e.g. rc vs beta — not currently used, but won't crash
  }
  return a.preReleaseNum > b.preReleaseNum ? 1 : (a.preReleaseNum < b.preReleaseNum ? -1 : 0);
}

// Used for the stable-release check that runs for every user. Never
// surfaces a pre-release as an update, regardless of what the local build is.
function isNewerVersion(remote, local) {
  try {
    const r = parseVersion(remote);
    if (r.preRelease !== null) return false;
    return compareVersions(r, parseVersion(local)) > 0;
  } catch { return false; }
}

// Only meaningful when the local build is itself a pre-release. Compares
// remote against local including the pre-release number, so an rc.2 user is
// correctly notified about rc.3 (numeric comparison, not string comparison —
// see parseVersion). Also correctly surfaces a newer pre-release for a later
// major/minor/patch, not just a higher rc number on the same base version.
function isNewerPreRelease(remote, local) {
  try {
    const l = parseVersion(local);
    if (l.preRelease === null) return false;
    return compareVersions(parseVersion(remote), l) > 0;
  } catch { return false; }
}

ipcMain.handle('fetch-usage-data', async (event, options = {}) => {
  // Use the same credential retrieval logic as get-credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  const organizationId = store.get('organizationId');

  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  // Conditional API polling: Only fetch overage/prepaid if the expand panel is open
  // or if compact mode is disabled (normal mode). This reduces API calls when the
  // user won't see the extra usage data anyway.
  // If forceExtended is passed (e.g., when user clicks expand), use that instead of saved setting
  const expandedOpen = options.forceExtended !== undefined ? options.forceExtended : store.get('settings.expandedOpen', false);
  const compactMode = store.get('settings.compactMode', false);
  // Compact mode forces the main expanded panel closed, so spend/credit
  // endpoints are additionally polled while the compact spend row is toggled
  // open. Collapsed compact mode does not poll the extended endpoints at all.
  const compactSpendOpen = compactMode && store.get('settings.compactSpendOpen', false);
  const shouldFetchExtended = expandedOpen || compactSpendOpen;

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // Build URL array based on UI state
  const urls = [usageUrl];
  if (shouldFetchExtended) {
    urls.push(overageUrl, prepaidUrl);
    debugLog('[Conditional Polling] Fetching extended data (overage + prepaid) - panel is visible');
  } else {
    debugLog('[Conditional Polling] Skipping extended data - panel not visible');
  }

  // Fetch endpoints sequentially using a single reused BrowserWindow.
  // This reduces memory overhead compared to creating 3 separate windows.
  // Usage is always required; overage and prepaid are conditional based on UI state.
  let usageResult, overageResult, prepaidResult;
  
  try {
    const results = await fetchMultipleViaWindow(urls);
    
    // Always have usage result (first in array)
    usageResult = { status: 'fulfilled', value: results[0] };
    
    // Conditionally map overage/prepaid results
    if (shouldFetchExtended) {
      overageResult = { status: 'fulfilled', value: results[1] };
      prepaidResult = { status: 'fulfilled', value: results[2] };
    } else {
      // Mark as skipped (not an error, just not fetched)
      overageResult = { status: 'skipped', reason: 'UI panel not visible' };
      prepaidResult = { status: 'skipped', reason: 'UI panel not visible' };
    }
  } catch (error) {
    // If any fetch fails, determine which one and set appropriate result statuses
    // For now, if the batch fails, treat usage as failed (required endpoint)
    usageResult = { status: 'rejected', reason: error };
    overageResult = { status: 'rejected', reason: error };
    prepaidResult = { status: 'rejected', reason: error };
  }

  // Usage endpoint is mandatory
  if (usageResult.status === 'rejected') {
    const error = usageResult.reason;
    debugLog('API request failed:', error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      store.delete('sessionKey');
      store.delete('organizationId');
      if (mainWindow) {
        mainWindow.webContents.send('session-expired');
      }
      throw new Error('SessionExpired');
    }
    throw error;
  }

  const data = usageResult.value;

  // Normalize per-model weekly limits (e.g. Fable) from the `limits` array into
  // synthetic seven_day_<name> top-level fields BEFORE they are stored to
  // history or returned to the renderer, so both consumers share one source of
  // truth. Must run before storeUsageHistory() and before `return data`.
  normalizeUsageLimits(data);

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
        is_enabled: true,
        currency: overage.currency || 'USD',
      };
    } else if (!enabled) {
      // Extra usage is off — still pass the flag so the renderer can show status
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.is_enabled = false;
      data.extra_usage.currency = overage.currency || 'USD';
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
      // Use prepaid currency if overage didn't already set one
      if (!data.extra_usage.currency && prepaid.currency) {
        data.extra_usage.currency = prepaid.currency;
      }

      // Credit clarity: split promotional vs purchased tranches so the
      // renderer can show "money at risk" and expiry warnings.
      const sumTranches = (arr) => Array.isArray(arr)
        ? arr.reduce((s, t) => s + (t.remaining_amount_minor_units || 0), 0)
        : null;
      const promoCents = sumTranches(prepaid.promo_tranches);
      const paidCents = sumTranches(prepaid.tranches);
      if (promoCents != null) data.extra_usage.promo_cents = promoCents;
      if (paidCents != null) data.extra_usage.paid_cents = paidCents;

      if (prepaid.next_expires_at) {
        data.extra_usage.next_expires_at = prepaid.next_expires_at;
        // Amount expiring at that date = sum of all tranches sharing it
        const allTranches = [
          ...(Array.isArray(prepaid.promo_tranches) ? prepaid.promo_tranches : []),
          ...(Array.isArray(prepaid.tranches) ? prepaid.tranches : []),
        ];
        data.extra_usage.next_expiry_cents = allTranches
          .filter((t) => t.expires_at === prepaid.next_expires_at)
          .reduce((s, t) => s + (t.remaining_amount_minor_units || 0), 0);
      }
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  storeUsageHistory(data);

  // Store latest usage data for settings refresh
  store.set('latestUsageData', data);

  // Update tray icon with current usage data
  updateTrayIcon(data);

  // Keep the compact window sized correctly if the Fable row just appeared/disappeared
  if (mainWindow && !mainWindow.isDestroyed() && store.get('settings.compactMode', false)) {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: COMPACT_WIDTH, height: getCompactHeight() });
  }

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const alwaysOnTop = store.get('settings.alwaysOnTop', true);
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
    }
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  // Restore session cookie if we have stored credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key on startup:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  migrateUsageHistoryKey();
  pruneStaleHistoryKeys();

  createMainWindow();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Clear any stale Jump List tasks from earlier builds (the removed
  // taskbar "Center App" task). Windows caches setUserTasks() entries
  // against the AppUserModelID independently of whether the app still
  // calls it, so simply removing the code that set it isn't enough.
  if (process.platform === 'win32') {
    app.setUserTasks([]);
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  // Redraw the tray icons on the same 30s cadence the widget's own ELAPSED
  // rings use (see startCountdown() in app.js), so the countdown visibly
  // ticks down between the ~5min network refreshes rather than jumping.
  // Redraws from the last fetched data only — no network call.
  setInterval(() => {
    if (store.get('settings.showTrayStats', false)) {
      const latestUsageData = store.get('latestUsageData');
      if (latestUsageData) updateTrayIcon(latestUsageData);
    }
  }, 30000);

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
      if (alwaysOnTopSetting) {
        mainWindow.setAlwaysOnTop(true, 'floating');
      }
    }
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Safety net: the 'close' handler above is the primary gate, but if
    // something else ever destroys the window without going through it,
    // don't leave a headless zombie process with no tray icon to recover
    // through. Keep running only when a tray icon actually exists.
    if (!hasTrayIcon()) {
      app.quit();
    }
  }
});

// Fires before any window's 'close' event on every genuine quit path.
// Without this flag, the mainWindow 'close' handler can't tell a real
// quit apart from a click on the close button to just minimize.
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  showMainWindowSmart();
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindowSmart();
  });
}
