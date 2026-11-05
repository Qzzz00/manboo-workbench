/**
 * 回归集 harness(设计第七节):每条用例在预置板上过一遍**真模型**的理解中枢(上下文包 → 模型出命令),
 * 按「对 / 过度 / 不足 / 模糊 / 错」打分,打印每行结果与整表通过率,并写同目录的 `report.json`(A3 发版门读,契约见 report.ts)
 * 与 `summary.md`。只到「模型出了什么命令」为止 —— 不执行、不碰板。模型走 modelService 定的那一家,**只读** `~/.dsh/workbench/model.json` / `credentials.json`。
 *
 *   在 workbench-plugin/ 下跑:node dev/intent-regression/run.mjs [--entrance desktop] [--only 09:35] [--repeat 3] [--out <明细.json>]
 *   (run.mjs 先用 rolldown 把本文件打成一个 .mjs 再跑:模型服务那一串里有 Node 剥类型剥不了的写法。)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createModelService } from '../../src/server/modelService.ts'
import { OWN_DEFAULT_MODEL } from '../../src/server/modelConfig.ts'
import { buildContext, type HubSayRecord } from '../../src/server/hub/context.ts'
import { understandCommands } from '../../src/server/hub/understand.ts'
import { CASES, FIXTURE } from './cases.ts'
import { grade, type Grade } from './score.ts'
import { mergeReport, reportRows, summaryOf, type Report, type ReportEntrance } from './report.ts'

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}

const NOW = Date.parse('2026-10-28T13:30:00+08:00')
// 打包后 import.meta.url 不在原处:仓库根按「在 workbench-plugin/ 下跑」算。
const repoRoot = pathToFileURL(`${resolve(process.cwd(), '..')}/`)
const only = argOf('only')
const repeat = Math.max(1, Number(argOf('repeat') ?? '1'))
const out = argOf('out')
const entrance = argOf('entrance')
const here = resolve(process.cwd(), 'dev/intent-regression')

const model = createModelService({
  modelFile: `${homedir()}/.dsh/workbench/model.json`,
  credentialFile: `${homedir()}/.dsh/workbench/credentials.json`,
})
const endpoint = await model.endpoint()
if (!endpoint.ready) {
  console.error('模型服务没接上(model.json / 中转),回归集没跑')
  process.exit(2)
}
console.log(`模型:${endpoint.model ?? OWN_DEFAULT_MODEL} · 用例 ${CASES.length} 条 · 每条 ${repeat} 遍`)

interface Row { row: string, said: string, synopsis: boolean, run: number, grade: Grade | '失败', got: unknown[], rejected: unknown[], acceptance: number, ms: number, why?: string }
const rows: Row[] = []

for (const c of CASES) {
  if (only !== undefined && !c.row.includes(only)) continue
  if (entrance !== undefined && c.entrance !== entrance) continue
  const hidden = new Set(c.hide ?? [])
  const tasks = [...FIXTURE.tasks, ...(c.add ?? [])]
    .filter(one => !hidden.has(one.id))
    .map(({ minutesAgo, ...one }) => ({ ...one, title: c.patch?.find(p => p.id === one.id)?.title ?? one.title, updated_at: new Date(NOW - minutesAgo * 60_000).toISOString() }))
  const says: HubSayRecord[] = (c.says ?? []).map((one, i) => ({ say_id: `s${i}`, at: NOW - one.minutesAgo * 60_000, entrance: c.entrance, said: one.said, commands: one.commands, cards: one.cards }))
  const files = []
  for (const rel of c.files ?? []) {
    const text = await readFile(new URL(rel, repoRoot), 'utf8').catch(() => undefined)
    if (text !== undefined) files.push({ path: rel, head: text.slice(0, 3000) })
  }
  const ctx = buildContext({ said: c.said, entrance: c.entrance, now: NOW, says, tasks, goals: FIXTURE.goals.map(one => ({ ...one, status: c.goalStatus?.find(g => g.id === one.id)?.status ?? one.status })), hands: FIXTURE.hands, widgets: FIXTURE.widgets, files, devMachine: FIXTURE.devMachine })
  for (let run = 1; run <= repeat; run += 1) {
    const at = Date.now()
    const got = await understandCommands(c.said, ctx, { endpoint: () => model.endpoint(), timeoutMs: 90_000 })
    const ms = Date.now() - at
    if (!got.ok) {
      rows.push({ row: c.row, said: c.said, synopsis: c.synopsis === true, run, grade: '失败', got: [], rejected: [], acceptance: 0, ms, why: got.why })
      console.log(`✗ ${c.row} #${run} 模型${got.why === 'unreachable' ? '没接上' : '回了坏结构'}(${ms}ms)`)
      continue
    }
    const g = grade(c, got.commands as never)
    const acceptance = got.commands.reduce((n, one) => n + ('acceptance' in one && Array.isArray(one.acceptance) ? one.acceptance.length : 0), 0)
    rows.push({ row: c.row, said: c.said, synopsis: c.synopsis === true, run, grade: g, got: got.commands, rejected: got.rejected, acceptance, ms })
    const brief = got.commands.map(one => [one.name, 'card_id' in one ? one.card_id : undefined, 'to' in one ? one.to : undefined, 'goal_id' in one ? one.goal_id : undefined, 'status' in one ? one.status : undefined].filter(Boolean).join(' ')).join(' + ')
    console.log(`${g === '对' ? '✓' : '✗'} ${c.row} #${run} [${g}] ${brief}${got.rejected.length === 0 ? '' : ` (拒 ${got.rejected.map(one => one.why).join(';')})`}${acceptance > 0 ? ` 验收${acceptance}条` : ''} ${ms}ms`)
  }
}

const total = rows.length
const pass = rows.filter(one => one.grade === '对').length
const tally = rows.reduce<Record<string, number>>((acc, one) => ({ ...acc, [one.grade]: (acc[one.grade] ?? 0) + 1 }), {})
console.log(`\n通过率 ${pass}/${total} = ${total === 0 ? 0 : Math.round(pass / total * 1000) / 10}%  ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
// 报告:一行(id = 回归集那一行)几遍取最差;按 id 并进已有的 report.json,别的入口的行不动。
const ran = CASES.filter(c => rows.some(one => one.row === c.row)).map(c => ({
  id: c.row,
  entrance: c.entrance as ReportEntrance,
  said: c.said,
  expect: (c.expect[0] ?? []).map(one => one.name),
  got: ((rows.filter(one => one.row === c.row).at(-1)?.got ?? []) as { name: string }[]).map(one => one.name),
  grades: rows.filter(one => one.row === c.row).map(one => one.grade),
}))
const prev = await readFile(`${here}/report.json`, 'utf8').then(text => JSON.parse(text) as Report).catch(() => undefined)
const report = mergeReport(prev, reportRows(ran), new Date().toISOString())
await writeFile(`${here}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
await writeFile(`${here}/summary.md`, `${summaryOf(report)}\n`)
console.log(`报告:dev/intent-regression/report.json(整份 ${report.passed}/${report.total})与 summary.md`)
if (out !== undefined) {
  await writeFile(out, JSON.stringify({ at: new Date().toISOString(), model: endpoint.model ?? OWN_DEFAULT_MODEL, pass, total, tally, rows }, null, 2))
  console.log(`明细写在 ${out}`)
}
