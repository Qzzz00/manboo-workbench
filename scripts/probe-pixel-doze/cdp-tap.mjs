// 旁听手机 WebView 的 DevTools(只读):控制台消息 + WebSocket 帧 + 网络错误,按 Mac 时刻落到文件。
// 用法:adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>; node cdp-tap.mjs <秒> <输出文件>
const secs = Number(process.argv[2] ?? 120);
const out = process.argv[3] ?? 'cdp-tap.log';
import { appendFileSync } from 'node:fs';
const pages = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = pages.find(p => p.type === 'page') ?? pages[0];
if (!page) { console.error('没有页面'); process.exit(1); }
const line = (s) => { const l = `${(Date.now() / 1000).toFixed(3)} ${s}\n`; appendFileSync(out, l); process.stdout.write(l); };
line(`attach ${page.url}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onopen = () => {
  send('Runtime.enable'); send('Log.enable'); send('Network.enable');
  send('Runtime.evaluate', { expression: 'document.visibilityState + " hidden=" + document.hidden + " online=" + navigator.onLine' });
};
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && m.result?.result) { line(`eval ${JSON.stringify(m.result.result.value)}`); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ');
    line(`console.${m.params.type} ${args.slice(0, 300)}`); return;
  }
  if (m.method === 'Log.entryAdded') { line(`log.${m.params.entry.level} ${m.params.entry.text.slice(0, 300)}`); return; }
  if (m.method === 'Network.webSocketCreated') { line(`ws.created ${m.params.url}`); return; }
  if (m.method === 'Network.webSocketClosed') { line(`ws.closed ${m.params.requestId}`); return; }
  if (m.method === 'Network.webSocketFrameReceived') { line(`ws.recv ${String(m.params.response.payloadData).slice(0, 80)}`); return; }
  if (m.method === 'Network.webSocketFrameSent') { line(`ws.sent ${String(m.params.response.payloadData).slice(0, 80)}`); return; }
  if (m.method === 'Network.webSocketFrameError') { line(`ws.error ${m.params.errorMessage}`); return; }
  if (m.method === 'Network.loadingFailed') { line(`net.failed ${m.params.errorText}`); return; }
};
ws.onclose = () => { line('detached'); process.exit(0); };
setTimeout(() => { line('tap end'); ws.close(); }, secs * 1000);
