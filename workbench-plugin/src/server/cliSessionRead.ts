/**
 * ★ **CLI 派活会话的受信读回**(2026-10-24,卡 1a;1c continuation-source-request):
 * `task.links` 里登记的 CLI 来源(`agent` + `session_id`,如 `kimi:session_…`)此前没有 transcript
 * 读取路 —— `/sessions/transcript|digest` 只认桌面登记表与接入文件,CLI 新建会话 404。
 *
 * 三条硬边界(请求原话):
 *   ① 只按**已登记**的 agent+session_id 解析(调用方先拿 task.links 对过),不收文件路径,不扫私人会话;
 *   ② 沿用 local/paired trust 门(路由层已有),这里不再放宽;
 *   ③ Kimi 沿既有 wire 读法；Codex 沿 feed 登记与索引按精确 id 定位、复用原件分页。未知来源与缺文件如实报缺席。
 * 解析是 best-effort、有上限:wire 格式随 CLI 版本漂,认不出的行跳过,不编。
 */
import { open, realpath, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, basename, dirname } from 'node:path'

import { codexRolloutForSession } from './codexThreadIndex.ts'
import { dispatchCwdAllowed } from './agentDispatch.ts'
import type { SessionFileRef } from './sessionHistory.ts'

export interface CliTurn { k: 'ask' | 'reply', text: string, at?: string }

export interface CliReadResult { turns: CliTurn[], read_at: string }

const SESSION_ID_RE = /^[A-Za-z0-9:_-]{6,160}$/u

/** id 形状闸:不像会话 id 的一律不当路径用(双保险,调用方还有登记核验)。 */
export function safeCliSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id) && !id.includes('..') && !id.includes('/')
}

/** 在 Kimi CLI 的会话目录里按 id 找 wire.jsonl(只下探两层,找到第一个就算)。 */
export async function findKimiCliWire(home: string, id: string): Promise<string | undefined> {
  for (const root of [join(home, '.kimi-code', 'sessions'), join(home, '.kimi', 'sessions')]) {
    let groups: string[]
    try { groups = await readdir(root) } catch { continue }
    for (const group of groups) {
      const candidate = join(root, group, id, 'wire.jsonl')
      try { await readFile(candidate, 'utf8'); return candidate } catch { /* 不在这一组 */ }
    }
  }
  return undefined
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(one => (typeof one === 'object' && one !== null && typeof (one as { text?: unknown }).text === 'string' ? (one as { text: string }).text : '')).join('')
  }
  return ''
}

const KEEP_TURNS = 200

/**
 * Kimi wire.jsonl → 轮次(best-effort):认桌面 1.4(`turn.prompt` / `context.append_message`)
 * 与包裹式(`{message:{type:…}}` 里的提问/回答)。认不出的行跳过;超长截尾。
 */
export function turnsFromKimiWire(raw: string): CliTurn[] {
  const turns: CliTurn[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) as Record<string, unknown> }
    catch { continue }
    const at = (typeof row.time === 'string' && row.time) || (typeof row.timestamp === 'string' && row.timestamp) || undefined
    if (row.type === 'turn.prompt') {
      const input = row.input as { content?: unknown } | undefined
      const text = textOfContent(input?.content).trim()
      if (text !== '') turns.push({ k: 'ask', text, ...(at === undefined ? {} : { at }) })
      continue
    }
    if (row.type === 'context.append_message') {
      const message = row.message as { role?: unknown, content?: unknown } | undefined
      const text = textOfContent(message?.content).trim()
      if (text === '') continue
      if (message?.role === 'user') { turns.push({ k: 'ask', text, ...(at === undefined ? {} : { at }) }); continue }
      if (message?.role === 'assistant') {
        // 同轮 assistant 可能分多片:挨着的前一条还是 reply 就并入,否则新起一条。
        const prev = turns[turns.length - 1]
        if (prev?.k === 'reply') prev.text = prev.text === '' ? text : `${prev.text}\n${text}`
        else turns.push({ k: 'reply', text, ...(at === undefined ? {} : { at }) })
      }
      continue
    }
    const wrapped = row.message as { type?: unknown, payload?: { role?: unknown, content?: unknown } } | undefined
    if (typeof wrapped?.type === 'string' && wrapped.payload !== undefined) {
      const text = textOfContent(wrapped.payload.content).trim()
      if (text === '') continue
      if (wrapped.payload.role === 'user') turns.push({ k: 'ask', text, ...(at === undefined ? {} : { at }) })
      else if (wrapped.payload.role === 'assistant') turns.push({ k: 'reply', text, ...(at === undefined ? {} : { at }) })
    }
  }
  return turns.slice(-KEEP_TURNS)
}

