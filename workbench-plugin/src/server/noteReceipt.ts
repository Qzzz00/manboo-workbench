/**
 * **回执只许三种**(2026-10-21 协作区,设计稿第五节第 4、5 条;GOSIM · Octos 的内环回执)。
 *
 * 派出去的说明里验收带 1、2、3 的编号,并写明交回只许三种开头:做完(带产物 / 证据)、有异议(带理由)、
 * 卡住(带卡在哪)。读回来的那段话**认得出**三种之一就记成回执落章;**认不出**的照今天的现算继续走,
 * 章上多标「回执不规范」—— 不猜它是哪一种(D13)。纯函数。
 */
import type { NoteReceiptKind } from '../protocol.ts'

/** 派活说明最后那一句(断言照它)。 */
export const RECEIPT_ASK_LINE = '交回只许三种开头之一,并对着编号答:「做完:」带产物或证据 /「有异议:」带理由 /「卡住:」说卡在哪。'

/** 验收那一段:带编号。没有验收就是空串(派活说明一字不加)。 */
export function acceptanceBlock(acceptance: readonly string[] | undefined): string {
  const items = (acceptance ?? []).map(one => one.trim()).filter(one => one !== '')
  if (items.length === 0) return ''
  return ['做到什么算完:', ...items.map((one, index) => `${index + 1}. ${one}`), RECEIPT_ASK_LINE].join('\n')
}

const OPENERS: readonly { kind: NoteReceiptKind, pattern: RegExp }[] = [
  { kind: 'done', pattern: /^(做完|完成了?|已完成|done)(?=$|[\s::,,。!!—-])/i },
  { kind: 'objection', pattern: /^(有异议|异议|不同意|objection)(?=$|[\s::,,。!!—-])/i },
  { kind: 'blocked', pattern: /^(卡住了?|阻塞|做不了|blocked)(?=$|[\s::,,。!!—-])/i },
]

/** 开头可能先有一个「回执:」或派活记号【工作台派活 xxxxxx】,剥掉再认。 */
function opening(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return first
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^(回执|receipt)\s*[::]\s*/i, '')
    .trim()
}

export function parseReceipt(text: string): { kind: NoteReceiptKind, text: string } | undefined {
  const whole = text.trim()
  if (whole === '') return undefined
  const head = opening(whole)
  const hit = OPENERS.find(one => one.pattern.test(head))
  return hit === undefined ? undefined : { kind: hit.kind, text: whole }
}
