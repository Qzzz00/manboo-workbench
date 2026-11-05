// @vitest-environment node
/**
 * 命令表(设计第四节)与硬护栏(第五节):模型出的命令按上下文包核指向,认不出的单条拒;
 * 护栏只此一处 —— 取消 / 删除 / 花钱 / 对外 / 动账号设备 → 问一句;不可改清单 → 拒。
 */
import { describe, expect, it } from 'vitest'
import { parseCommands } from '../src/server/hub/commands.ts'
import { buildContext, type HubHand } from '../src/server/hub/context.ts'
import { guardCommands } from '../src/server/hub/guard.ts'

const NOW = Date.parse('2026-10-28T09:40:00+08:00')
const HANDS: HubHand[] = [
  { id: 'claude', title: 'Claude', family: 'claude', card: false, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true },
  { id: 'agent:me:k1', title: '小K(重生版)', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true },
]
const ctx = buildContext({
  said: '', entrance: 'desktop', now: NOW, says: [], hands: HANDS, widgets: [],
  tasks: [
    { id: 't-ea1e8702', title: '修手机 App 重连竞态', status: 'blocked', updated_at: new Date(NOW).toISOString() },
    { id: 't-c323ffa6', title: '查 8791 空转热点', status: 'doing', updated_at: new Date(NOW).toISOString() },
  ],
  goals: [{ id: 'g-1', title: '周五交接', status: 'open' }],
})

