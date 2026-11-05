// 在手机 WebView 里求值一个只读表达式(支持 await),打印耗时。用法:node cdp-eval.mjs '<expr>' [超时秒]
const expr = process.argv[2] ?? 'document.visibilityState';
const timeout = Number(process.argv[3] ?? 30);
const pages = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = pages.find(p => p.type === 'page') ?? pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
const t0 = Date.now();
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) { console.log(`${Date.now() - t0} ms → ${JSON.stringify(m.result?.result?.value ?? m.result ?? m.error)}`); ws.close(); process.exit(0); }
};
setTimeout(() => { console.log(`${timeout} s 没回(页面可能被冻住)`); process.exit(2); }, timeout * 1000);