/** 读一条已登记的 Kimi CLI 会话(文件缺席返回 undefined = 尚未同步)。 */
export async function readKimiCliSession(home: string, id: string): Promise<CliReadResult | undefined> {
  const file = await findKimiCliWire(home, id)
  if (file === undefined) return undefined
  const raw = await readFile(file, 'utf8')
  return { turns: turnsFromKimiWire(raw), read_at: new Date().toISOString() }
}

/** 只定位调用方已核 task.links 与权限的 Codex 来源；目录元数据不是执行状态。 */
export async function locateCodexCliSession(input: {
  codexHome: string, sessionId: string, cwds: readonly string[], registeredFile?: string,
  rolloutPathLookup?: (sessionId: string) => string | undefined,
}): Promise<SessionFileRef | undefined> {
  if (!safeCliSessionId(input.sessionId) || input.cwds.length === 0) return undefined
  const file = input.registeredFile ?? (input.rolloutPathLookup === undefined
    ? codexRolloutForSession(input.codexHome, input.sessionId) : input.rolloutPathLookup(input.sessionId))
  if (file === undefined) return undefined
  try {
    const root = await realpath(join(input.codexHome, 'sessions'))
    const actual = await realpath(file)
    const rel = relative(root, actual)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !actual.endsWith('.jsonl')) return undefined
    const handle = await open(actual, 'r')
    let first: string
    try {
      const bytes = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      first = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    } finally { await handle.close() }
    const meta = JSON.parse(first) as { type?: string, payload?: { id?: string, cwd?: string } }
    if (meta.type !== 'session_meta' || meta.payload?.id !== input.sessionId || typeof meta.payload.cwd !== 'string') return undefined
    const cwd = await realpath(meta.payload.cwd)
    const allowed = await Promise.all(input.cwds.map(path => realpath(path).catch(() => undefined)))
    if (!dispatchCwdAllowed(cwd, allowed.filter((path): path is string => path !== undefined))) return undefined
    return { agent: 'codex', session_id: input.sessionId, file: actual, format: 'codex-rollout' }
  } catch { return undefined }
}

