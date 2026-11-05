/** Read-only, local-only DevTools CPU sample summary. Raw profiles and source contents are discarded. */
const port = Number(process.argv[2])
const seconds = Number(process.argv[3] ?? 15)
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(seconds) || seconds < 3 || seconds > 30) {
  process.stderr.write('usage: node profile-loopback-cpu.mjs <loopback-port> [seconds 3..30]\n')
  process.exit(2)
}

const categoryOf = (url) => {
  if (url.includes('/用户层/') || url.includes('/user-layer/')) return 'user_layer'
  if (url.includes('ben-dsh-workbench') && url.endsWith('/lib/index.js')) return 'workbench_bundle'
  if (url.startsWith('node:')) return 'node_builtin'
  if (url.includes('@deepseek-ai/') || url.includes('/dsh/')) return 'dsh_host'
  if (url.includes('/node_modules/')) return 'dependency'
  return url === '' ? 'v8_internal' : 'other_module'
}
const frameOf = (node) => {
  const category = categoryOf(node.callFrame.url)
  const raw = node.callFrame.functionName || '(anonymous)'
  const symbol = category === 'user_layer' || category === 'other_module' ? '[redacted]'
    : ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(raw) || /^[\w$.:<>/ -]{1,80}$/u.test(raw) ? raw : '[anonymous]'
  return { category, symbol, ...(category === 'workbench_bundle' ? { line: node.callFrame.lineNumber + 1 } : {}) }
}

function summarize(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map(), inclusive = new Map(), categories = new Map(), stacks = new Map()
  const keyOf = (frame) => JSON.stringify(frame)
  let idle = 0
  for (const sample of profile.samples ?? []) {
    const node = nodes.get(sample)
    if (node === undefined) continue
    const leaf = frameOf(node)
    if (leaf.symbol === '(idle)') idle++
    const key = keyOf(leaf)
    self.set(key, (self.get(key) ?? 0) + 1)
    categories.set(leaf.category, (categories.get(leaf.category) ?? 0) + 1)
    const stack = []
    const seenFrames = new Set()
    let at = sample
    while (at !== undefined) {
      const frame = nodes.get(at)
      if (frame === undefined) break
      const descriptor = frameOf(frame), descriptorKey = keyOf(descriptor)
      if (!seenFrames.has(descriptorKey)) inclusive.set(descriptorKey, (inclusive.get(descriptorKey) ?? 0) + 1)
      seenFrames.add(descriptorKey)
      if (stack.length < 6 && descriptor.category !== 'v8_internal') stack.push(`${descriptor.category}:${descriptor.symbol}`)
      at = parent.get(at)
    }
    if (stack.length > 0) {
      const stackKey = stack.join(' <- ')
      stacks.set(stackKey, (stacks.get(stackKey) ?? 0) + 1)
    }
  }
  const top = (counts, limit) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, samples]) => ({ ...JSON.parse(key), samples }))
  return {
    duration_ms: Math.round((profile.endTime - profile.startTime) / 1000),
    samples: profile.samples?.length ?? 0,
    idle_samples: idle,
    categories: Object.fromEntries([...categories].sort((a, b) => b[1] - a[1])),
    top_self: top(self, 25), top_inclusive: top(inclusive, 25),
    top_stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([stack, samples]) => ({ stack, samples })),
  }
}

const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined)
if (response?.ok !== true) { process.stderr.write('loopback inspector unavailable\n'); process.exit(1) }
const targets = await response.json()
const target = Array.isArray(targets) ? targets.find(one => typeof one.webSocketDebuggerUrl === 'string') : undefined
if (target === undefined) { process.stderr.write('inspector target unavailable\n'); process.exit(1) }
const address = new URL(target.webSocketDebuggerUrl)
address.hostname = '127.0.0.1'
address.port = String(port)
const socket = new WebSocket(address)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('inspector connection timeout')), 3000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('inspector connection failed')) }, { once: true })
})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', event => {
  let reply
  try { reply = JSON.parse(event.data) } catch { return }
  const item = pending.get(reply.id)
  if (item === undefined) return
  pending.delete(reply.id)
  clearTimeout(item.timer)
  if (reply.error) item.reject(new Error('inspector command failed'))
  else item.resolve(reply.result)
})
socket.addEventListener('close', () => {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('inspector disconnected')) }
  pending.clear()
})
const post = (method) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('inspector command timeout')) }, 5000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method }))
})
try {
  await post('Profiler.enable')
  await post('Profiler.start')
  await new Promise(resolve => setTimeout(resolve, seconds * 1000))
  const { profile } = await post('Profiler.stop')
  await post('Profiler.disable')
  process.stdout.write(`${JSON.stringify(summarize(profile))}\n`)
} finally { socket.close() }
