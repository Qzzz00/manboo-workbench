// @vitest-environment node
/**
 * 替她批准:弹窗上哪几颗键给她按(approvalKeys.ts,2026-10-01 卡 AP「手机替她批准」)。
 *
 * 现场:维护者 10-01 午饭在外面,修手机横屏那条 Claude 会话在等批准,手机「待确认」里打了字 ——
 * 「输入回复内容之后,说发不出去」。打字批不了权限弹窗;要摆弹窗上**真实的那几颗键**给她按。
 *
 * 守:① 键名以壳读到的为准,只认「批准一次 / 拒绝」两类,**放宽的那类(本次会话都允许 / 不再询问)不给**;
 * ② 认不出是哪一类的键不摆;③ 一块里要**既有批准、又有拒绝**才算那个弹窗;
 * ④ 两块都像(两个弹窗)/ 一块里同名键两颗 → 认不准,一颗都不给;
 * ⑤ 电话里 / 她说「批准 / 可以 / 拒绝」→ 认成那一类,恰好一颗才算。
 */
import { describe, expect, it } from 'vitest'
import { approvalKeyKind, isPermissionAsk, pickApprovalPanel, resolveApprovalKey } from '../src/server/approvalKeys.ts'

describe('键名 → 哪一类(不写死一家的叫法,只按意思认)', () => {
  it('批准一次', () => {
    for (const label of ['Allow once', 'Allow', 'Approve', 'Yes', 'Run', '允许一次', '批准', '允许', '同意', '是']) {
      expect(approvalKeyKind(label), label).toBe('once')
    }
  })
  it('拒绝', () => {
    for (const label of ['Deny', 'Reject', 'No', 'No, and tell Claude what to do differently', "Don't allow", 'Decline', 'Cancel', '拒绝', '不允许', '取消']) {
      expect(approvalKeyKind(label), label).toBe('deny')
    }
  })
  it('★放宽的那一类认得出来(先认它:「Allow for this session」开头也是 Allow)', () => {
    for (const label of ['Always allow', 'Allow for this session', 'Allow all edits during this session', "Yes, and don't ask again for git commands", 'Approve for session', 'Always deny', '始终允许', '本次会话都允许', '允许本次会话', '以后都允许', '不再询问']) {
      expect(approvalKeyKind(label), label).toBe('broad')
    }
  })
  it('认不出的键(复制、看详情、接着规划)不算', () => {
    for (const label of ['Copy', 'Show details', 'Keep planning', '展开', '']) {
      expect(approvalKeyKind(label), label).toBeUndefined()
    }
  })
})

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('壳读回来的那几块里,哪一块是这条会话的弹窗', () => {
  it('★只给「批准一次 / 拒绝」,放宽的那颗留着不给(另记一笔)', () => {
    const picked = pickApprovalPanel([
      { rect: rect(20, 400, 600, 120), keys: ['Allow once', 'Allow for this session', 'Deny'] },
    ])
    expect(picked).toEqual({
      ok: true,
      panel: rect(20, 400, 600, 120),
      keys: [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }],
      held: ['Allow for this session'],
    })
  })

  it('同一个弹窗它的外面几层也够格 → 取最里面那一块(外层多出来的「复制」不算)', () => {
    const picked = pickApprovalPanel([
      { rect: rect(20, 400, 600, 120), keys: ['Allow once', 'Deny'] },
      { rect: rect(0, 300, 700, 400), keys: ['Copy', 'Allow once', 'Deny'] },
    ])
    expect(picked).toMatchObject({ ok: true, panel: rect(20, 400, 600, 120) })
  })

  it('★只含那截原话、没有批准键的(代码块的「复制」)不算那个弹窗', () => {
    expect(pickApprovalPanel([{ rect: rect(20, 400, 600, 40), keys: ['Copy'] }]))
      .toEqual({ ok: false, why: '没在它窗口里认出这一步的批准弹窗' })
    expect(pickApprovalPanel([])).toEqual({ ok: false, why: '没在它窗口里认出这一步的批准弹窗' })
  })

  it('★只有批准、没有拒绝的一块不算(宁窄勿宽:随便一颗「Run」不是批准弹窗)', () => {
    expect(pickApprovalPanel([{ rect: rect(20, 400, 600, 40), keys: ['Run', 'Copy'] }])).toMatchObject({ ok: false })
  })

  it('★两个弹窗都含这截原话(两个子任务跑同一条命令)→ 认不准,一颗都不给', () => {
    expect(pickApprovalPanel([
      { rect: rect(20, 100, 600, 120), keys: ['Allow once', 'Deny'] },
      { rect: rect(20, 400, 600, 120), keys: ['Allow once', 'Deny'] },
    ])).toEqual({ ok: false, why: '它窗口里有 2 个批准弹窗都像这一步的,认不准是哪一个,一颗键都没敢按' })
  })

  it('★一块里同名的键两颗(两个弹窗挤在一块里)→ 认不准', () => {
    expect(pickApprovalPanel([{ rect: rect(0, 0, 600, 300), keys: ['Allow once', 'Deny', 'Allow once', 'Deny'] }]))
      .toEqual({ ok: false, why: '那一块里有两颗都叫「Allow once」,认不准是哪个弹窗的,一颗键都没敢按' })
  })

  it('只有放宽的那颗能批 → 不给(她要在电脑上自己决定放不放宽)', () => {
    expect(pickApprovalPanel([{ rect: rect(0, 0, 600, 100), keys: ['Always allow', 'Deny'] }]))
      .toEqual({ ok: false, why: '那个弹窗上只有「Always allow」这种放宽权限的键能批,这一下得你在电脑上自己按' })
  })
})