/** Exact registered Kimi origin, checked against its own session metadata and the same task cwd gate. */
export async function locateKimiCliSession(input: {
  home: string, sessionId: string, cwds: readonly string[], registeredFile?: string,
  candidateFiles?: readonly string[],
  rememberCandidates?: (paths: readonly string[]) => void,
  /** Keep exact-id directory probes observable in the isolated cost test. */
  statFile?: (path: string) => Promise<{ isDirectory: () => boolean, isFile: () => boolean }>,
  /** Scan-only: report session directories that exist for this id (wire or not), so callers can watch their mtime. */
  rememberDirs?: (paths: readonly string[]) => void,
}): Promise<SessionFileRef | undefined> {
  if (!safeCliSessionId(input.sessionId) || input.cwds.length === 0) return undefined
  const statFile = input.statFile ?? stat
  const roots = await Promise.all(['.kimi-code', '.kimi'].map(name => realpath(join(input.home, name, 'sessions')).catch(() => undefined)))
  const candidates: string[] = []
  if (input.registeredFile !== undefined) candidates.push(input.registeredFile)
  else if (input.candidateFiles !== undefined) candidates.push(...input.candidateFiles)
  else for (const root of roots) {
    if (root === undefined) continue
    // Enumerate workspace names only; every probe is for the explicitly linked session, never another session's contents.
    for (const group of await readdir(root).catch(() => [] as string[])) for (const name of new Set([input.sessionId, input.sessionId.replace(/^session_/, '')])) {
      const sessionDir = join(root, group, name)
      // Absent exact session directories are common; one probe avoids four wire-path stats per group.
      if (!(await statFile(sessionDir).catch(() => undefined))?.isDirectory()) continue
      input.rememberDirs?.([sessionDir])
      for (const tail of ['wire.jsonl', 'agents/main/wire.jsonl']) {
        const candidate = join(root, group, name, tail)
        // Keep both exact paths: a second wire appearing in this known session directory
        // must still turn the next observation ambiguous.
        input.rememberCandidates?.([candidate])
        if ((await statFile(candidate).catch(() => undefined))?.isFile()) candidates.push(candidate)
      }
    }
  }
  const allowed = await Promise.all(input.cwds.map(cwd => realpath(cwd).catch(() => undefined)))
  const matches = new Map<string, SessionFileRef>()
  for (const file of candidates) try {
    const actual = await realpath(file)
    if (!roots.some(root => root !== undefined && !relative(root, actual).startsWith('..') && !isAbsolute(relative(root, actual)))) continue
    if (basename(actual) !== 'wire.jsonl') continue
    const sessionDir = basename(dirname(actual)) === 'main' && basename(dirname(dirname(actual))) === 'agents'
      ? dirname(dirname(dirname(actual))) : dirname(actual)
    if (![input.sessionId, input.sessionId.replace(/^session_/, '')].includes(basename(sessionDir))) continue
    for (const metaFile of [join(sessionDir, 'state.json'), join(sessionDir, 'session-meta', 'state.json')]) {
      const metaActual = await realpath(metaFile).catch(() => undefined)
      if (metaActual === undefined || relative(sessionDir, metaActual).startsWith('..')) continue
      const handle = await open(metaActual, 'r')
      let raw: string
      try { const buf = Buffer.alloc(64 * 1024 + 1); const read = await handle.read(buf, 0, buf.length, 0); if (read.bytesRead > 64 * 1024) continue; raw = buf.subarray(0, read.bytesRead).toString('utf8') } finally { await handle.close() }
      const meta = JSON.parse(raw) as { cwd?: string, workDir?: string, custom?: { cwd?: string } }
      const cwd = meta.cwd ?? meta.workDir ?? meta.custom?.cwd
      const actualCwd = typeof cwd === 'string' ? await realpath(cwd).catch(() => undefined) : undefined
      if (actualCwd !== undefined && dispatchCwdAllowed(actualCwd, allowed.filter((path): path is string => path !== undefined))) {
        matches.set(actual, { agent: 'kimi', session_id: input.sessionId, file: actual, format: 'kimi-wire' }); break
      }
    }
  } catch { /* unmatched or unavailable stays unknown */ }
  return matches.size === 1 ? [...matches.values()][0] : undefined
}

/**
 * Positive exact-id hints for repeated Codex execution snapshots, same discipline as the Kimi
 * locator: file resolution (registration / index) must land on the same path, the cwds gate input
 * must be identical, and the file's dev:ino:size:mtime must be untouched — then the previously
 * validated ref (realpath'd path inside the sessions root, project cwd already gated) is returned
 * without reopening metadata. Anything else falls back to the full validate and rebuilds the hint.
 */
export function createCodexExecutionLocator(codexHome: string, opts: {
  /** Test seam: count/observe full validations (mirrors createKimiExecutionLocator's statFile). */
  fullLocate?: (input: Parameters<typeof locateCodexCliSession>[0]) => ReturnType<typeof locateCodexCliSession>,
} = {}) {
  const fullLocate = opts.fullLocate ?? locateCodexCliSession
  const hints = new Map<string, { file: string, ref: SessionFileRef, cwdsKey: string, fileStamp: string }>()
  const limit = 32
  const fileStampOf = async (file: string): Promise<string | undefined> => {
    const info = await stat(file, { bigint: true }).catch(() => undefined)
    if (info === undefined) return undefined
    return [info.dev, info.ino, info.size, info.mtimeNs].join(':')
  }
  return {
    async prepare() {
      return async (input: Omit<Parameters<typeof locateCodexCliSession>[0], 'codexHome'>) => {
        if (!safeCliSessionId(input.sessionId) || input.cwds.length === 0) return undefined
        const file = input.registeredFile ?? (input.rolloutPathLookup === undefined
          ? codexRolloutForSession(codexHome, input.sessionId) : input.rolloutPathLookup(input.sessionId))
        if (file === undefined) return undefined
        const cwdsKey = input.cwds.join('\n')
        const hint = hints.get(input.sessionId)
        if (hint !== undefined && hint.file === file && hint.cwdsKey === cwdsKey) {
          const stamp = await fileStampOf(file)
          // 命中要拿 stat 换:追加、重建、换目标,下一拍都必须重新全量校验。
          if (stamp !== undefined && stamp === hint.fileStamp) return hint.ref
        }
        // 解析出的路径顺手传给全量校验当 registeredFile:同一路径不再走第二次 index 查询。
        const ref = await fullLocate({ codexHome, ...input, registeredFile: file })
        if (ref === undefined) {
          hints.delete(input.sessionId)
          return undefined
        }
        const stamp = await fileStampOf(ref.file)
        if (stamp !== undefined) {
          hints.delete(input.sessionId)
          hints.set(input.sessionId, { file, ref, cwdsKey, fileStamp: stamp })
          if (hints.size > limit) hints.delete(hints.keys().next().value!)
        }
        return ref
      }
    },
  }
}

