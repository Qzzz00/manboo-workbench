// Aiboo Hologram - Windows local launcher.
// Double-click holo.exe (or START.bat) -> serve the adjacent web/ folder on 127.0.0.1,
// then open the holo page fullscreen in Edge (?server points to the backend). All localhost, no LAN.
//
// Node built-ins only (so pkg bundles into a single exe). web/ sits next to the exe (not embedded).
// NOTE: console output is ASCII-only on purpose so it stays readable on any Windows code page.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ── Keep the console window open on error (so errors don't flash away) ──
function holdWindow(reason) {
  if (reason) console.error('\n>>> ' + reason);
  try {
    if (process.platform === 'win32') {
      execSync('cmd /c pause', { stdio: 'inherit' });
    } else {
      console.error('(Ctrl+C to exit)');
      process.stdin.resume();
    }
  } catch (_) {
    try { process.stdin.resume(); } catch (__) { /* noop */ }
  }
}
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e && e.stack ? e.stack : e);
  holdWindow('Startup failed (uncaught exception). Screenshot this and send to the developer.');
});
process.on('unhandledRejection', (e) => {
  console.error('Unhandled rejection:', e && e.stack ? e.stack : e);
  holdWindow('Startup failed (promise rejection). Screenshot this and send to the developer.');
});

// ── Config ──
const PORT = 47190;
const DEFAULT_SERVER_URL = 'http://your-aiboo-host:3456'; // default backend (Aliyun)
// exe 自身版本：每次改本 launcher / 重打 exe 时 +1。用户端 exe 启动时据此比对阿里云
// exe-version.json，新则后台下 holo.exe.new，下次【启动全息屏.bat】换壳生效（Windows 不能覆盖运行中的 exe）。
const EXE_VERSION = 'exe-1';

// web/ lives next to the exe (pkg: process.execPath = exe path; dev: __dirname).
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;
const WEB_ROOT = path.join(baseDir, 'web');

// Backend URL: prefer server.txt next to the exe (change backend without rebuilding), else default.
let SERVER_URL = DEFAULT_SERVER_URL;
try {
  const txt = fs.readFileSync(path.join(baseDir, 'server.txt'), 'utf8').trim();
  if (txt) SERVER_URL = txt;
} catch (_) { /* no server.txt -> use default */ }
const START_PATH = `/holo.html?server=${encodeURIComponent(SERVER_URL)}`;

// ── Startup diagnostics ──
console.log('===== Aiboo Hologram launcher =====');
console.log('exe dir  :', baseDir);
console.log('web dir  :', WEB_ROOT, 'exists=', fs.existsSync(WEB_ROOT));
console.log('backend  :', SERVER_URL);
console.log('port     :', PORT);
console.log('node     :', process.version);
console.log('===================================');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Prevent path traversal: normalize the request path and keep it inside WEB_ROOT.
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const resolved = path.normalize(path.join(WEB_ROOT, clean));
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) return null;
  return resolved;
}

function openBrowser() {
  const url = `http://127.0.0.1:${PORT}${START_PATH}`;
  try {
    if (process.platform === 'win32') {
      // --start-fullscreen（非 --kiosk）：全屏但可退出（Alt+F4 / F11），避免 kiosk 锁死关不掉。
      const edgeArgs = ['/c', 'start', '', 'msedge', '--start-fullscreen', url,
        '--no-first-run', '--disable-features=TranslateUI'];
      const p = spawn('cmd', edgeArgs, { detached: true, stdio: 'ignore' });
      p.on('error', () => {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      });
      p.unref();
    } else {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.error('Failed to open browser (open manually: ' + url + '):', e && e.message);
  }
}

const server = http.createServer((req, res) => {
  let filePath = resolveSafe(req.url === '/' ? '/holo.html' : req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'holo.html');
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + req.url);
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      res.end(data);
    });
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' already in use (maybe already running) -> opening browser.');
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error('Server listen failed:', e && e.stack ? e.stack : e);
    holdWindow('Cannot start server on 127.0.0.1:' + PORT + ' (may be blocked by security software). Screenshot this.');
  }
});

// ── Auto-update: pull latest front-end (JS/HTML/assets) from the backend on startup ──
// Live2D (140MB) stays local and is NOT in the package, so updates are tiny (~9MB).
// version.json holds a content sha; only re-download when it changes. Any failure (offline,
// backend down) is non-fatal: we fall back to the local web/ folder and start anyway.
const { URL } = require('url');

function httpGetBuffer(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(urlStr, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
  });
}

// 更新包在后端的相对路径。当前寄生在 admin-ui 静态根下(/holo-up/)，零改后端零重启即可发布。
const UPDATE_BASE = '/holo-up';

