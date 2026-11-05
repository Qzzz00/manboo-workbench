/**
 * 给测试页用的十几行静态服务。没有依赖,只服务这一个目录。
 *
 * 为什么不直接 file:// 打开 index.html:
 *   1. 麦克风只给安全上下文,`http://127.0.0.1` 算,file:// 不一定;
 *   2. 8791 的 CORS 只放行回环来源,file:// 的 Origin 是字符串 "null",过不去。
 *
 * 用法:node dev/serve.mjs [端口]  然后开 http://127.0.0.1:<端口>/
 * livekit-client 的 UMD 包从 node_modules 里直接服务 —— 版本跟着 package.json 锁,不连 CDN。
 */
import { createReadStream, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const livekitUmd = join(here, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js')
const port = Number(process.argv[2] ?? 8799)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  // livekit-client 的 UMD:页面按 ./livekit-client.umd.min.js 引,这里映射到 node_modules 里那一份。
  if (path === '/livekit-client.umd.min.js') {
    if (!existsSync(livekitUmd)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('找不到 livekit-client 的 UMD 包:先在 channel-worker 里 pnpm install')
      return
    }
    res.writeHead(200, { 'content-type': TYPES['.js'] })
    createReadStream(livekitUmd).pipe(res)
    return
  }
  // 只服务本目录,`..` 一律拒绝。
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '')
  const file = join(here, rel)
  if (!file.startsWith(here) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没有这个文件')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`[channel-dev] 测试页:http://127.0.0.1:${port}/`)
})
