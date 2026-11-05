// 真机 WebView CDP eval：在连接的 Android WebView 里跑一段 JS（支持 async/await，返回 JSON）。
// 用法：node scripts/cdp-eval.cjs '<js-expression>'
// 前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
const WebSocket = require('ws');
const http = require('http');

const expr = process.argv[2];
if (!expr) { console.error('usage: cdp-eval.cjs "<expr>"'); process.exit(1); }

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const pages = await getJSON('/json');
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) || pages[0];
  if (!page || !page.webSocketDebuggerUrl) { console.error('no debuggable page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await send('Runtime.enable', {});
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{ return (${expr}); })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.result && r.result.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails));
  const out = r.result && r.result.result;
  console.log(JSON.stringify(out && (out.value !== undefined ? out.value : out), null, 2));
  ws.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