async function checkUpdate() {
  const base = SERVER_URL.replace(/\/+$/, '');
  const verFile = path.join(WEB_ROOT, '.holo-version');
  let localVer = '';
  try { localVer = fs.readFileSync(verFile, 'utf8').trim(); } catch (_) { /* first run */ }

  let remoteVer;
  try {
    const buf = await httpGetBuffer(base + UPDATE_BASE + '/version.json', 8000);
    remoteVer = JSON.parse(buf.toString('utf8')).version;
  } catch (e) {
    console.log('[update] version check failed (' + e.message + ') -> using local web/');
    return;
  }
  if (!remoteVer || remoteVer === localVer) {
    console.log('[update] up to date (' + (localVer || 'none') + ')');
    return;
  }

  console.log('[update] new version ' + remoteVer + ' (local ' + (localVer || 'none') + ') -> downloading ~9MB…');
  const zipPath = path.join(baseDir, 'holo-assets.zip');
  try {
    const zip = await httpGetBuffer(base + UPDATE_BASE + '/holo-assets.zip', 120000);
    fs.writeFileSync(zipPath, zip);
  } catch (e) {
    console.log('[update] download failed (' + e.message + ') -> using local web/');
    return;
  }
  // Extract over web/ (Live2D not in the zip, so local models are preserved).
  try {
    if (process.platform === 'win32') {
      // PowerShell Expand-Archive: ships with Win10+. -Force overwrites changed files.
      execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path \'' + zipPath + '\' -DestinationPath \'' + WEB_ROOT + '\' -Force"', { stdio: 'inherit' });
    } else {
      execSync('unzip -oq "' + zipPath + '" -d "' + WEB_ROOT + '"', { stdio: 'inherit' });
    }
    fs.writeFileSync(verFile, remoteVer);
    try { fs.unlinkSync(zipPath); } catch (_) { /* leave stale zip */ }
    console.log('[update] updated to ' + remoteVer);
  } catch (e) {
    console.log('[update] extract failed (' + e.message + ') -> using local web/ (may be stale)');
  }
}

// ── exe 自更新：连 launcher 本体也自动更新 ──
// Windows 不能覆盖运行中的 exe，故：启动时(后台)拉阿里云 exe-version.json 比对 EXE_VERSION，
// 新则下 holo.exe → holo.exe.new（不动运行中的 holo.exe）。下次【启动全息屏.bat】启动前换壳。
// 全程非阻塞、失败静默——不影响本次启动。装一次带本逻辑的 exe 后，以后连 exe 都不用手动传。
async function checkExeUpdate() {
  if (!isPkg) return; // 仅打包 exe 有意义（dev 下没有 exe 可换）
  const base = SERVER_URL.replace(/\/+$/, '');
  let remoteVer;
  try {
    const buf = await httpGetBuffer(base + UPDATE_BASE + '/exe-version.json', 8000);
    remoteVer = JSON.parse(buf.toString('utf8')).version;
  } catch (e) {
    console.log('[exe-update] version check failed (' + e.message + ')');
    return;
  }
  if (!remoteVer || remoteVer === EXE_VERSION) {
    console.log('[exe-update] exe up to date (' + EXE_VERSION + ')');
    return;
  }
  const newPath = path.join(baseDir, 'holo.exe.new');
  const verPath = newPath + '.ver';
  let staged = '';
  try { staged = fs.readFileSync(verPath, 'utf8').trim(); } catch (_) { /* none */ }
  if (fs.existsSync(newPath) && staged === remoteVer) {
    console.log('[exe-update] new exe ' + remoteVer + ' already downloaded -> restart via 启动全息屏.bat to apply');
    return;
  }
  console.log('[exe-update] new exe ' + remoteVer + ' (current ' + EXE_VERSION + ') -> downloading in background…');
  try {
    const exe = await httpGetBuffer(base + UPDATE_BASE + '/holo.exe', 300000);
    fs.writeFileSync(newPath, exe);
    fs.writeFileSync(verPath, remoteVer);
    console.log('[exe-update] downloaded ' + remoteVer + ' -> applies on next start (启动全息屏.bat swaps it in)');
  } catch (e) {
    console.log('[exe-update] download failed (' + e.message + ')');
  }
}

// ── Start ──
(async () => {
  if (!fs.existsSync(WEB_ROOT)) {
    holdWindow('web/ folder not found: ' + WEB_ROOT + '\nMake sure holo.exe and the web folder are together in the same directory.');
    return;
  }
  await checkUpdate(); // pull latest front-end (blocks briefly; non-fatal on failure)
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Running -> http://127.0.0.1:' + PORT + START_PATH);
    console.log('(Keep this window open = server running. Close it to stop. Alt+F4 exits Edge kiosk.)');
    if (process.env.HOLO_NO_OPEN !== '1') openBrowser();
    void checkExeUpdate(); // exe 自更新在后台跑（不阻塞开屏），下次启动生效
  });
})();
