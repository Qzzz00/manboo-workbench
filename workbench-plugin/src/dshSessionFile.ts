/**
 * DSH 会话文件的「哪一代」与会话头(2026-09-25,卡 U3:升级到 0.1.7 / 会话格式 0 → 4)。
 *
 * **为什么要有这一层**:0.1.2-rc.1 的会话文件叫 `session.jsonl[.zstd]`,0.1.7-rc.2 改叫
 * `session.v4.jsonl[.zstd]`。上游不是启动时批量迁,而是**打开某条会话时逐文件做**,而且
 * 「迁移不移动、不覆盖、不删除任何已提交代际」—— 旧文件逐字节留在同一个目录里。
 * 于是同一个会话目录里会**同时有两代**,读的人必须自己挑:
 *
 * - 只认老名字 → 升级后新用量一条都看不见(静默归零);
 * - 两代都读 → 同一批消息被算两遍(迁移会**重排 seq**,见下面「去重键」)。
 *
 * 所以规矩是**只读数字最高的那一代**({@link pickLatestGeneration}),老的当自带备份,不碰。
 *
 * 文件名的规范形态照抄上游 `session-format/src/filename.ts` 的
 * `CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u` 加上压缩后缀:
 * 0 代没有 `vN` 段;`.v0` 、大写、前导零、临时名都**不是**已提交代际,一律不认。
 *
 * **去重键为什么不能用 seq**:v1→v2 把 `assistant/chunk` 并进 `assistant/message.data.stream`,
 * 少了行;v3→v4 的迁移阶段自己从 0 开始发号(上游 `session-format-v3-to-v4/src/migration.ts`
 * 的 `nextSeq` 与 `mapping`)。所以同一条消息在 0 代和 4 代里的 `seq` 不一样,
 * 而消息自己的 `id` 是「跨每一个表示层都保留的稳定身份」(上游 `llm/src/message.ts` 的 `MessageBase.id`)——
 * 用量记录的去重键因此改成以 `message.id` 为先(见 `usage/dsh.ts`),这样一条会话中途被迁移,
 * 已经算过的那些消息不会再算一遍,4 代里新长出来的照常记上。
 *
 * 只读纪律(沿用 09-15 那一版):不碰 `session.lock`、不以写模式打开、不存原文。
 */

/** 一份会话日志文件名解析出来的东西。 */
export interface DshSessionLogName {
  /** 会话格式代号:老名字 `session.jsonl` 是 0,`session.v4.jsonl` 是 4。 */
  version: number
  /** 带 `.zstd` 后缀(生产形态是多帧 zstd)。 */
  compressed: boolean
  /** 原文件名,原样带回。 */
  name: string
}

/**
 * 上游的规范名 + 压缩后缀。`.v0`、`session.V4.jsonl`、`session.v04.jsonl`、
 * `session.v4.jsonl.tmp` 都不匹配 —— 它们不是已提交代际。
 */
const CANONICAL_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/**
 * 一个文件名 → 它是哪一代。不是规范名(临时文件、`session.lock`、别的东西)→ undefined。
 */
export function parseSessionLogName(name: string): DshSessionLogName | undefined {
  const match = CANONICAL_LOG_NAME.exec(name)
  if (match === null) return undefined
  const raw = match[1]
  const version = raw === undefined ? 0 : Number(raw)
  if (!Number.isSafeInteger(version)) return undefined
  return { version, compressed: match[2] !== undefined, name }
}

/**
 * 一个会话目录里的文件名清单 → 该读哪一份。
 *
 * 挑**数字最高的那一代**;同一代里既有压缩又有明文时取压缩的那份(生产形态,
 * 上游按配置只写一种,两份同时在只会是手工拷出来的)。一份规范名都没有 → undefined。
 */
export function pickLatestGeneration(names: readonly string[]): DshSessionLogName | undefined {
  let best: DshSessionLogName | undefined
  for (const name of names) {
    const parsed = parseSessionLogName(name)
    if (parsed === undefined) continue
    if (best === undefined || parsed.version > best.version) { best = parsed; continue }
    if (parsed.version === best.version && parsed.compressed && !best.compressed) best = parsed
  }
  return best
}

/**
 * 会话头(每份日志的第一行)。0 代只有 `type/id/createdAt/cwd`;4 代多了 `version`、
 * 必填的 `delegationDepth`,以及**子代理那两个字段** `origin: 'subagent'` 与 `parentSession`
 * (上游 `session-persistence-jsonl/src/format.ts` 的 `HeaderLine`)。
 */
export interface DshSessionHeader {
  id?: string
  /** 头里自报的代号;0 代的头没有这个字段,记 0。 */
  version: number
  cwd?: string
  origin?: string
  parentSession?: string
  delegationDepth?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 一行 JSON → 会话头。不是 `type:'session'` 的那一行(或压根解不开)→ undefined,**绝不抛**。
 */
export function parseDshSessionHeader(line: string): DshSessionHeader | undefined {
  let row: unknown
  try {
    row = JSON.parse(line)
  }
  catch {
    return undefined
  }
  const record = asRecord(row)
  if (record === undefined || record.type !== 'session') return undefined
  const version = typeof record.version === 'number' && Number.isSafeInteger(record.version) && record.version >= 0
    ? record.version
    : 0
  const depth = record.delegationDepth
  return {
    ...(text(record.id) === undefined ? {} : { id: record.id as string }),
    version,
    ...(text(record.cwd) === undefined ? {} : { cwd: record.cwd as string }),
    ...(text(record.origin) === undefined ? {} : { origin: record.origin as string }),
    ...(text(record.parentSession) === undefined ? {} : { parentSession: record.parentSession as string }),
    ...(typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? { delegationDepth: depth } : {}),
  }
}

/**
 * 这条会话是不是**别人派出去的子代理**(2026-09-25,卡 U3 接卡 Q 的 `children`)。
 *
 * 0.1.7 里子代理就是一条普通会话,没有 `subagents/` 这种目录(那是 Claude 的做法);
 * 认它只靠会话头上那两个字段一起出现:`origin: 'subagent'` **和** `parentSession`。
 * **两个都要**:`parentSession` 自己只说明「从谁那儿分叉来的」(续接、开支线也有),
 * 不等于「是谁派出去的一项后台任务」;`origin` 才是上游给子代理的那个标记。
 */
export function dshSubagentOf(header: DshSessionHeader | undefined): { id: string, parent: string } | undefined {
  if (header === undefined || header.origin !== 'subagent') return undefined
  const parent = header.parentSession
  const id = header.id
  if (parent === undefined || parent === '' || id === undefined || id === '' || parent === id) return undefined
  return { id, parent }
}
