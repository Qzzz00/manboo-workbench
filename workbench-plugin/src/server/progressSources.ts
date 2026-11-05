/**
 * 进度靠证据 —— **读证据那一半**(2026-09-25,卡 N)。全部只读,每一处都有上限(读多少字节、看几条会话、几份文档)。
 *
 * | 来源 | 从哪读 | 怎么认是哪个项目的 |
 * |---|---|---|
 * | 提交 | `git log --all --since`(只看提交标题) | 就在那个项目的仓库里 |
 * | 发版记录 / 决策记录 / 交接 / 设计 / 验收报告 | `git log --all --since -- docs` 找出这几天动过的,`git show <提交>:<路径>` 读那一版 | 同上 |
 * | 派出去的活交回来的话、事项的回话 | 看板(tasks.json)里卡上的 `reply` / 交付物 | 挂在那张卡上 |
 * | Codex 会话 | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` 这几天写过的:头(`session_meta.cwd`、第一句)+ 尾巴(最后几轮) | cwd 在项目目录(含 `.worktrees/`)底下;标题从 `session_index.jsonl` 按 id 查 |
 * | Claude 会话 | `~/.claude/projects/<目录>/*.jsonl` 这几天写过的:头(标题、cwd、第一句)+ 尾巴(最后几轮) | 目录名 = 项目路径换成 `-`(含 worktree);或者第一句 / 最后几轮里提到项目路径(他在别的目录开的会话) |
 * | 他说的(口述) | progress.json 里记下的 | 挂在那张卡上 |
 *
 * **只读、不存原文**:读出来的只留最后几轮、每句截短,进 progress.json 的只有核过的那一两句摘录。
 * 会话正文要授权表 `read_session_content` 是「可以」才读(progress.ts 把门)。
 *
 * **会话记录怎么读、怎么解析只有一份**:卡 P 的 `sessionDigest.ts`(`readSessionTurns` 读头尾、`turnsOf` 出原文回合,
 * 与卡片上「会话在做什么」同一套解析)。这里只挑文件、认项目、把原文回合排成证据({@link evidenceTurns})。
 * Codex 标题表同 `codexThreads.parseSessionIndex`。
 */
import type { TaskView } from '../protocol.ts'
import { CLIENT_DISPATCH_TITLES, DISPATCH_FAMILY_TITLES } from '../protocol.ts'
import type { EvidenceItem, EvidenceTurn } from './progressEvidence.ts'
import {
  clip, decisionSections, dispatchMarkerIn, dispatchMarkerOf, docSummary, evidenceTurns, isNoiseLine, isTestAsk, peopleText, pendingForHim, plainText, releaseRows, sessionEvidenceText,
} from './progressEvidence.ts'
import type { DigestFormat, SessionTurns } from './sessionDigest.ts'
import { readSessionTurns } from './sessionDigest.ts'
import { parseSessionIndex } from './codexThreads.ts'

export interface ProjectRef {
  id: string
  name: string
  /** 仓库目录。没有目录的项目只能靠看板上的证据。 */
  path?: string
}

export interface SourceDeps {
  /** 只读的 git:`git -C <repo> <args>` 的标准输出;失败回 undefined(不抛)。 */
  git: (repo: string, args: readonly string[]) => Promise<string | undefined>
  readDir: (dir: string) => Promise<string[]>
  stat: (path: string) => Promise<{ mtimeMs: number, size: number, dir: boolean } | undefined>
  /**
   * 读一条会话记录的原文回合(头尾各一段、有上限)。生产里就是卡 P 的 `readSessionTurns` —— 会话读法全仓一份;
   * 测试注入一个从内存里的记录走同一个 `turnsOf` 的假件。读不到回 undefined。
   */
  readTurns: (ref: { format: DigestFormat, file: string, name?: string }, options: { tailBytes: number }) => Promise<SessionTurns | undefined>
  readFile: (path: string) => Promise<string | undefined>
}

