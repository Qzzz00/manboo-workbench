/**
 * 回归集的报告(A3 发版门读它;契约由统筹 10-28 定):
 *
 *   report.json = { at, entrances[], total, passed, rate, rows: [{ id, entrance, said, expect[], got[], verdict, note? }] }
 *
 * verdict 只有四档「对 / 过度 / 不足 / 模糊」,只有「对」算 passed,rate = passed / total。
 * 打分那一侧多一档「错」(= 不足 + 过度,改派落成改名这类):报告里记成「过度」(它动了不该动的手),note 注明是「错」。
 * 模型没接上 / 坏结构记成「不足」,note 注明。一行跑几遍取最差那一遍,note 里写全几遍的分。
 * 各入口(desktop / call / phone)写同一份:按 id 覆盖,不丢别的入口的行。
 */
export type ReportVerdict = '对' | '过度' | '不足' | '模糊'
export type ReportEntrance = 'desktop' | 'call' | 'phone'

export interface ReportRow {
  id: string
  entrance: ReportEntrance
  said: string
  expect: string[]
  got: string[]
  verdict: ReportVerdict
  note?: string
}

export interface Report {
  at: string
  entrances: ReportEntrance[]
  total: number
  passed: number
  rate: number
  rows: ReportRow[]
}

const WORST: readonly string[] = ['失败', '错', '不足', '模糊', '过度', '对']

/** 一行的几遍(打分那一侧的 Grade 或「失败」)收成报告里的一行。 */
export function reportRows(input: readonly { id: string, entrance: ReportEntrance, said: string, expect: string[], got: string[], grades: readonly string[] }[]): ReportRow[] {
  return input.map((one) => {
    const worst = [...one.grades].sort((a, b) => WORST.indexOf(a) - WORST.indexOf(b))[0] ?? '失败'
    const verdict: ReportVerdict = worst === '错' ? '过度' : worst === '失败' ? '不足' : worst as ReportVerdict
    const notes = [
      worst === '错' ? '错:少了期望的命令,又动了别的手' : '',
      worst === '失败' ? '模型没接上或回了坏结构' : '',
      one.grades.length > 1 ? `${one.grades.length} 遍:${one.grades.join('')}` : '',
    ].filter(Boolean)
    return { id: one.id, entrance: one.entrance, said: one.said, expect: one.expect, got: one.got, verdict, ...(notes.length === 0 ? {} : { note: notes.join(';') }) }
  })
}

export function mergeReport(prev: Report | undefined, rows: readonly ReportRow[], at: string): Report {
  const byId = new Map<string, ReportRow>((prev?.rows ?? []).map(one => [one.id, one]))
  for (const one of rows) byId.set(one.id, one)
  const all = [...byId.values()]
  const passed = all.filter(one => one.verdict === '对').length
  return {
    at,
    entrances: [...new Set(all.map(one => one.entrance))].sort(),
    total: all.length,
    passed,
    rate: all.length === 0 ? 0 : passed / all.length,
    rows: all,
  }
}

export function summaryOf(report: Report): string {
  const pct = Math.round(report.rate * 1000) / 10
  const lines = [
    '# 回归集结果(理解中枢「指哪张 / 做什么」)',
    '',
    `${report.at} · 通过 ${report.passed} / ${report.total}(${pct}%)· 入口:${report.entrances.join('、')}`,
    '',
    '只给命令打分,不看回话;「对」才算通过。用例与打分见 `dev/intent-regression/`。',
    '',
  ]
  for (const entrance of report.entrances) {
    const rows = report.rows.filter(one => one.entrance === entrance)
    lines.push(`## ${entrance}(${rows.filter(one => one.verdict === '对').length} / ${rows.length})`, '', '| 行 | 结果 | 期望 | 模型出的 | 原话 | 备注 |', '|---|---|---|---|---|---|')
    for (const one of rows) {
      const cell = (text: string): string => text.replace(/\|/gu, '/').replace(/\n/gu, ' ')
      lines.push(`| ${cell(one.id)} | ${one.verdict} | ${one.expect.join(' + ')} | ${one.got.join(' + ')} | ${cell(one.said.slice(0, 60))}${one.said.length > 60 ? '…' : ''} | ${cell(one.note ?? '')} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
