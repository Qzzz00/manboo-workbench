/** 最小真实 UI QA 接线。需 COLLAB_UI_ROOT 指向现存桌面作者的 src/client/collab;只读使用。 */
import { createServer } from '../../../butler-app/node_modules/vite/dist/node/index.js'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const here = dirname(fileURLToPath(import.meta.url))
export async function browserQa(apiUrl: string, evidenceDir: string) {
 const ui = process.env.COLLAB_UI_ROOT
 assert.ok(ui, 'COLLAB_UI_ROOT 必须明确指定已有 UI 源码,不复制或改动对方树')
 const plugin = resolve(here, '../..'), modules = join(plugin, 'node_modules')
 const vite = await createServer({ configFile: false, root: here, server: { host: '127.0.0.1', port: 0, fs: { allow: [plugin, resolve(ui, '../../..')] }, proxy: { '/api': { target: apiUrl, rewrite: p => p.replace(/^\/api/, '') } } }, resolve: { alias: [ { find: '@qa-ui', replacement: ui }, ...['react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom', 'react'].map(name => ({ find: new RegExp(`^${name}$`), replacement: join(modules, `${name}${name === 'react' || name === 'react-dom' ? '/index.js' : '.js'}`) })) ] }, esbuild: { jsx: 'automatic' } })
 await vite.listen()
 const port = (vite.httpServer!.address() as { port: number }).port
 const profile = await mkdtemp(join(tmpdir(), 'collab-core-chrome-'))
 const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
 let socket: WebSocket | undefined
 try {
 let debugging = ''
 for (let i = 0; i < 100; i++) { try { debugging = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
 assert.ok(debugging, '独立 Chrome 未启动')
 const pages = await (await fetch(`http://127.0.0.1:${debugging.split('\n')[0]}/json/list`)).json() as any[]
 socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
 const pending = new Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>()
 const exceptions: unknown[] = []
 let seq = 0
 socket.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded') exceptions.push(m.params); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
 await new Promise<void>((ok, bad) => { socket!.onopen = () => ok(); socket!.onerror = () => bad(new Error('CDP 未连接')) })
 const send = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
 const evaluate = async (expression: string) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
 await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
 let rowId = ''
 const wait = async (expression: string) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)) } throw new Error('UI 判据超时: ' + expression + '\nDOM:' + await evaluate('document.body.innerText') + '\nExceptions:' + JSON.stringify(exceptions)) }
 return {
  async open(panel: string, ids: { goal: string, task: string, condition?: string }) {
   rowId = ids.condition ?? ''
   const url = `http://127.0.0.1:${port}/?panel=${panel}&goal=${encodeURIComponent(ids.goal)}&task=${encodeURIComponent(ids.task)}`
   await send('Page.navigate', { url }); await wait("document.querySelector('#root')?.children.length > 0 && !document.body.innerText.includes('正在读真实服务')")
  },
  async state(expected: string, label: string) {
   await wait(`Array.from(document.querySelectorAll('.ben-cl__gc-item')).some(e=>e.textContent.includes('读取真实输入生成结果') && e.getAttribute('data-state')===${JSON.stringify(expected)})`)
   const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
   await writeFile(join(evidenceDir, `ui-${label}.png`), Buffer.from(shot.data, 'base64'))
   return evaluate('document.body.innerText')
  },
  async action(label: string) {
   await evaluate(`(()=>{const row=Array.from(document.querySelectorAll('.ben-cl__gc-item')).find(e=>e.textContent.includes('读取真实输入生成结果'));const b=Array.from(row.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw new Error('找不到动作');b.click();return true})()`)
  },
  async textIncludes(text: string) { await wait(`document.body.innerText.includes(${JSON.stringify(text)})`) },
  async close() { socket?.close(); chrome.kill('SIGTERM'); await vite.close(); await new Promise<void>(r => { if (chrome.exitCode !== null) r(); else chrome.once('exit', () => r()) }); await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
 }
 } catch (error) { socket?.close(); chrome.kill('SIGTERM'); await vite.close(); throw error }
}