/** 每一类最多拿几条(一轮评估的读盘量有上限)。 */
export const SOURCE_LIMITS = {
  commits: 160,
  docs: 24,
  codexSessions: 14,
  claudeSessions: 12,
  /** 会话尾巴先读多少;不够两轮再放大一次。(头上读多少归卡 P 的读法:256KB 起,找不到第一句往上长到 4MB。) */
  tailBytes: 1_000_000,
  tailBytesMax: 4_000_000,
  docBytes: 12_000,
} as const

function isoLocalDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function within(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

/** 会话 / 文件属于哪个项目:目录在它底下(含 `.worktrees/…`、`.claude/worktrees/…`)。 */
export function projectOfPath(path: string | undefined, projects: readonly ProjectRef[]): ProjectRef | undefined {
  if (path === undefined) return undefined
  let best: ProjectRef | undefined
  for (const project of projects) {
    if (project.path === undefined || !within(path, project.path)) continue
    if (best === undefined || (project.path.length > (best.path?.length ?? 0))) best = project
  }
  return best
}

// ———————————————————————————— 仓库 ————————————————————————————

/** 文档的种类 → 出处前缀。只认这几类(别的 docs 改动不当进度证据)。 */
function docKindOf(path: string): { kind: EvidenceItem['kind'], label: string, doc?: EvidenceItem['doc'] } | undefined {
  const name = path.split('/').pop() ?? path
  if (!name.endsWith('.md')) return undefined
  // 出处是给人看的(2026-09-25 维护者:「从常规用户的第一次使用角度」):不说「交接」「发版记录」这些开发的词。
  if (name === '发版记录.md') return { kind: 'release', label: '更新说明' }
  if (name === '决策记录.md') return { kind: 'decision', label: '项目里记下的决定' }
  if (/^交接-/.test(name)) return { kind: 'handoff', label: '工作记录', doc: 'handoff' }
  if (/^设计-/.test(name)) return { kind: 'handoff', label: '设计稿', doc: 'design' }
  if (/^验收报告-/.test(name)) return { kind: 'handoff', label: '验收记录', doc: 'acceptance' }
  return undefined
}

/** 还没合进主线的活,出处后面写这一句(人话;不说「main」「分支」)。 */
const NOT_ON_MAIN = '(还没并进正式版)'

/**
 * 一个项目的仓库这几天发生了什么:提交标题一条一条、动过的文档一份一份(发版记录拆成一版一条、决策记录一节一条)。
 * 读的都是**提交过的那一版**(`git show`),不看他没提交的改动,也不管主目录此刻切在哪个分支。
 */
export async function repoEvidence(project: ProjectRef, since: Date, now: Date, deps: SourceDeps): Promise<EvidenceItem[]> {
  if (project.path === undefined) return []
  const repo = project.path
  const sinceIso = since.toISOString()
  const out: EvidenceItem[] = []

  const log = await deps.git(repo, ['log', '--all', '--no-merges', `--since=${sinceIso}`, `-n`, String(SOURCE_LIMITS.commits), '--format=%H%x1f%cI%x1f%D%x1f%s'])
  // 主线上的那几条(合进 main 才算数;远端那一份为准,没有远端就本地 main)。
  const mainRef = (await deps.git(repo, ['rev-parse', '--verify', '-q', 'origin/main'])) !== undefined ? 'origin/main' : 'main'
  const onMain = new Set((await deps.git(repo, ['log', mainRef, `--since=${sinceIso}`, '-n', String(SOURCE_LIMITS.commits), '--format=%H']) ?? '')
    .split('\n').map(one => one.trim()).filter(one => one !== ''))
  for (const line of (log ?? '').split('\n')) {
    const [sha, at, , subject] = line.split('\x1f')
    if (sha === undefined || sha.length < 7 || subject === undefined || subject.trim() === '') continue
    // 还没合进主线的标出来(真看板副本上撞到过:一条分支上「会话读法全仓一份」的提交被当成「会话读取」那张卡的进展)——
    // 分支上的活是真进展,但得让判的人看得出「还没并进正式版」。
    const onMainLine = onMain.has(sha)
    out.push({
      id: `commit:${sha.slice(0, 8)}`,
      kind: 'commit',
      // 给人看的出处不带提交号、分支名(统筹:「界面上不许出现提交号」);提交号留在 ref 里给查的人用。
      source: `项目里的一次改动${onMain.size > 0 && !onMainLine ? NOT_ON_MAIN : ''}`,
      ref: sha.slice(0, 12),
      ...(at === undefined || at === '' ? {} : { at }),
      title: clip(subject.trim(), 120),
      text: clip(subject.trim(), 200),
      project: project.id,
      ...(onMain.has(sha) ? { main: true } : {}),
      ...(onMain.size > 0 && !onMainLine ? { unmerged: true as const } : {}),
    })
  }

  // 这几天动过的文档:每份只取最新那一次提交。
  const docLog = await deps.git(repo, ['-c', 'core.quotePath=false', 'log', '--all', `--since=${sinceIso}`, '--name-only', '--format=%x1e%H%x1f%cI', '--', 'docs'])
  const latest = new Map<string, { sha: string, at: string }>()
  for (const block of (docLog ?? '').split('\x1e')) {
    const lines = block.split('\n').filter(one => one.trim() !== '')
    const head = lines.shift()
    if (head === undefined) continue
    const [sha, at] = head.split('\x1f')
    if (sha === undefined || at === undefined) continue
    for (const path of lines) {
      if (docKindOf(path) === undefined || latest.has(path)) continue
      latest.set(path, { sha, at })
    }
  }
  const docs = [...latest.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, SOURCE_LIMITS.docs)
  for (const [path, { sha, at }] of docs) {
    const kind = docKindOf(path) as { kind: EvidenceItem['kind'], label: string, doc?: EvidenceItem['doc'] }
    const content = await deps.git(repo, ['show', `${sha}:${path}`])
    if (content === undefined) continue
    const text = content.slice(0, kind.kind === 'release' || kind.kind === 'decision' ? content.length : SOURCE_LIMITS.docBytes)
    if (kind.kind === 'release') {
      const floor = isoLocalDate(since)
      for (const row of releaseRows(text, now)) {
        if (row.date < floor) continue
        out.push({
          id: `release:${row.version}`,
          kind: 'release',
          source: `更新说明 ${row.version}`,
          ref: `${path}#${row.version}`,
          at: row.date,
          title: `${row.version} · ${row.date.slice(5)}`,
          text: clip(row.text, 420),
          project: project.id,
        })
      }
      continue
    }
    if (kind.kind === 'decision') {
      const floor = isoLocalDate(since)
      for (const section of decisionSections(text)) {
        if (section.date < floor) continue
        out.push({
          id: `decision:${section.date}:${section.heading.slice(0, 24)}`,
          kind: 'decision',
          source: '项目里记下的决定',
          ref: `${path}#${section.date}`,
          at: section.date,
          title: section.heading,
          text: section.text,
          project: project.id,
        })
      }
      continue
    }
    const summary = docSummary(text)
    if (summary.title === '' && summary.text === '') continue
    const shown = clip(peopleText(summary.title.replace(/^(?:交接|设计|验收报告)[\s·]*(?:\d{4}-\d{2}-\d{2}|\d{4})?[\s·::\uFF1A]*/, '')), 22)
    out.push({
      id: `doc:${path}`,
      kind: 'handoff',
      ...(kind.doc === undefined ? {} : { doc: kind.doc }),
      source: `${kind.label}${shown === '' ? '' : `「${shown}」`}${onMain.size > 0 && !onMain.has(sha) ? NOT_ON_MAIN : ''}`,
      ref: path,
      at,
      title: summary.title,
      text: summary.text,
      project: project.id,
      ...(onMain.size > 0 && !onMain.has(sha) ? { unmerged: true as const } : {}),
    })
  }
  return out
}

// ———————————————————————————— 看板上的回话、他说的 ————————————————————————————

/** 测试时留下的事项(「[派活测试]…」「[测试·…]」)不当证据。 */
export function isTestItem(task: Pick<TaskView, 'title'>): boolean {
  return /^\s*\[(?:派活测试|测试)/.test(task.title)
}

/** 卡上那段交回来的话(派出去的活的回答 / 事务官那一轮的回话)。 */
function replyOf(task: TaskView): string | undefined {
  const dispatched = task.client_dispatch?.reply ?? task.dispatch?.reply
  if (dispatched !== undefined && dispatched.trim() !== '') return dispatched
  const reply = [...(task.deliverables ?? [])].reverse().find(one => one.kind === 'reply')?.ref
  return reply === undefined || reply.trim() === '' ? undefined : reply
}

/**
 * 看板本身也是证据:派出去的活交回来的话挂在它自己那张卡上(直连),也能被别的卡按字面认到
 * (「验证自我迭代能力」那张 ← 事务官自修一个显示问题那件的回话)。取消掉的、测试留下的不算。
 */
export function boardEvidence(tasks: readonly TaskView[]): EvidenceItem[] {
  const out: EvidenceItem[] = []
  for (const task of tasks) {
    if (task.status === 'canceled' || isTestItem(task)) continue
    const reply = replyOf(task)
    if (reply === undefined) continue
    const family = task.client_dispatch?.family ?? task.dispatch?.family
    const who = family === undefined ? '事务官' : (CLIENT_DISPATCH_TITLES as Record<string, string>)[family] ?? DISPATCH_FAMILY_TITLES[family]
    out.push({
      id: `${family === undefined ? 'item' : 'dispatch'}:${task.id}`,
      kind: family === undefined ? 'item' : 'dispatch',
      source: family === undefined ? `事务官那一件「${clip(peopleText(task.title), 14)}」的回话` : `${who} 交回来的话`,
      ref: task.id,
      at: task.updated_at,
      title: task.title,
      text: `${family === undefined ? `他交代:「${clip(plainText(task.desc ?? task.title), 120)}」\n事务官答:` : `${who} 答:`}「${clip(plainText(reply.split('\n').filter(line => !isNoiseLine(line)).join('\n')).replace(/^Show more/, ''), 600)}」`,
      taskIds: [task.id],
      lastBy: 'agent',
      ...(task.project_id === undefined ? {} : { project: task.project_id }),
    })
  }
  return out
}

export interface SaidEntry { text: string, at: string }

/** 他说的(「要你说一句」那一问的回答、卡上那个输入框)。直连那张卡。 */
export function saidEvidence(said: Readonly<Record<string, readonly SaidEntry[]>>): EvidenceItem[] {
  const out: EvidenceItem[] = []
  for (const [taskId, entries] of Object.entries(said)) {
    const last = entries[entries.length - 1]
    if (last === undefined) continue
    out.push({
      id: `said:${taskId}:${last.at}`,
      kind: 'said',
      source: '你说的',
      ref: taskId,
      at: last.at,
      text: `他说:「${clip(last.text, 300)}」`,
      taskIds: [taskId],
      lastBy: 'him',
    })
  }
  return out
}

// ———————————————————————————— 会话 ————————————————————————————

/** 一条会话文件读过的样子(按路径 + 大小缓存:没长就不再读)。 */
export interface SessionRead {
  size: number
  turns: EvidenceTurn[]
  cwd?: string
  id?: string
  title?: string
  /** 第一句里的派活记号(「工作台派活 371c3b】」),认得出这条会话是哪张卡派出去的。 */
  marker?: string
  /** 不当证据:子任务、测试时留下的。 */
  skip?: boolean
  /** 他的第一句(认项目用:他在别的目录开的会话,第一句里常写着要改哪个仓库)。 */
  opening?: string
}

export type SessionCache = Map<string, SessionRead>

/**
 * 会话证据缓存最多留几条(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * 这张表按会话文件路径存**整条会话的回合文字**(`turns`),从前只进不出:一条会话出了 14 天的窗口,
 * 它那份文字还在表里;进程跑几天,表里就是这几天扫过的每一条会话。
 * 每一轮两家各最多读 {@link SOURCE_LIMITS.codexSessions} / {@link SOURCE_LIMITS.claudeSessions} 条,
 * 留 60 条已是四倍余量;超了按**这一轮没碰到的、最早进表的**先丢。
 */
export const SESSION_CACHE_MAX = 60

/**
 * 收一次会话证据缓存:`touched` 是这一轮扫到的路径(它们一条不丢);别的按进表顺序(Map 的插入序)从最老的丢,
 * 收到 `max` 条以内。回丢了几条(用例看)。
 */
export function pruneSessionCache(cache: SessionCache, touched: ReadonlySet<string>, max = SESSION_CACHE_MAX): number {
  if (cache.size <= max) return 0
  let dropped = 0
  for (const key of [...cache.keys()]) {
    if (cache.size <= max) break
    if (touched.has(key)) continue
    cache.delete(key)
    dropped += 1
  }
  return dropped
}

function twoSided(turns: readonly EvidenceTurn[]): boolean {
  return turns.some(turn => turn.role === 'him') && turns.some(turn => turn.role === 'agent')
}

/**
 * 读一条会话(卡 P 的读法):尾巴先读 1MB,排出来不够一来一回(他一句 + 那家一句)再放大到 4MB。
 * 回卡 P 的原文回合(头上那几样:cwd、是不是子任务、第一句、标题)+ 排好的证据回合。
 */
async function readSession(deps: SourceDeps, ref: { format: DigestFormat, file: string, name?: string }, size: number): Promise<{ raw: SessionTurns, turns: EvidenceTurn[] } | undefined> {
  let raw = await deps.readTurns(ref, { tailBytes: SOURCE_LIMITS.tailBytes })
  if (raw === undefined) return undefined
  let turns = evidenceTurns(raw.turns)
  if (!twoSided(turns) && size > SOURCE_LIMITS.tailBytes) {
    const wider = await deps.readTurns(ref, { tailBytes: SOURCE_LIMITS.tailBytesMax })
    if (wider !== undefined) { raw = wider; turns = evidenceTurns(wider.turns) }
  }
  return { raw, turns }
}

/** `session_index.jsonl` → id → 标题(同一个 id 取最后一行:改过名的以新名为准)。解析同 `codexThreads.parseSessionIndex`。 */
export function codexTitles(indexText: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of parseSessionIndex(indexText ?? '')) out.set(row.id, row.title)
  return out
}

/** rollout 文件名里的会话 id(`rollout-2026-09-23T13-51-08-<uuid>.jsonl`)。 */
function codexIdOfFile(path: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1]
}

