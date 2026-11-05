import { rollupProject } from './rollup.ts'
import type { UsageRecord } from './types.ts'

/**
 * DSH 会话目录名把项目路径编码成了 `--Users-ben-Documents-GitHub-DouDou--`。
 * 还原成路径再交给 rollupProject——直接拿目录名当项目名会得到一长串横杠。
 *
 * 注意这个编码是**有损的**:路径里原有的横杠也被编成分隔符,`desktop-workbench` 会还原成
 * `desktop/workbench`,归拢后变成假项目「desktop」。所以只在会话头的 cwd 缺席时才退到这里。
 */
export function decodeDir(dirName: string): string {
  const trimmed = dirName.replace(/^--/, '').replace(/--$/, '')
  return trimmed === '' ? '' : `/${trimmed.replace(/-/g, '/')}`
}

/**
 * 解析一份解压后的 DSH 会话 JSONL
 * (`~/.dsh/sessions/<编码目录>/session-<uuid>/session[.v4].jsonl[.zstd]`)。
 *
 * **两代通吃(2026-09-25,卡 U3:升到 0.1.7,会话格式 0 → 4)**:0 代与 4 代在这个解析器要读的
 * 每一个字段上形状相同,逐条对着 0.1.7-rc.2 源码核过:信封仍是 `{type,seq,time,data}`
 * (`core/session/src/types.ts` 的 `SessionEvent`);会话头仍是首行 `{"type":"session",…,"cwd":…}`
 * (4 代多了 `version:4`、`delegationDepth` 等字段,`cwd` 没动);用量仍在 `assistant/message` 的
 * `data.usage`、字段名没变(`llm/src/types.ts` 的 `TokenUsage`);模型仍在 `data.message.source.model`
 * (4 代的 source 是 `{kind:'model',provider,model}`);`request/context` 仍带 `data.model`。
 * 4 代真正变了的三样都不落在这里:文件名(见 `dshSessionFile.ts` 的 `pickLatestGeneration`)、
 * 工具结果消息的 role(`user` → `tool`,那是 `tool/result` 事件,本解析器不读)、
 * `assistant/chunk` 并进 `assistant/message.data.stream`(本解析器本来就只认 message 那条)。
 *
 * 真实形态(2026-09-15 真机取证,DSH 0.1.2-rc.1;原先按 Claude 的 `usage.input_tokens` 猜的那版
 * 和真文件一条都对不上,已整个改写):
 * - 首行 `{"type":"session","id":"session-…","cwd":"/…"}`——项目归属优先取这里的 cwd。
 * - 用量只在 `assistant/message` 事件的 `data.usage`:`inputTokens / outputTokens / cacheReadTokens /
 *   reasoningTokens / totalTokens`,驼峰。实测 `totalTokens = input + output + cacheRead`,
 *   即 inputTokens **不含**缓存读(与 Claude 同口径,不必像 Codex 那样减);reasoningTokens 已包含在
 *   outputTokens 里(290 out / 136 reasoning),不再单独加。DeepSeek 没有缓存写的概念,cache_write 恒 0。
 * - `assistant/chunk` 的 `data.chunk.usage` 是流式中间态,与随后那条 message 是同一次调用,不计。
 * - 时间是 `time`(epoch 毫秒),模型在 `data.message.source.model`;没带时退到最近一条
 *   `request/context` 的 `data.model`。
 * - collector 对本格式是「文件变长就整份重解析」,记录必须带稳定去重 key。
 *
 * **去重键以 `message.id` 为先(2026-09-25 卡 U3 改;原先只用 `seq`)**:一条会话被上游从 0 代迁到
 * 4 代时 **seq 会重排**(v1→v2 把 `assistant/chunk` 并进 message 少了行,v3→v4 的迁移阶段自己
 * 从 0 发号 —— 上游 `session-format-v3-to-v4/src/migration.ts` 的 `nextSeq`/`mapping`),
 * 于是同一条消息在两代里 seq 不同;而消息的 `id` 是「跨每一个表示层都保留的稳定身份」
 * (上游 `llm/src/message.ts` 的 `MessageBase.id`)。用 id 当键,一条会话中途被迁移时
 * **已经算过的不会再算一遍**(这就是「升级后当天数字与升级前对得上」的机制),
 * 4 代里新长出来的照常记上。取不到 id 时才退到 `v<代号>:<seq>`:带上代号是为了宁可多算也不
 * 让两代不同的消息撞成同一个键(真 DSH 两代都必带 id,这一支只兜底)。
 *
 * 没有用量记录的会话(常见:空会话)返回空数组。
 *
 * @param generation 这份文件是哪一代(0 = 老名字 `session.jsonl`,4 = `session.v4.jsonl`)。只进兜底去重键。
 */
export function parseDshSession(text: string, session: string, dirName: string, generation = 0): UsageRecord[] {
  const records: UsageRecord[] = []
  let cwd: string | undefined
  let contextModel: string | undefined

  for (const line of text.split('\n')) {
    if (line === '') continue
    let row: any
    try {
      row = JSON.parse(line)
    }
    catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue

    if (row.type === 'session') {
      if (cwd === undefined && typeof row.cwd === 'string' && row.cwd !== '') cwd = row.cwd
      continue
    }
    if (row.type === 'request/context') {
      if (typeof row.data?.model === 'string') contextModel = row.data.model
      continue
    }
    if (row.type !== 'assistant/message') continue

    const usage = row.data?.usage
    if (typeof usage !== 'object' || usage === null) continue
    if (typeof row.time !== 'number' || !Number.isFinite(row.time)) continue

    const sourceModel = row.data?.message?.source?.model
    const model = typeof sourceModel === 'string' ? sourceModel : contextModel ?? '(未知)'
    // 跨代稳定的那一个在前(见文件头「去重键以 message.id 为先」)。
    const messageId = row.data?.message?.id
    const dedupe = typeof messageId === 'string' && messageId !== ''
      ? messageId
      : `v${generation}:${typeof row.seq === 'number' ? String(row.seq) : `#${records.length}`}`

    records.push({
      ts: new Date(row.time).toISOString(),
      project: rollupProject(cwd ?? decodeDir(dirName)),
      model,
      source: 'dsh',
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cache_read: usage.cacheReadTokens ?? 0,
      cache_write: 0,
      session,
      key: `dsh:${session}:${dedupe}`,
    })
  }

  return records
}
