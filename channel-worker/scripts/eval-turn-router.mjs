/**
 * 离线对照:两种回合分流,同一份真机题目(2026-09-23)。
 *
 * 题目从**真机日志**里来,标注是当时那只模型自己的行为(「她调了工具」那一行)——
 * 怎么配对、这份标注有哪两个毛病,全写在 src/evalLog.ts 的头注释里,**先读那一段再看数**。
 *
 * 用法:
 *
 *   node scripts/eval-turn-router.mjs [日志路径]
 *   node scripts/eval-turn-router.mjs ~/.dsh/workbench/logs/channel-worker.log --verbose
 *
 * 日志路径不给就用 `~/.dsh/workbench/logs/channel-worker.log`。**只读**,一个字都不写回去。
 *
 * 跑哪几列:
 *   · 规则法(兜底 act)—— 线上缺省的那一件;
 *   · 规则法(兜底 chat)—— 同一张表、只换「一个词都没命中时落哪边」,给 Ben 做取舍的对照;
 *   · Jev —— **只有环境里有 `JEV_API_KEY` 时才跑**;没有就在那一列写「没跑(无 key)」,
 *     绝不拿别处的数、更不编一个。
 *
 * 成本:规则法 0。Jev 按 $0.042/百万输入 token 估(官方价,输出免费),
 * token 用中文 1 字 ≈ 1 token 保守估 —— **是估的,不是账单**。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { formatScore, parseEvalSamples, scoreOutcomes } from '../src/evalLog.ts'
import { RulesTurnRouter, createTurnRouter } from '../src/turnRoute.ts'
import { estimateCostUsd } from '../src/jevRouter.ts'

const DEFAULT_LOG = resolve(homedir(), '.dsh/workbench/logs/channel-worker.log')

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const logPath = resolve(args.find(one => !one.startsWith('--')) ?? DEFAULT_LOG)

let log
try { log = readFileSync(logPath, 'utf8') }
catch (err) {
  console.error(`读不了日志 ${logPath}:${err?.message ?? '没说原因'}`)
  process.exit(1)
}

const samples = parseEvalSamples(log)
if (samples.length === 0) {
  console.error(`${logPath} 里一条「他说(ASR)」都没有 —— 这份日志里没有题目可判。`)
  process.exit(1)
}

const acts = samples.filter(one => one.label === 'act').length
console.log(`题目:${samples.length} 条(来自 ${logPath})`)
console.log(`标注:要办事 ${acts} 条 / 闲聊 ${samples.length - acts} 条(标注 = 当时她真调了工具没有)`)
console.log('')

/** 跑一件实现,回 { outcomes, score }。**一条一条按顺序跑** —— 规则法的「承接」要的就是顺序。 */
async function run(router) {
  const outcomes = []
  for (const sample of samples) {
    const began = process.hrtime.bigint()
    const decision = await router.route(sample.text)
    const ms = Number(process.hrtime.bigint() - began) / 1e6
    outcomes.push({ sample, got: decision.route, reason: decision.reason, ms: Math.max(ms, decision.ms) })
  }
  return { outcomes, score: scoreOutcomes(outcomes) }
}

const columns = []

const rulesAct = await run(new RulesTurnRouter({ fallback: 'act' }))
columns.push(['规则法(兜底 act,线上缺省)', rulesAct, 0])

const rulesChat = await run(new RulesTurnRouter({ fallback: 'chat' }))
columns.push(['规则法(兜底 chat,对照)', rulesChat, 0])

const jevKey = process.env.JEV_API_KEY?.trim()
let jev
if (jevKey === undefined || jevKey === '') {
  console.log('Jev:没跑(无 key)。要跑:JEV_API_KEY=… WORKBENCH_CHANNEL_TURN_ROUTER=jev node scripts/eval-turn-router.mjs')
  console.log('     ——**注意**:跑它会把日志里他说过的每一句发到第三方(api.typesafe.ai)。要 Ben 先点头。')
  console.log('')
}
else {
  const router = await createTurnRouter({ env: { ...process.env, WORKBENCH_CHANNEL_TURN_ROUTER: 'jev' }, log: line => console.log(line) })
  if (router.name !== 'jev') console.log('Jev:没跑(装不上,见上一行)')
  else {
    jev = await run(router)
    const cost = samples.reduce((sum, one) => sum + estimateCostUsd(one.text), 0)
    columns.push(['Jev(云端)', jev, cost])
  }
}

console.log('| 实现 | 准确率 | 漏判(该办事判成闲聊) | 误判(闲聊判成办事) | 每条耗时 | 最慢 | 这一份的成本 |')
console.log('|---|---|---|---|---|---|---|')
for (const [name, result, cost] of columns) {
  const s = result.score
  console.log(
    `| ${name} | ${s.correct}/${s.total}(${(s.accuracy * 100).toFixed(1)}%) | ${s.missed} | ${s.overCalled} `
    + `| ${s.msAvg.toFixed(2)}ms | ${s.msMax.toFixed(2)}ms | ${cost === 0 ? '0' : `约 $${cost.toFixed(6)}`} |`,
  )
}
if (jev === undefined) console.log('| Jev(云端) | 没跑(无 key) | 没跑(无 key) | 没跑(无 key) | 没跑(无 key) | 没跑(无 key) | 没跑(无 key) |')
console.log('')
for (const [name, result] of columns) console.log(formatScore(name, result.score))

if (verbose) {
  console.log('')
  console.log('判错的那几条(第一列:线上缺省那一件):')
  for (const one of rulesAct.outcomes) {
    if (one.got === one.sample.label) continue
    const kind = one.sample.label === 'act' ? '漏判' : '误判'
    console.log(`  · 行 ${one.sample.line} ${kind}:该 ${one.sample.label} 判成 ${one.got} —— ${one.reason}`)
    console.log(`    「${one.sample.text.slice(0, 60)}${one.sample.text.length > 60 ? '…' : ''}」`
      + `${one.sample.tools.length === 0 ? '' : `(她当时调了:${one.sample.tools.join('、')})`}`)
  }
}