/**
 * Exact-id memory for repeated execution snapshots, one generation per beat:
 *   - 拍签名 = 各会话根自身 stamp + 每组 stamp。根 mtime 不变 ⇒ 根下组清单不变,这拍连 readdir
 *     都省掉,复用上次数;组 stamp 每拍现取(成功的平 stat),组内会话目录的生灭靠它判。
 *   - 落空也记一份(候选为空):不存在的路径签名不变就不再探;目录生灭必动根或组 mtime,自然会重扫。
 *   - 校验失败的来源转「不确定」并保留记忆,每拍先复核其会话目录 stamp:目录内部长/删 wire 不必等
 *     签名变,下一拍就重扫;目录没变才复用候选再校验。门恢复即找回,不退化成每拍全扫 ——
 *     8791 第三轮要灭的就是这个(stat 失败反复重试)。刚校验成功的来源不复核目录
 *     (与旧版逐组签名同覆盖),校验当场落空时才补一次目录复核。
 * 契约不变:每拍每来源仍逐次过授权与项目门,缓存只省文件系统遍历。
 */
export function createKimiExecutionLocator(home: string, statFile: typeof stat = stat) {
  type RememberedDir = { dir: string, stamp: string }
  type Entry = { signature: string, files: readonly string[], dirs: readonly RememberedDir[], certain: boolean }
  const entries = new Map<string, Entry>()
  const limit = 32
  /** 每个根的组清单只在根 stamp 变时重读;组 stamp 不缓存,每拍现取。 */
  const listings = new Map<string, { root: string, stamp: string, groups: readonly string[] }>()
  /**
   * 登记原件路的 hint(8791 第六轮第 3 轮):与 Codex 定位器同款 —— 解析出的路径 + cwds 串 +
   * 文件 dev:ino:size:mtime stamp 都没变,就直接回上一拍校验过的 ref(落空也记负:ENOENT 的
   * 登记原件目录没变不再每拍 stat)。登记文件是追加写的,stamp 变必重校验,不丢新事件。
   */
  const registeredHints = new Map<string, { file: string, cwdsKey: string, stamp: string | undefined, ref: SessionFileRef | undefined }>()
  const stampOfFile = async (file: string): Promise<string | undefined> => {
    const info = await statFile(file, { bigint: true }).catch(() => undefined)
    return info === undefined ? undefined : [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  }
  async function locateRegistered(input: Omit<Parameters<typeof locateKimiCliSession>[0], 'home'> & { registeredFile: string }): Promise<SessionFileRef | undefined> {
    const cwdsKey = input.cwds.join('\n')
    const hint = registeredHints.get(input.sessionId)
    if (hint !== undefined && hint.file === input.registeredFile && hint.cwdsKey === cwdsKey) {
      const stamp = await stampOfFile(input.registeredFile)
      // 命中(含负缓存:文件缺席且上一拍也缺席)就免掉 realpath + 元数据那一整趟。
      if (stamp !== undefined && stamp === hint.stamp) return hint.ref
      if (stamp === undefined && hint.stamp === undefined) return undefined
    }
    const ref = await locateKimiCliSession({ ...input, home, statFile })
    if (registeredHints.size > 32) registeredHints.delete(registeredHints.keys().next().value!)
    registeredHints.set(input.sessionId, { file: input.registeredFile, cwdsKey, stamp: await stampOfFile(input.registeredFile), ref })
    return ref
  }
  async function observedSignature(): Promise<string | undefined> {
    const parts: string[] = []
    for (const name of ['.kimi-code', '.kimi']) {
      const root = await realpath(join(home, name, 'sessions')).catch(() => undefined)
      if (root === undefined) continue
      const info = await statFile(root, { bigint: true }).catch(() => undefined)
      if (info === undefined) return undefined
      const stamp = [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(':')
      let listing = listings.get(name)
      if (listing === undefined || listing.root !== root || listing.stamp !== stamp) {
        const listed = await readdir(root).catch(() => undefined)
        if (listed === undefined) return undefined
        listing = { root, stamp, groups: Object.freeze([...listed].sort()) as readonly string[] }
        listings.set(name, listing)
      }
      parts.push(listing.root, stamp)
      for (const group of listing.groups) {
        const g = await statFile(join(listing.root, group), { bigint: true }).catch(() => undefined)
        if (g === undefined) return undefined
        parts.push(group, [g.dev, g.ino, g.mtimeNs, g.ctimeNs].join(':'))
      }
    }
    return parts.join('\n')
  }
  return {
    async prepare() {
      const observed = await observedSignature()
      /** 同一拍内每个会话目录只复核一次 mtime:同拍多次定位共用。 */
      const dirStamps = new Map<string, string | undefined>()
      const stampOfDir = async (dir: string): Promise<string | undefined> => {
        if (!dirStamps.has(dir)) {
          const info = await statFile(dir, { bigint: true }).catch(() => undefined)
          dirStamps.set(dir, info === undefined ? undefined : [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(':'))
        }
        return dirStamps.get(dir)
      }
      return async (input: Omit<Parameters<typeof locateKimiCliSession>[0], 'home'>) => {
        if (!safeCliSessionId(input.sessionId) || input.cwds.length === 0) return undefined
        // 带登记原件的路不扫描(无目录生灭可记):走 hint(文件 stamp 没变直接回上一拍结论,落空也记负)。
        if (input.registeredFile !== undefined) return await locateRegistered({ ...input, registeredFile: input.registeredFile })
        // 拍签名取不到(根 stat/readdir 失败)时不读写记忆,照旧全量。
        if (observed === undefined) {
          return await locateKimiCliSession({ ...input, home, statFile })
        }
        const scanAndRemember = async (): Promise<SessionFileRef | undefined> => {
          const files: string[] = [], dirs: string[] = []
          const ref = await locateKimiCliSession({ ...input, home, statFile,
            rememberCandidates: paths => { files.push(...paths) },
            rememberDirs: paths => { for (const dir of paths) if (!dirs.includes(dir)) dirs.push(dir) } })
          const rememberedDirs: RememberedDir[] = []
          for (const dir of dirs) rememberedDirs.push({ dir, stamp: (await stampOfDir(dir)) ?? '' })
          entries.delete(input.sessionId)
          entries.set(input.sessionId, { signature: observed, files, dirs: rememberedDirs, certain: ref !== undefined })
          if (entries.size > limit) entries.delete(entries.keys().next().value!)
          return ref
        }
        const dirsFresh = async (entry: Entry): Promise<boolean> => {
          for (const one of entry.dirs) {
            if (await stampOfDir(one.dir) !== one.stamp) return false
          }
          return true
        }
        const remembered = entries.get(input.sessionId)
        if (remembered === undefined || remembered.signature !== observed) return scanAndRemember()
        // 不确定来源:先复核会话目录,变了立即重扫;没变复用候选交给逐拍校验。
        if (!remembered.certain && !(await dirsFresh(remembered))) return scanAndRemember()
        const ref = await locateKimiCliSession({ ...input, home, candidateFiles: remembered.files, statFile })
        if (ref !== undefined) {
          if (!remembered.certain) entries.set(input.sessionId, { ...remembered, certain: true })
          return ref
        }
        // 复用候选校验落空:当场复核会话目录(拍内只这一次),变了重扫,没变降级为不确定。
        if (!(await dirsFresh(remembered))) return scanAndRemember()
        entries.set(input.sessionId, { ...remembered, certain: false })
        return undefined
      }
    },
  }
}
