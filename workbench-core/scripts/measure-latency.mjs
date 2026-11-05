#!/usr/bin/env node
/**
 * 量「经座机服务」比「直连插件」多花多少:交替各打 N 次 GET /state,报中位数与 p95,并核两边回包的键一致。
 * 只发 GET /state(只读,和手机 3 秒一拍是同一个请求),不碰任何写接口。
 *
 *   node scripts/measure-latency.mjs [直连地址] [经 core 地址] [次数]
 *   node scripts/measure-latency.mjs http://127.0.0.1:8791 http://127.0.0.1:8793 60
 */
import { Agent, request } from 'node:http'

const [direct = 'http://127.0.0.1:8791', via = 'http://127.0.0.1:8793', countRaw = '60'] = process.argv.slice(2)
const count = Number(countRaw)
const agent = new Agent({ keepAlive: true })

function get(base) {
  const url = new URL('/state', base)
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    request({ host: url.hostname, port: url.port, path: url.pathname, agent }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const a = []; const b = []; let keysMatch = true; let bytes = 0
await get(direct); await get(via) // 预热 keep-alive
for (let i = 0; i < count; i++) {
  const [x, y] = i % 2 === 0 ? [await get(direct), await get(via)] : [null, null]
  const [y2, x2] = i % 2 === 1 ? [await get(via), await get(direct)] : [y, x]
  a.push(x2.ms); b.push(y2.ms); bytes = x2.body.length
  if (x2.status !== 200 || y2.status !== 200) keysMatch = false
  else {
    const kx = Object.keys(JSON.parse(x2.body.toString())).sort().join()
    const ky = Object.keys(JSON.parse(y2.body.toString())).sort().join()
    if (kx !== ky) keysMatch = false
  }
}
const row = (name, xs) => `${name.padEnd(8)} 中位 ${pct(xs, 0.5).toFixed(1)} ms   p95 ${pct(xs, 0.95).toFixed(1)} ms`
console.log(`GET /state × ${count}(交替,keep-alive),回包约 ${(bytes / 1024).toFixed(0)} KB`)
console.log(row('直连', a))
console.log(row('经 core', b))
const diffs = a.map((v, i) => b[i] - v)
console.log(`逐对差值 中位 ${pct(diffs, 0.5).toFixed(1)} ms   p95 ${pct(diffs, 0.95).toFixed(1)} ms`)
console.log(`两边回包顶层键一致:${keysMatch ? '是' : '否'}`)
agent.destroy()