describe('她点的 / 她说的 → 哪一颗', () => {
  const keys = [{ label: 'Allow once', does: 'once' as const }, { label: 'Deny', does: 'deny' as const }]
  it('点的就是那颗键名', () => {
    expect(resolveApprovalKey(keys, 'Allow once')).toEqual({ label: 'Allow once', does: 'once' })
    expect(resolveApprovalKey(keys, ' Deny ')).toEqual({ label: 'Deny', does: 'deny' })
  })
  it('★电话里说「批准 / 可以 / 拒绝 / 不行」→ 那一类恰好一颗', () => {
    expect(resolveApprovalKey(keys, '批准')).toEqual({ label: 'Allow once', does: 'once' })
    expect(resolveApprovalKey(keys, '可以的')).toEqual({ label: 'Allow once', does: 'once' })
    expect(resolveApprovalKey(keys, '拒绝')).toEqual({ label: 'Deny', does: 'deny' })
    expect(resolveApprovalKey(keys, '不行')).toEqual({ label: 'Deny', does: 'deny' })
  })
  it('听不出 / 那一类有两颗 → 不替她挑', () => {
    expect(resolveApprovalKey(keys, '嗯我想想')).toBeUndefined()
    expect(resolveApprovalKey([...keys, { label: 'Yes', does: 'once' }], '批准')).toBeUndefined()
    // 放宽的那颗不在 keys 里,点它的名字也认不出来
    expect(resolveApprovalKey(keys, 'Allow for this session')).toBeUndefined()
  })
})

describe('哪一问是权限弹窗', () => {
  it('★「要你批」+ 它自己弹的框(form)或子任务的那一问 = 权限弹窗;按内容读出来的「要不要我…」不是', () => {
    expect(isPermissionAsk({ kind: 'approve', by: 'form' })).toBe(true)
    expect(isPermissionAsk({ kind: 'approve', by: 'rules', child: { id: 'a1' } })).toBe(true)
    expect(isPermissionAsk({ kind: 'approve', by: 'rules' })).toBe(false)
    expect(isPermissionAsk({ kind: 'choose', by: 'form' })).toBe(false)
    expect(isPermissionAsk(undefined)).toBe(false)
  })
})