/** 派活记号(「工作台派活 371c3b」)→ 卡 id。 */
function taskOfMarker(marker: string | undefined, taskIds: readonly string[]): string | undefined {
  if (marker === undefined) return undefined
  return taskIds.find(id => id.replace(/^t-/, '').replace(/[^0-9a-zA-Z]/g, '').startsWith(marker))
}

/**
 * Codex 这几天写过的会话(属于某个项目的)→ 一条会话一条证据:「他说:… / Codex 答:…」(最后几轮)。
 * 派活记号认得出的,直连那张卡。
 */
export async function codexEvidence(input: {
  codexHome: string
  projects: readonly ProjectRef[]
  since: Date
  now: Date
  taskIds: readonly string[]
  deps: SourceDeps
  cache: SessionCache
  /** 这一轮碰到的会话文件路径(调用方据此收缓存);不传就不记。 */
  touched?: Set<string>
}): Promise<EvidenceItem[]> {
  const { codexHome, deps, cache } = input
  const titles = codexTitles(await deps.readFile(`${codexHome}/session_index.jsonl`))
  const files: { path: string, mtimeMs: number, size: number }[] = []
  // 会话按**开始那天**放目录;一条 09-23 开的会话今天还在写 —— 所以往回看两周的目录,按文件最后写入时刻挑。
  for (let back = 0; back < 14; back += 1) {
    const day = new Date(input.now.getTime() - back * 86_400_000)
    const dir = `${codexHome}/sessions/${day.getFullYear()}/${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`
    let names: string[]
    try { names = await deps.readDir(dir) }
    catch { continue }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const path = `${dir}/${name}`
      const info = await deps.stat(path)
      if (info === undefined || info.dir || info.mtimeMs < input.since.getTime()) continue
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: EvidenceItem[] = []
  for (const file of files) {
    if (out.length >= SOURCE_LIMITS.codexSessions) break
    input.touched?.add(file.path)
    let read = cache.get(file.path)
    if (read === undefined || read.size !== file.size) {
      const fileId = codexIdOfFile(file.path)
      const name = fileId === undefined ? undefined : titles.get(fileId)
      const got = await readSession(deps, { format: 'codex-rollout', file: file.path, ...(name === undefined ? {} : { name }) }, file.size)
      const project = projectOfPath(got?.raw.cwd, input.projects)
      if (got === undefined || project === undefined || got.raw.subagent === true || isTestAsk(got.raw.first_ask)) {
        cache.set(file.path, { size: file.size, turns: [], skip: true, ...(got?.raw.cwd === undefined ? {} : { cwd: got.raw.cwd }) })
        continue
      }
      // 派活记号在他的第一句里 —— 那一句在文件头(大文件的尾巴里读不到),卡 P 的读法单给了 first_ask。
      const marker = dispatchMarkerIn(got.raw.first_ask)
      read = {
        size: file.size,
        turns: got.turns,
        ...(got.raw.cwd === undefined ? {} : { cwd: got.raw.cwd }),
        ...(got.raw.session_id === undefined ? {} : { id: got.raw.session_id }),
        ...(got.raw.title === undefined ? {} : { title: got.raw.title }),
        ...(marker === undefined ? {} : { marker }),
      }
      cache.set(file.path, read)
    }
    const project = projectOfPath(read.cwd, input.projects)
    if (project === undefined || read.skip === true || read.turns.length === 0) continue
    const id = read.id ?? codexIdOfFile(file.path) ?? file.path
    const title = titles.get(id) ?? read.title ?? clip(read.turns.find(turn => turn.role === 'him')?.text ?? '', 30)
    const body = sessionEvidenceText(read.turns, 'Codex')
    // 文件这几天被碰过、最后一轮却是很久以前的(App 重存了一下),不算这几天的进展。
    if (body.text === '' || (body.at !== undefined && body.at < input.since.toISOString())) continue
    const marked = taskOfMarker(read.marker ?? dispatchMarkerOf(read.turns), input.taskIds)
    const pending = pendingForHim(read.turns)
    out.push({
      id: `session:codex:${id}`,
      kind: 'session',
      source: `Codex 里「${clip(peopleText(title), 16)}」那段对话`,
      ref: file.path,
      at: body.at ?? new Date(file.mtimeMs).toISOString(),
      title,
      text: body.text,
      ...(pending === undefined ? {} : { pending }),
      ...(marked === undefined ? {} : { taskIds: [marked] }),
      ...(body.lastBy === undefined ? {} : { lastBy: body.lastBy }),
      project: project.id,
    })
  }
  return out
}

/** Claude 把 cwd 写成目录名的办法:`/` 与 `.` 都换成 `-`。 */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[/.]/g, '-')
}

