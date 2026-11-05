/** Run only through the isolated acceptance driver, never a daily worker. */
import { appendFileSync, readFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import childProcess from 'node:child_process'
import { instrumentSource, projectCapture } from './phoneCapture.ts'

const file = process.env.WB_FIXTURE_CAPTURE_FILE
const root = process.env.WB_FIXTURE_CAPTURE_ROOT
if (file && root && file.startsWith(root + '/')) {
  // Driver injection only: instance.ts keeps its own isolation recipe; this adds one dev import.
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function (command, args, options) {
    if (args?.includes('web') && options?.env?.HOME?.startsWith(root + '/')) {
      options = { ...options, env: { ...options.env, WB_FIXTURE_CAPTURE_FILE: file, WB_FIXTURE_CAPTURE_ROOT: root,
        NODE_OPTIONS: `--import=${fileURLToPath(import.meta.url)}` } }
    }
    return originalSpawn.call(this, command, args, options)
  }
  syncBuiltinESMExports()
  if (process.env.HOME?.startsWith(root + '/')) {
    const start = performance.now()
    let count = 0
    globalThis.__phoneCapture = (kind, raw) => {
      if (++count > 256) return
      appendFileSync(file, JSON.stringify({ pid: process.pid, ms: Math.round(performance.now() - start), kind,
        ...projectCapture(kind, raw) }) + '\n', { mode: 0o600 })
    }
    registerHooks({ load(url, context, nextLoad) {
      const got = nextLoad(url, context)
      if (url.startsWith('file:') && /\/channel-worker\/src\/(agent\.ts|asr\/volc(Protocol|Session)\.ts)$/.test(new URL(url).pathname)) {
        return { ...got, source: instrumentSource(new URL(url).pathname, String(got.source)) }
      }
      return got
    } })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      const capture = url === 'http://127.0.0.1:8893/butler/say' && typeof init?.body === 'string'
      let body
      if (capture) { body = JSON.parse(init.body); globalThis.__phoneCapture('say_request', body) }
      const response = await originalFetch(input, init)
      if (capture) {
        const raw = await response.clone().json().catch(() => ({}))
        globalThis.__phoneCapture('say_response', { ...raw, status: response.status, client_key: body.client_key })
      }
      return response
    }
  }
}
