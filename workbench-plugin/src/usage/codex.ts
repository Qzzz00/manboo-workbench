import { rollupProject } from './rollup.ts'
import type { UsageRecord } from './types.ts'

/**
 * 有用的行里一定出现的词:`session_meta`(cwd)、`turn_context`(模型)、`token_count`(用量)。
 * 没出现这几个词的行(工具输出、嵌着图片的消息,真机一行能有 20MB)不解析 —— 解了也是扔掉;
 * 别的行里**提到**这几个词的照常解析、照常按字段判,结果不变。collector 在字节上先筛一遍,没提到的行连解码都省了。
 */
export const CODEX_USAGE_MARKERS = ['token_count', 'turn_context', 'session_meta'] as const

/**
 * 解析一份 Codex rollout 日志(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)。
 *
 * 三件事只能在文件级别做,所以不提供按行解析:
 * 1. `cwd` 只在文件开头的 `session_meta` 出现一次,后面的 token_count 不带路径。
 * 2. 模型名在 `turn_context` 里(不是 session_meta),且每轮可能变,要一路跟着更新。
 * 3. **必须用 `last_token_usage`(本轮增量),不能用 `total_token_usage`(累计值)**——
 *    对累计值求和会把同一轮重复计入,实测会把用量放大数倍。
 * 4. **Codex 的 `input_tokens` 包含 `cached_input_tokens`**(15,416 条真实记录验证:
 *    `total_tokens = input + output` 且 `cached ≤ input` 恒成立),而 Claude 的
 *    input_tokens 不含缓存读。这里扣掉缓存部分对齐 Claude 口径——不扣的话,Codex
 *    项目在「input+output」计费口径下被放大几十倍,把工作台整个挤出排行榜。
 * 5. collector 对本格式是「文件变长就整份重解析」,记录必须带**稳定去重 key**
 *    (会话 + 文件内序号),否则活跃会话每增长一次,旧记录就被重复计入一次。
 */
export function parseCodexFile(text: string, session: string): UsageRecord[] {
  const parser = createCodexLineParser(session)
  for (const line of text.split('\n')) parser.push(line)
  return parser.records
}

/**
 * 逐行喂的版本(2026-09-11):collector 改成流式读 rollout 之后用这个——Ben 机器上有一份
 * 1.06GB 的 rollout,整份 readFile 成 string 直接撞 V8 的字符串上限("Invalid string length"),
 * 把整家 Codex 用量判成 error。状态(cwd / model / 序号)都在闭包里,语义与 parseCodexFile 一字不差。
 *
 * `take()`(2026-10-12,增量追读):把攒到现在的记录交出去并清空,**序号接着数**(去重键不回头)。
 * collector 给每个文件各留一份解析器,下一轮只喂新追加的几行 —— cwd / 模型 / 序号都还在闭包里,
 * 追加的记录照样归到文件头那个项目上。`records` 是「上次 take 之后攒的」;从不 take 就是整份(parseCodexFile)。
 */
/**
 * 解析器闭包里那点**可续跑的状态**(2026-10-28,8791 第五轮):已读偏移落盘后,
 * 重启的新实例从偏移续读,要把 cwd / 模型 / 序号 / 上一轮的累计签名接着喂进新解析器,
 * 追加的记录才照旧归到文件头那个项目、去重键不回头。
 */
export interface CodexParserState {
  cwd: string
  model: string
  seq: number
  previousTotal: string | undefined
}

export function createCodexLineParser(session: string, initial?: CodexParserState): { push: (line: string) => void, readonly records: UsageRecord[], take: () => UsageRecord[], snapshot: () => CodexParserState } {
  const records: UsageRecord[] = []
  let seq = initial?.seq ?? 0
  let cwd = initial?.cwd ?? ''
  let model = initial?.model ?? '(未知)'
  /**
   * 上一条记进来的那一轮的**累计**用量签名(2026-10-02 运营同学 Air 那一版)。
   *
   * Codex 在一轮里会写**好几条** `token_count`(真机上她那份 rollout 里成片出现):
   * 后面几条的 `last_token_usage` 与前一条一字不差,而 `total_token_usage` 也一字不差 ——
   * 那说明这几条说的是同一轮,不是又跑了一轮。`key` 那把去重尺子按**文件内序号**算,
   * 分不开它们(序号不同),于是同一轮被计了好几次,她那一格的数字虚高。
   *
   * 累计值没动过就跳过这一条:它是上一条的回声。累计值动了才是真的又烧了一轮。
   */
  let previousTotal: string | undefined = initial?.previousTotal

  function push(line: string): void {
    if (line === '') return
    // 只有这三种行有用(见 CODEX_USAGE_MARKERS)。别的行解了也是扔掉。
    if (!CODEX_USAGE_MARKERS.some(word => line.includes(word))) return
    let row: any
    try {
      row = JSON.parse(line)
    }
    catch {
      return
    }
    if (typeof row !== 'object' || row === null) return

    if (row.type === 'session_meta') {
      if (cwd === '' && typeof row.payload?.cwd === 'string') cwd = row.payload.cwd
      return
    }

    // 模型名在 turn_context 里,不在 session_meta——session_meta 只有 model_provider
    // ("openai")。真机实证:原先从 session_meta.model 取,结果 8.4B token 全落进
    // "(未知)",模型页 100% 一格等于没有。而且模型**每轮可能变**(换模型/换 effort),
    // 所以要一路跟着更新,不能只读第一条。
    if (row.type === 'turn_context') {
      if (typeof row.payload?.model === 'string') model = row.payload.model
      return
    }

    const info = row.payload?.type === 'token_count' ? row.payload.info : undefined
    const last = info?.last_token_usage
    if (typeof last !== 'object' || last === null) return
    if (typeof row.timestamp !== 'string') return

    // 同一轮的回声(见 previousTotal 那段):累计值一个字没动就不再记一遍。
    // 累计值整块缺席的旧日志走不到这一支 —— 那时候只能信序号那把尺子,行为与上一版相同。
    const cumulative = info?.total_token_usage
    if (typeof cumulative === 'object' && cumulative !== null) {
      const signature = JSON.stringify([
        cumulative.input_tokens, cumulative.cached_input_tokens,
        cumulative.output_tokens, cumulative.total_tokens,
      ])
      if (signature === previousTotal) return
      previousTotal = signature
    }

    const cached = last.cached_input_tokens ?? 0
    records.push({
      ts: row.timestamp,
      project: rollupProject(cwd),
      model,
      source: 'codex',
      input: Math.max(0, (last.input_tokens ?? 0) - cached),
      output: last.output_tokens ?? 0,
      cache_read: cached,
      cache_write: last.cache_write_input_tokens ?? 0,
      session,
      key: `codex:${session}:${seq}`,
    })
    seq += 1
  }

  return { push, records, take: () => records.splice(0), snapshot: () => ({ cwd, model, seq, previousTotal }) }
}