/**
 * Claude 这几天写过的会话 → 一条会话一条证据。认项目两条路:
 * ① 目录名是项目路径换过来的(含 `--claude-worktrees-…`);② 他在别处开的会话(比如统筹在一个空目录里指挥这个仓库),
 * 最后几轮里提到了项目路径或仓库目录名。
 */
export async function claudeEvidence(input: {
  claudeHome: string
  projects: readonly ProjectRef[]
  since: Date
  deps: SourceDeps
  cache: SessionCache
  /** 同 codexEvidence:这一轮碰到的会话文件路径。 */
  touched?: Set<string>
}): Promise<EvidenceItem[]> {
  const { claudeHome, deps, cache } = input
  const root = `${claudeHome}/projects`
  let dirs: string[]
  try { dirs = await deps.readDir(root) }
  catch { return [] }
  const files: { path: string, dir: string, mtimeMs: number, size: number }[] = []
  for (const dir of dirs) {
    let names: string[]
    try { names = await deps.readDir(`${root}/${dir}`) }
    catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = `${root}/${dir}/${name}`
      const info = await deps.stat(path)
      if (info === undefined || info.dir || info.mtimeMs < input.since.getTime()) continue
      files.push({ path, dir, mtimeMs: info.mtimeMs, size: info.size })
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: EvidenceItem[] = []
  for (const file of files) {
    if (out.length >= SOURCE_LIMITS.claudeSessions) break
    input.touched?.add(file.path)
    let read = cache.get(file.path)
    if (read === undefined || read.size !== file.size) {
      const got = await readSession(deps, { format: 'claude-transcript', file: file.path }, file.size)
      if (got === undefined) {
        cache.set(file.path, { size: file.size, turns: [], skip: true })
        continue
      }
      const opening = got.raw.first_ask === undefined ? '' : clip(plainText(got.raw.first_ask), 600)
      read = {
        size: file.size,
        turns: got.turns,
        ...(opening === '' ? {} : { opening }),
        // 子任务(sidechain)那种会话不是他在跟它说话;测试时留下的不当证据。
        ...(got.raw.subagent === true || isTestAsk(got.raw.first_ask) ? { skip: true } : {}),
        ...(got.raw.cwd === undefined ? {} : { cwd: got.raw.cwd }),
        ...(got.raw.session_id === undefined ? {} : { id: got.raw.session_id }),
        ...(got.raw.title === undefined ? {} : { title: got.raw.title }),
      }
      cache.set(file.path, read)
    }
    if (read.turns.length === 0 || read.skip === true) continue
    const byDir = input.projects.find(project => project.path !== undefined && file.dir.startsWith(claudeProjectDirName(project.path)))
    const byCwd = projectOfPath(read.cwd, input.projects)
    // 他在别处开的会话:最后几轮里写着这个项目的路径才算(只写仓库名太容易撞 —— 「Echo」也是一条命令)。
    const said = [read.opening ?? '', ...read.turns.map(turn => turn.text)].join('\n')
    const byText = input.projects.find(project => project.path !== undefined && said.includes(project.path))
    const project = byDir ?? byCwd ?? byText
    if (project === undefined) continue
    const id = read.id ?? file.path.split('/').pop()?.replace(/\.jsonl$/, '') ?? file.path
    const title = read.title ?? clip(read.turns.find(turn => turn.role === 'him')?.text ?? '', 30)
    const body = sessionEvidenceText(read.turns, 'Claude')
    if (body.text === '' || (body.at !== undefined && body.at < input.since.toISOString())) continue
    const pending = pendingForHim(read.turns)
    out.push({
      id: `session:claude:${id}`,
      kind: 'session',
      source: `Claude 里「${clip(peopleText(title), 16)}」那段对话`,
      ref: file.path,
      at: body.at ?? new Date(file.mtimeMs).toISOString(),
      title,
      text: body.text,
      ...(pending === undefined ? {} : { pending }),
      ...(body.lastBy === undefined ? {} : { lastBy: body.lastBy }),
      project: project.id,
    })
  }
  return out
}

// ———————————————————————————— 生产用的读法(只读、有界) ————————————————————————————

/** 生产 deps:git 走 `execFile`(`taskpolicy -c utility` 低优先级,不挤通话);会话读头尾走卡 P 的 `readSessionTurns`。 */
export async function defaultSourceDeps(): Promise<SourceDeps> {
  const { execFile } = await import('node:child_process')
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const runGit = (repo: string, args: readonly string[]): Promise<string | undefined> => new Promise((resolve) => {
    const bin = process.platform === 'darwin' ? '/usr/sbin/taskpolicy' : 'git'
    const argv = process.platform === 'darwin' ? ['-c', 'utility', 'git', '-C', repo, ...args] : ['-C', repo, ...args]
    execFile(bin, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => {
      resolve(error === null ? String(stdout) : undefined)
    })
  })
  return {
    git: runGit,
    readDir: dir => readdir(dir),
    stat: async (path) => {
      try {
        const info = await stat(path)
        return { mtimeMs: info.mtimeMs, size: info.size, dir: info.isDirectory() }
      }
      catch { return undefined }
    },
    // 会话读法全仓一份:卡 P 的 readSessionTurns(头 256KB 起、找不到第一句往上长,尾巴按这边给的字节数)。
    readTurns: (ref, options) => readSessionTurns(ref, { tailBytes: options.tailBytes }),
    readFile: async (path) => { try { return await readFile(path, 'utf8') } catch { return undefined } },
  }
}