describe('parseCommands:按上下文包核指向', () => {
  it('手按名字归一认(全半角 / 大小写 / 空白),落成手的 id', () => {
    const got = parseCommands({ commands: [{ name: 'reassign', card_id: 't-ea1e8702', to: '小k(重生版)' }] }, ctx)
    expect(got.commands).toEqual([{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1', restart: true }])
    expect(got.rejected).toEqual([])
  })

  it('板上没有的卡号、不认识的手、不认识的状态:单条拒,写明为什么;其余照收', () => {
    const got = parseCommands({ commands: [
      { name: 'cancel', card_id: 't-deadbeef' },
      { name: 'reassign', card_id: 't-ea1e8702', to: '小Z' },
      { name: 'move_status', card_id: 't-c323ffa6', status: 'archived' },
      { name: 'rename', card_id: 't-c323ffa6', title: '查工作台 8791 空转热点' },
    ] }, ctx)
    expect(got.commands).toEqual([{ name: 'rename', card_id: 't-c323ffa6', title: '查工作台 8791 空转热点' }])
    expect(got.rejected.map(one => one.why)).toEqual(['板上没有 t-deadbeef 这张卡', '不认识「小Z」这只手', '不认识的状态:archived'])
  })

  it('不在命令表里的名字整条拒(模型编不出新命令)', () => {
    const got = parseCommands({ commands: [{ name: 'delete_everything' }] }, ctx)
    expect(got.commands).toEqual([])
    expect(got.rejected[0]?.why).toBe('不在命令表里')
  })

  it('dispatch 新卡:标题、目标、验收条件照收;feedback 与 dispatch 同句时丢 feedback', () => {
    const got = parseCommands({ commands: [
      { name: 'feedback', text: '在跑的事项显示 0' },
      { name: 'dispatch', new: { title: '修事务官窗「在跑的事项」显示 0', goal_id: 'g-1' }, to: '小K(重生版)', text: '把在跑的事项显示 0 的问题修了', acceptance: ['在跑的事项与 /collab/runs 同数', '补用例'] },
    ] }, ctx)
    expect(got.commands).toEqual([{ name: 'dispatch', new: { title: '修事务官窗「在跑的事项」显示 0', goal_id: 'g-1' }, to: 'agent:me:k1', text: '把在跑的事项显示 0 的问题修了', acceptance: ['在跑的事项与 /collab/runs 同数', '补用例'] }])
    expect(got.rejected).toEqual([{ name: 'feedback', why: '同一句里已经派了活,不再当反馈' }])
  })

  it('目标命令:目标 id 必须在板上;状态只认三档', () => {
    expect(parseCommands({ commands: [{ name: 'goal_status', goal_id: 'g-1', status: 'reached' }] }, ctx).commands).toEqual([{ name: 'goal_status', goal_id: 'g-1', status: 'reached' }])
    expect(parseCommands({ commands: [{ name: 'goal_status', goal_id: 'g-9', status: 'reached' }] }, ctx).commands).toEqual([])
    expect(parseCommands({ commands: [{ name: 'goal_due', goal_id: 'g-1', due: '下周五' }] }, ctx).commands).toEqual([])
  })

  it('voice 只认 female / male', () => {
    expect(parseCommands({ commands: [{ name: 'voice', gender: 'male' }] }, ctx).commands).toEqual([{ name: 'voice', gender: 'male' }])
    expect(parseCommands({ commands: [{ name: 'voice', gender: 'robot' }] }, ctx).commands).toEqual([])
  })

  it('verify:卡号必须在板上;她这句带的验收条件逐条照收(卡上没条件时先落卡再核)', () => {
    expect(parseCommands({ commands: [{ name: 'verify', card_id: 't-c323ffa6' }] }, ctx).commands).toEqual([{ name: 'verify', card_id: 't-c323ffa6' }])
    expect(parseCommands({ commands: [{ name: 'verify', card_id: 't-c323ffa6', acceptance: ['同数', '补用例'] }] }, ctx).commands).toEqual([{ name: 'verify', card_id: 't-c323ffa6', acceptance: ['同数', '补用例'] }])
    expect(parseCommands({ commands: [{ name: 'verify', card_id: 't-deadbeef' }] }, ctx).commands).toEqual([])
  })

  it('最多收 6 条', () => {
    const got = parseCommands({ commands: Array.from({ length: 9 }, (_, i) => ({ name: 'note', title: `事 ${i}` })) }, ctx)
    expect(got.commands).toHaveLength(6)
  })
})

describe('guardCommands:护栏只此一处', () => {
  it('取消 / 挪去取消 / 目标不要了 → 改成问一句(带要挂起的那条命令)', () => {
    const out = guardCommands([
      { name: 'cancel', card_id: 't-ea1e8702' },
      { name: 'move_status', card_id: 't-c323ffa6', status: 'canceled' },
      { name: 'goal_status', goal_id: 'g-1', status: 'dropped' },
    ], ctx)
    expect(out.pass).toEqual([])
    expect(out.asks).toHaveLength(3)
    expect(out.asks[0]!.question).toContain('t-ea1e8702')
    expect(out.asks[0]!.question).toContain('修手机 App 重连竞态')
    expect(out.asks[0]!.held).toEqual({ name: 'cancel', card_id: 't-ea1e8702' })
  })

  it('派活本身要花钱 / 对外发 / 动账号:模型标了就问;没标但话里是发版、推公网、付款也问', () => {
    const out = guardCommands([
      { name: 'dispatch', card_id: 't-c323ffa6', to: 'claude', text: '查一下', risk: 'money' },
      { name: 'dispatch', card_id: 't-c323ffa6', to: 'claude', text: '跑 publish-update.sh 发版推到公网' },
      { name: 'dispatch', card_id: 't-c323ffa6', to: 'claude', text: '把 8791 空转热点查清楚' },
    ], ctx)
    expect(out.asks).toHaveLength(2)
    expect(out.pass).toEqual([{ name: 'dispatch', card_id: 't-c323ffa6', to: 'claude', text: '把 8791 空转热点查清楚' }])
  })

  it('不可改清单(悬浮窗 / 回滚 / 记忆读写 / 日结 / 澄清)被要求拿掉 → 拒,说明为什么', () => {
    const out = guardCommands([
      { name: 'dispatch', new: { title: '去掉日结' }, to: 'claude', text: '把日结功能删掉' },
      { name: 'user_layer_fix', said: '把 AI 悬浮窗关掉' },
    ], ctx)
    expect(out.pass).toEqual([])
    expect(out.refused).toHaveLength(2)
    expect(out.refused[0]!.ok).toBe(false)
    expect(out.refused[0]!.why).toContain('不可改')
  })

  it('修悬浮窗的显示问题不是拿掉它:放行', () => {
    const out = guardCommands([{ name: 'dispatch', new: { title: '修悬浮窗位置' }, to: 'claude', text: '悬浮窗位置偏了,修一下' }], ctx)
    expect(out.pass).toHaveLength(1)
  })

  it('她已经点头(confirmed)的那条不再问', () => {
    const out = guardCommands([{ name: 'cancel', card_id: 't-ea1e8702' }], ctx, { confirmed: true })
    expect(out.pass).toEqual([{ name: 'cancel', card_id: 't-ea1e8702' }])
    expect(out.asks).toEqual([])
  })

  it('改名、改派、补话、归目标、建卡、记规矩:不问', () => {
    const out = guardCommands([
      { name: 'rename', card_id: 't-c323ffa6', title: 'x' },
      { name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1', restart: true },
      { name: 'supplement', card_id: 't-ea1e8702', text: 'x' },
      { name: 'set_goal', card_id: 't-ea1e8702', goal_id: 'g-1' },
      { name: 'note', title: 'x', status: 'backlog' },
      { name: 'remember', text: '派活前先核额度', scope: 'dispatch' },
    ], ctx)
    expect(out.pass).toHaveLength(6)
  })
})
