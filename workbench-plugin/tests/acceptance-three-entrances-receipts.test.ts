// @vitest-environment node
/**
 * 验收脚本照着界面抄的那两句(电脑回执、手机刚送到的气泡)与源头对照:
 * 抄的是哪几段列在 `*_SOURCE_MARKS` 里,这里逐条去源头文件找 —— 界面改了这里没跟,就红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import {
  DESK_RECEIPT_SOURCE_MARKS,
  PHONE_PENDING_SOURCE_MARKS,
  deskReceiptOf,
  phonePendingOf,
} from '../dev/acceptance-three-entrances/receipts.ts'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

function phoneDeliveredSource(): string {
  const text = source('../../butler-app/src/chat/useSendItem.ts')
  const file = ts.createSourceFile('useSendItem.ts', text, ts.ScriptTarget.Latest, true)
  const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'deliveredOf')
  expect(declaration && ts.isFunctionDeclaration(declaration) && declaration.body).toBeTruthy()
  return (declaration as ts.FunctionDeclaration).body!.getText(file)
}

function expectPhoneBranchesInOrder(text: string): void {
  let after = 0
  for (const mark of PHONE_PENDING_SOURCE_MARKS) {
    const at = text.indexOf(mark, after)
    expect(at, `deliveredOf 中缺失或顺序错误: ${mark}`).toBeGreaterThanOrEqual(after)
    after = at + mark.length
  }
}

describe('对照源头', () => {
  it('电脑回执那几段还在 ButlerInbox.tsx 里', () => {
    const text = source('../src/client/ButlerInbox.tsx')
    for (const mark of DESK_RECEIPT_SOURCE_MARKS) expect(text, mark).toContain(mark)
  })

  it('手机气泡那几段还在 useSendItem.ts 里', () => {
    expectPhoneBranchesInOrder(phoneDeliveredSource())
  })

  it('源头守门拒绝 fileAsk 降到专项之后、丢 screen 或按任意卡 ID 冒成功', () => {
    const text = phoneDeliveredSource()
    const fileAsk = PHONE_PENDING_SOURCE_MARKS[3]!
    const moved = text.replace(fileAsk, '').replace('if (data.carried_on === true)', `${fileAsk}\nif (data.carried_on === true)`)
    expect(() => expectPhoneBranchesInOrder(moved)).toThrow()
    expect(() => expectPhoneBranchesInOrder(text.replace(fileAsk, 'if (fileAsk !== null) return { fileAsk };'))).toThrow()
    expect(() => expectPhoneBranchesInOrder(text.replace("returnedItems.every(item => item.status === 'done' && typeof item.card_id === 'string')", "returnedItems.some(item => typeof item.card_id === 'string')"))).toThrow()
    expect(() => expectPhoneBranchesInOrder(text.replace('note: line, settled: true', 'note: line'))).toThrow()
  })

  it('真实待发箱与当场发送都经 settle，fileAsk 返回给调用方而不留下 pending', () => {
    const text = source('../../butler-app/src/chat/useSendItem.ts')
    for (const mark of [
      'const got = deliveredOf(entry, raw, path);',
      'setDelivered((list) => [...list.filter((p) => p.localId !== entry.key), ...(got.pending === undefined ? [] : [got.pending])]);',
      'if (got.refresh === true) void session.feed.refresh();',
      'return got.fileAsk;',
      'settle(event.delivered, event.data, event.delivered.path)',
      "if (outcome.kind !== 'delivered') return { ok: false, error: outcome.error };",
      'const fileAsk = settle({ key, text: trimmed, at }, outcome.data, path);',
      'return fileAsk === undefined ? { ok: true } : { ok: true, fileAsk };',
    ]) expect(text, mark).toContain(mark)
  })
})

describe('电脑回执', () => {
  it('建下了带 note:前缀「已建下,」', () => {
    expect(deskReceiptOf({ ok: true, id: 't1', note: '记下了,没派给谁 —— 要谁去办再说一句。' }, true))
      .toBe('已建下,记下了,没派给谁 —— 要谁去办再说一句。')
  })
  it('没 note:事项已建下;接着说:不说建下', () => {
    expect(deskReceiptOf({ ok: true, id: 't1' }, true)).toBe('事项已建下')
    expect(deskReceiptOf({ ok: true, id: 't1', carried_on: true, note: 'x' }, true)).toBe('接着刚才那件说了')
  })
  it('登记会、本体反馈照服务端那一句;没建成照错', () => {
    expect(deskReceiptOf({ ok: true, meeting_plan: {}, note: '记下了这场会,还差两问' }, true)).toBe('记下了这场会,还差两问')
    expect(deskReceiptOf({ ok: true, feedback: {} }, true)).toBe('这是工作台本身的问题,我反馈给开发者了。')
    expect(deskReceiptOf({ ok: false, error: '内容不能为空' }, false)).toBe('内容不能为空')
    expect(deskReceiptOf({}, false)).toBe('没建成')
  })
})

describe('手机刚送到的气泡', () => {
  it('有卡 id:挂卡,后面看卡;没有 id 也不是固定那几档:送到了', () => {
    expect(phonePendingOf({ ok: true, id: 't1', note: '记下了' })).toEqual({ taskId: 't1' })
    expect(phonePendingOf({ ok: true, note: '这一类还在内测,我先不接' })).toEqual({ note: '送到了' })
  })
  it('换待办版面 / 发布计划 / 登记会:电脑那一句,算办完', () => {
    expect(phonePendingOf({ ok: true, today_view: {}, note: '好,改成按日期汇总了。' })).toEqual({ note: '好,改成按日期汇总了。', settled: true })
    expect(phonePendingOf({ ok: true, publish_plan: {} })).toEqual({ note: '记进发布计划了。', settled: true })
    expect(phonePendingOf({ ok: true, meeting_plan: {}, note: '记下了' }, '(在会议里答)')).toEqual({ note: '记下了(在会议里答)', settled: true })
  })
  it('接着上一件说:不挂卡', () => {
    expect(phonePendingOf({ ok: true, id: 't9', carried_on: true })).toEqual({ note: '接着刚才那件说了' })
  })
})
