/**
 * 从**真机日志**里取标注,离线对照两种分流(2026-09-23)。
 *
 * ## 标注哪来的(这是整件事的关键)
 *
 * 我们有一份免费的 ground truth:`~/.dsh/workbench/logs/channel-worker.log` 里
 *
 *   `[channel-worker] 他说(ASR):…`      ← 他那一句
 *   `[channel-worker] 她调了工具:a、b`   ← 那一句之后她**真的**调了工具
 *
 * 两行一对:**下一句「他说」之前出现过「她调了工具」的,这一句就是 `act`;没有的就是 `chat`。**
 * 这不是我们猜的类别,是当时那只模型**拿着全套工具、自己决定**的结果 ——
 * 它正是分流要预测的那件事。
 *
 * 标注的两个毛病,明写在这儿,交接里也要写:
 *   ① **模型当时可能就判错了**。它该调没调(「换一桶」那句)、或者多调一件,
 *      我们的标注就跟着错。样本量二十几条的时候这一条影响不小。
 *   ② **只看「调没调工具」,不看调得对不对**。一句话里她调了 `wb_decide_item` 其实没必要,
 *      在这份标注里照样算 `act`。
 *
 * 所以这份数字是**对照用的**(两种实现同一份题),不是准确率的绝对值。
 *
 * 纯函数,不读文件 —— 读文件在 scripts/eval-turn-router.mjs 里。
 */

/** 日志里他那一句的前缀。 */
const HEARD = '他说(ASR):'
/** 日志里「她调了工具」那一行的前缀。 */
const TOOLS = '她调了工具:'

/** 一条题目。 */
export interface EvalSample {
  /** 他说的那句话。 */
  text: string
  /** 她那一回合真的调了哪几件工具(可能是空的)。 */
  tools: string[]
  /** 标注:调过工具 = `act`,没调 = `chat`。 */
  label: 'act' | 'chat'
  /** 在日志里的第几行(1 起)。查证用 —— 每一条都要能翻回原文。 */
  line: number
}

/**
 * 日志 → 题目。**按顺序配对**:一条「他说」之后、下一条「他说」之前的所有
 * 「她调了工具」都算这一条的。
 *
 * 认不出来的行一律跳过(框架 pino 那一堆、计时行、工具回话行)。
 */
export function parseEvalSamples(log: string): EvalSample[] {
  const samples: EvalSample[] = []
  const lines = log.split('\n')
  for (const [index, raw] of lines.entries()) {
    const heard = after(raw, HEARD)
    if (heard !== undefined) {
      if (heard.trim() !== '') samples.push({ text: heard.trim(), tools: [], label: 'chat', line: index + 1 })
      continue
    }
    const tools = after(raw, TOOLS)
    if (tools === undefined) continue
    const current = samples[samples.length - 1]
    // 第一条「他说」之前就调了工具(开场白那一轮)—— 没有题目可挂,丢掉。
    if (current === undefined) continue
    for (const name of tools.split(/[、,,]/).map(one => one.trim()).filter(one => one !== '')) {
      if (!current.tools.includes(name)) current.tools.push(name)
    }
    current.label = 'act'
  }
  return samples
}

/** 一行里 `prefix` 后面那一截(没有这个前缀回 undefined)。 */
function after(line: string, prefix: string): string | undefined {
  const at = line.indexOf(prefix)
  return at < 0 ? undefined : line.slice(at + prefix.length)
}

/** 一条题目判完之后的记录。 */
export interface EvalOutcome {
  sample: EvalSample
  got: 'act' | 'chat'
  reason: string
  ms: number
}

/** 一份成绩。**漏判与误判分开数** —— 它们的代价完全不一样。 */
export interface EvalScore {
  total: number
  correct: number
  /** 准确率 0–1。 */
  accuracy: number
  /** **漏判**:该办事的判成了闲聊 —— 工具被收走,她办不了那件事。**这是贵的那一种。** */
  missed: number
  /** **误判**:闲聊判成了办事 —— 白带一套工具、白垫一句「我想想」。Ben 抱怨的就是它。 */
  overCalled: number
  /** 判定耗时:总和 / 平均 / 最慢。 */
  msTotal: number
  msAvg: number
  msMax: number
}

export function scoreOutcomes(outcomes: readonly EvalOutcome[]): EvalScore {
  const total = outcomes.length
  let correct = 0
  let missed = 0
  let overCalled = 0
  let msTotal = 0
  let msMax = 0
  for (const one of outcomes) {
    if (one.got === one.sample.label) correct += 1
    else if (one.sample.label === 'act') missed += 1
    else overCalled += 1
    msTotal += one.ms
    if (one.ms > msMax) msMax = one.ms
  }
  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    missed,
    overCalled,
    msTotal,
    msAvg: total === 0 ? 0 : msTotal / total,
    msMax,
  }
}

/** 一行人话成绩。表格里那一行就是它。 */
export function formatScore(name: string, score: EvalScore): string {
  const pct = (score.accuracy * 100).toFixed(1)
  return `${name}:准确 ${score.correct}/${score.total}(${pct}%) · 漏判 ${score.missed} · 误判 ${score.overCalled}`
    + ` · 每条 ${score.msAvg.toFixed(1)}ms(最慢 ${score.msMax}ms)`
}
