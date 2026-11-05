// @vitest-environment node
/**
 * 理解中枢的执行器(设计第四、五节):一张工具表接到现有的手。
 * 派前核手(登录 / 额度 / 装没装 / 在不在跑);点名的不自动换人;换手只在派发口一处
 * (中枢只派一下、失败如实说并建议下一只,真换手由派发口按执行记录兜底);
 * 改派永不改名;补话先落卡再捎。每条结果 {ok, did, why?, next?}。
 */
import { describe, expect, it } from 'vitest'
import { canTransition, type TaskStatus } from '../src/protocol.ts'
import { buildContext, type HubHand } from '../src/server/hub/context.ts'
import { executeCommands, type HubHands } from '../src/server/hub/execute.ts'
import type { HubCommand } from '../src/server/hub/commands.ts'

const NOW = Date.parse('2026-10-28T09:40:00+08:00')
const iso = new Date(NOW).toISOString()

const HANDS: HubHand[] = [
  { id: 'claude', title: 'Claude', family: 'claude', card: false, installed: true, login: 'no', quota: 'ok', running: 0, ok: true, code: true, recommended: true },
  { id: 'kimi', title: 'Kimi', family: 'kimi', card: false, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true },
  { id: 'codex', title: 'Codex', family: 'codex', card: false, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true },
  { id: 'agent:me:k1', title: '小K(重生版)', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 1, ok: true, code: true },
  { id: 'agent:me:g1', title: '小G', family: 'codex', card: true, installed: true, login: 'yes', quota: 'empty', running: 0, ok: true, code: true },
]

function makeCtx(said = '') {
  return buildContext({
    said, entrance: 'desktop', now: NOW, says: [], hands: HANDS,
    widgets: [{ id: 'quick-note', name: '随手记', status: 'ok', replaces: 'quick_note' }],
    tasks: [
      { id: 't-ea1e8702', title: '修手机 App 重连竞态', status: 'blocked', updated_at: iso, assignee: 'agent:me:g1', dispatch: { family: 'codex', status: 'failed' } },
      { id: 't-c323ffa6', title: '查 8791 空转热点', status: 'doing', updated_at: iso, assignee: 'agent:me:k1', acceptance: ['同数'], dispatch: { family: 'kimi', status: 'running' } },
      { id: 't-d7eeb2ff', title: '旧排期卡', status: 'todo', updated_at: iso },
      { id: 't-8b3c1d0a', title: '待排的样片', status: 'backlog', updated_at: iso },
      { id: 't-7f2e9b1c', title: '已经交掉的卡', status: 'done', updated_at: iso },
      { id: 't-d66412f5', title: '核一遍的活', status: 'confirm', updated_at: iso, acceptance: ['同数', '补用例'], dispatch: { family: 'kimi', status: 'ended', ended_at: iso } },
      { id: 't-3109f7ab', title: '交回没写条件的活', status: 'confirm', updated_at: iso, dispatch: { family: 'kimi', status: 'ended', ended_at: iso } },
    ],
    goals: [{ id: 'g-1', title: '周五交接', status: 'open' }],
  })
}

interface Log { calls: string[] }

function fakeHands(over: Partial<HubHands> = {}): HubHands & Log {
  const calls: string[] = []
  let n = 0
  const hands: HubHands = {
    createCard: async input => { calls.push(`create ${input.title} status=${input.status}${input.goalId === undefined ? '' : ` goal=${input.goalId}`}${input.acceptance === undefined ? '' : ` acc=${input.acceptance.join('|')}`}${input.assignee === undefined ? '' : ` who=${input.assignee}`}`); return { ok: true, id: `t-new${++n}` } },
    updateCard: async (id, patch) => { calls.push(`update ${id} ${JSON.stringify(patch)}`); return true },
    moveCard: async (id, status) => { calls.push(`move ${id} ${status}`); return { ok: true } },
    comment: async (id, text) => { calls.push(`comment ${id} ${text}`); return { ok: true } },
    carry: async (id, text) => { calls.push(`carry ${id} ${text}`); return { ok: false, why: '命令行中途捎不进去' } },
    dispatch: async (id, input) => { calls.push(`dispatch ${id} to=${input.to}`); return { ok: true } },
    reassign: async (id, input) => { calls.push(`reassign ${id} to=${input.to} family=${input.family}`); return { ok: true, note: `${id} 已改派给${input.to},原来小K那次已停` } },
    createGoal: async input => { calls.push(`goal+ ${input.title}${input.due === undefined ? '' : ` due=${input.due}`}`); return { ok: true, id: 'g-new' } },
    updateGoal: async (id, patch) => { calls.push(`goal ${id} ${JSON.stringify(patch)}`); return true },
    userLayerFix: async input => { calls.push(`ulfix to=${input.to}${input.cardId === undefined ? '' : ` card=${input.cardId}`}`); return { ok: true, id: input.cardId ?? 't-ul1' } },
    remember: async input => { calls.push(`rule ${input.scope} ${input.text}`); return { ok: true } },
    feedback: async text => { calls.push(`feedback ${text}`); return { ok: true, id: 'WB-1' } },
    voice: async gender => { calls.push(`voice ${gender}`); return { ok: true, note: '音色换成女声了' } },
    ...over,
  }
  return Object.assign(hands, { calls })
}

async function run(commands: HubCommand[], hands: HubHands, said = '原话') {
  return executeCommands(commands, makeCtx(said), hands, { said })
}

describe('dispatch', () => {
  it('新卡 + 点名可用的名片:建卡(带目标与验收)→ 挂负责人 → 派', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'dispatch', new: { title: '修在跑的事项显示 0', goal_id: 'g-1' }, to: 'agent:me:k1', text: '把在跑的事项显示 0 修了', acceptance: ['同数', '补用例'] }], h)
    expect(h.calls).toEqual([
      'create 修在跑的事项显示 0 status=todo goal=g-1 acc=同数|补用例 who=agent:me:k1',
      'dispatch t-new1 to=agent:me:k1',
    ])
    expect(r).toMatchObject({ command: 'dispatch', ok: true, card_id: 't-new1', who: '小K(重生版)' })
    expect(r!.did).toContain('t-new1')
  })

  it('点名的手不行(额度用完):卡照建、不派、不自动换人;说清为什么、给下一只建议', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'dispatch', new: { title: '修手机 App 重连竞态' }, to: 'agent:me:g1', text: '修重连竞态' }], h)
    expect(h.calls.some(one => one.startsWith('dispatch'))).toBe(false)
    expect(r).toMatchObject({ ok: false, card_id: 't-new1' })
    expect(r!.why).toContain('额度用完')
    expect(r!.next).toMatch(/换.*(Kimi|Codex|小K)/u)
  })

  it('没点名:挑可用的(跳过登录过期的默认推荐);派发失败换下一只', async () => {
    let tries = 0
    const h = fakeHands({ dispatch: async (_id, input) => { tries += 1; return tries === 1 ? { ok: false, note: `${input.to} 起不来` } : { ok: true } } })
    const [r] = await run([{ name: 'dispatch', new: { title: '查国庆放假' }, text: '查一下国庆放假多少天' }], h)
    expect(r).toMatchObject({ ok: true })
    expect(r!.who).not.toBe('Claude')
    expect(tries).toBe(2)
  })

  it('已有卡正在同一只手上跑:也不再派第二路,建议补一句', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'dispatch', card_id: 't-c323ffa6', to: 'agent:me:k1', text: '再查一下' }], h)
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('正在')
    expect(r!.next).toContain('补一句')
    expect(h.calls).toEqual([])
  })

  it('已有卡正在别人手上跑:不再派第二路', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'dispatch', card_id: 't-c323ffa6', to: 'codex', text: '查' }], h)
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('正在')
    expect(r!.next).toContain('改派')
    expect(h.calls).toEqual([])
  })
})

describe('reassign:同卡换人,永不改名', () => {
  it('走改派那只唯一的手(applyReassignDispatch:旧派发收场 → 换负责人 → 同卡重派);标题一个字不动', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'reassign', card_id: 't-c323ffa6', to: 'codex', restart: true }], h)
    expect(h.calls).toEqual(['reassign t-c323ffa6 to=codex family=codex'])
    expect(h.calls.some(one => one.includes('"title"'))).toBe(false)
    expect(r).toMatchObject({ ok: true, card_id: 't-c323ffa6', who: 'Codex' })
    expect(r!.did).toContain('已改派给')
    expect(r!.did).toContain('已停')
  })

  it('改派给名片:带上名片底下那一家', async () => {
    const h = fakeHands()
    await run([{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1', restart: true }], h)
    expect(h.calls).toEqual(['reassign t-ea1e8702 to=agent:me:k1 family=kimi'])
  })

  it('那只手没派出去:如实回它的话,建议下一只', async () => {
    const h = fakeHands({ reassign: async id => ({ ok: false, note: `${id} 已改派给Codex,可这次没派出去:起不来` }) })
    const [r] = await run([{ name: 'reassign', card_id: 't-c323ffa6', to: 'codex', restart: true }], h)
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('起不来')
    expect(r!.next).toBeDefined()
  })

  it('restart:false 只换负责人不重派', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'reassign', card_id: 't-ea1e8702', to: 'kimi', restart: false }], h)
    expect(h.calls).toEqual(['update t-ea1e8702 {"assignee":"kimi"}'])
    expect(r!.ok).toBe(true)
  })

  it('改给的那只手不行:不动卡,说为什么 + 下一只', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'reassign', card_id: 't-ea1e8702', to: 'claude', restart: true }], h)
    expect(h.calls).toEqual([])
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('登录过期')
    expect(r!.next).toBeDefined()
  })
})

describe('supplement:先落卡再捎', () => {
  it('捎不进命令行也算办成(落在卡上了,下一轮带上)', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'supplement', card_id: 't-c323ffa6', text: '顺便看下 tick 的间隔' }], h)
    expect(h.calls[0]).toBe('comment t-c323ffa6 顺便看下 tick 的间隔')
    expect(h.calls[1]).toBe('carry t-c323ffa6 顺便看下 tick 的间隔')
    expect(r).toMatchObject({ ok: true, card_id: 't-c323ffa6' })
    expect(r!.did).toContain('记在')
  })
  it('落卡失败才算没办成', async () => {
    const h = fakeHands({ comment: async () => ({ ok: false }) })
    const [r] = await run([{ name: 'supplement', card_id: 't-c323ffa6', text: 'x' }], h)
    expect(r!.ok).toBe(false)
  })

  it('★像条件的补话(以…为准 / 只… / 合 main 后…):同时追加到验收,原句不改;不像条件的只落评论', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'supplement', card_id: 't-c323ffa6', text: '以 main 上的 useCollabRuns 为准,只并上收起球与 runningCountOf,合 main 后再交。' }], h)
    expect(h.calls[0]).toBe('comment t-c323ffa6 以 main 上的 useCollabRuns 为准,只并上收起球与 runningCountOf,合 main 后再交。')
    expect(h.calls).toContain('update t-c323ffa6 {"acceptance":["同数","以 main 上的 useCollabRuns 为准,只并上收起球与 runningCountOf,合 main 后再交。"]}')
    expect(r!.ok).toBe(true)
    expect(r!.did).toContain('加进验收')
    // 不像条件的:只落评论,不碰验收。
    const h2 = fakeHands()
    await run([{ name: 'supplement', card_id: 't-c323ffa6', text: '顺便看下 tick 的间隔' }], h2)
    expect(h2.calls).toEqual(['comment t-c323ffa6 顺便看下 tick 的间隔', 'carry t-c323ffa6 顺便看下 tick 的间隔'])
  })
})

describe('同一句里 supplement 先于 reassign(退修那轮派发词带得上补话)', () => {
  it('★同一张卡的 reassign + supplement:补话先落卡再改派,回话顺序照旧按清单', async () => {
    const h = fakeHands()
    const out = await run([
      { name: 'reassign', card_id: 't-c323ffa6', to: 'codex', restart: true },
      { name: 'supplement', card_id: 't-c323ffa6', text: '上一轮没带上补话,照着要求重做' },
    ], h)
    expect(h.calls[0]).toBe('comment t-c323ffa6 上一轮没带上补话,照着要求重做')
    expect(h.calls.filter(one => !one.startsWith('carry'))).toEqual([
      'comment t-c323ffa6 上一轮没带上补话,照着要求重做',
      'reassign t-c323ffa6 to=codex family=codex',
    ])
    expect(out[0]).toMatchObject({ command: 'reassign', ok: true, card_id: 't-c323ffa6' })
    expect(out[1]).toMatchObject({ command: 'supplement', ok: true, card_id: 't-c323ffa6' })
  })

  it('补话排在前面的清单顺序不变', async () => {
    const h = fakeHands()
    const out = await run([
      { name: 'supplement', card_id: 't-c323ffa6', text: '先补一句' },
      { name: 'reassign', card_id: 't-c323ffa6', to: 'codex', restart: true },
    ], h)
    expect(h.calls[0]).toBe('comment t-c323ffa6 先补一句')
    expect(h.calls.filter(one => !one.startsWith('carry'))).toEqual([
      'comment t-c323ffa6 先补一句',
      'reassign t-c323ffa6 to=codex family=codex',
    ])
    expect(out.map(one => one.command)).toEqual(['supplement', 'reassign'])
  })

  it('不同卡的命令互不相让', async () => {
    const h = fakeHands()
    await run([
      { name: 'reassign', card_id: 't-ea1e8702', to: 'kimi', restart: true },
      { name: 'supplement', card_id: 't-c323ffa6', text: '别卡的补话' },
    ], h)
    expect(h.calls[0]).toBe('reassign t-ea1e8702 to=kimi family=kimi')
    expect(h.calls[1]).toBe('comment t-c323ffa6 别卡的补话')
  })
})

describe('板上操作一张工具表', () => {
  it('rename / cancel / move_status / set_goal', async () => {
    const h = fakeHands()
    const out = await run([
      { name: 'rename', card_id: 't-c323ffa6', title: '查工作台 8791 空转热点' },
      { name: 'cancel', card_id: 't-d7eeb2ff' },
      { name: 'move_status', card_id: 't-ea1e8702', status: 'backlog' },
      { name: 'set_goal', card_id: 't-ea1e8702', goal_id: 'g-1' },
    ], h)
    expect(h.calls).toEqual([
      'update t-c323ffa6 {"title":"查工作台 8791 空转热点","titleFrom":"custom"}',
      'move t-d7eeb2ff canceled',
      'move t-ea1e8702 todo',
      'move t-ea1e8702 backlog',
      'update t-ea1e8702 {"goalId":"g-1"}',
    ])
    expect(out.every(one => one.ok)).toBe(true)
  })

  it('挪状态被账拒了:如实回原因', async () => {
    const h = fakeHands({ moveCard: async () => ({ ok: false, reason: '已完成的卡不能直接挪回进行中' }) })
    const [r] = await run([{ name: 'move_status', card_id: 't-ea1e8702', status: 'doing' }], h)
    expect(r).toMatchObject({ ok: false, why: '已完成的卡不能直接挪回进行中' })
  })

  it('目标:标达成 / 建目标 / 改截止', async () => {
    const h = fakeHands()
    const out = await run([
      { name: 'goal_status', goal_id: 'g-1', status: 'reached' },
      { name: 'goal_create', title: '下周交付', due: '2026-11-06' },
      { name: 'goal_due', goal_id: 'g-1', due: null },
    ], h)
    expect(h.calls).toEqual(['goal g-1 {"status":"reached"}', 'goal+ 下周交付 due=2026-11-06', 'goal g-1 {"due":null}'])
    expect(out.map(one => one.ok)).toEqual([true, true, true])
    expect(out[0]!.did).toContain('达成')
  })

  it('note:只建卡不派', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'note', title: '捎话自动叫醒', status: 'backlog', goal_id: 'g-1', acceptance: ['叫得醒'] }], h)
    expect(h.calls).toEqual(['create 捎话自动叫醒 status=backlog goal=g-1 acc=叫得醒'])
    expect(r).toMatchObject({ ok: true, card_id: 't-new1' })
  })
})

describe('挪状态按 statusPathTo 逐格走(卡「中枢挪状态按最短路走」)', () => {
  // 假手照 tasks.move 的规矩办:读真实转换表,合法才走、每走一格记一段 transitions。
  function walkingHands(initial: Record<string, TaskStatus>, failOn?: (to: TaskStatus) => string | undefined) {
    const statusOf: Record<string, TaskStatus> = { ...initial }
    const transitions: { id: string, from: TaskStatus, to: TaskStatus }[] = []
    const h = fakeHands({
      moveCard: async (id, status) => {
        const from = statusOf[id]
        if (from === undefined) return { ok: false }
        const checked = canTransition(from, status)
        if (!checked.ok) return { ok: false, reason: checked.reason }
        h.calls.push(`move ${id} ${status}`)
        const fail = failOn?.(status)
        if (fail !== undefined) return { ok: false, reason: fail }
        if (from !== status) {
          transitions.push({ id, from, to: status })
          statusOf[id] = status
        }
        return { ok: true }
      },
    })
    return { h, transitions, statusOf }
  }

  it('阻塞 → 完成:一句成功,照最短路经「进行中」逐格走,transitions 记两段', async () => {
    const { h, transitions } = walkingHands({ 't-ea1e8702': 'blocked' })
    const [r] = await run([{ name: 'move_status', card_id: 't-ea1e8702', status: 'done' }], h)
    expect(h.calls).toEqual(['move t-ea1e8702 doing', 'move t-ea1e8702 done'])
    expect(r).toMatchObject({ command: 'move_status', ok: true, card_id: 't-ea1e8702' })
    expect(r!.did).toContain('挪到「完成」')
    expect(r!.did).toContain('经「进行中」')
    expect(transitions).toEqual([
      { id: 't-ea1e8702', from: 'blocked', to: 'doing' },
      { id: 't-ea1e8702', from: 'doing', to: 'done' },
    ])
  })

  it('待排 → 完成:走三格(待办 → 进行中 → 完成),transitions 记三段', async () => {
    const { h, transitions } = walkingHands({ 't-8b3c1d0a': 'backlog' })
    const [r] = await run([{ name: 'move_status', card_id: 't-8b3c1d0a', status: 'done' }], h)
    expect(h.calls).toEqual(['move t-8b3c1d0a todo', 'move t-8b3c1d0a doing', 'move t-8b3c1d0a done'])
    expect(r!.ok).toBe(true)
    expect(transitions.map(one => `${one.from}->${one.to}`)).toEqual(['backlog->todo', 'todo->doing', 'doing->done'])
  })

  it('完成 → 取消:表上没路,一格都不碰,reason 用表里那句', async () => {
    const { h, transitions } = walkingHands({ 't-7f2e9b1c': 'done' })
    // done 卡不在上下文包里,原话带卡号把它点进来。
    const [r] = await run([{ name: 'move_status', card_id: 't-7f2e9b1c', status: 'canceled' }], h, '把 t-7f2e9b1c 取消掉')
    expect(h.calls).toEqual([])
    expect(transitions).toEqual([])
    expect(r).toMatchObject({ command: 'move_status', ok: false, card_id: 't-7f2e9b1c' })
    expect(r!.why).toContain('「完成」不能直接改成「取消」')
  })

  it('完成 → 进行中(重开):一句办得成,只走一格,transitions 记一段', async () => {
    const { h, transitions, statusOf } = walkingHands({ 't-7f2e9b1c': 'done' })
    // done 卡不在上下文包里,原话带卡号把它点进来 —— 在包里时走 done 分支,这才是退修要修的路。
    const [r] = await run([{ name: 'move_status', card_id: 't-7f2e9b1c', status: 'doing' }], h, '把 t-7f2e9b1c 重开回进行中')
    expect(h.calls).toEqual(['move t-7f2e9b1c doing'])
    expect(r).toMatchObject({ command: 'move_status', ok: true, card_id: 't-7f2e9b1c' })
    expect(r!.did).toContain('挪到「进行中」')
    expect(transitions).toEqual([{ id: 't-7f2e9b1c', from: 'done', to: 'doing' }])
    expect(statusOf['t-7f2e9b1c']).toBe('doing')
  })

  it('完成 → 取消:绕路(先重开再取消)照旧拒,reason 用表里那句', async () => {
    // 表上 done → doing → canceled 通,但「取消」一张完成的卡会先擦掉完成时刻、作废那一轮 —— 只拒绕路。
    const { h, transitions } = walkingHands({ 't-7f2e9b1c': 'done' })
    const [r] = await run([{ name: 'cancel', card_id: 't-7f2e9b1c' }], h)
    expect(h.calls).toEqual([])
    expect(transitions).toEqual([])
    expect(r).toMatchObject({ command: 'cancel', ok: false, card_id: 't-7f2e9b1c' })
    expect(r!.why).toContain('「完成」不能直接改成「取消」')
  })

  it('中途一格失败:停在那格,如实说停在哪、why 带 tasks.move 回的 reason', async () => {
    const { h, transitions, statusOf } = walkingHands({ 't-8b3c1d0a': 'backlog' }, to => to === 'doing' ? '挪到「进行中」那一步账没写进去' : undefined)
    const [r] = await run([{ name: 'move_status', card_id: 't-8b3c1d0a', status: 'done' }], h)
    expect(h.calls).toEqual(['move t-8b3c1d0a todo', 'move t-8b3c1d0a doing'])
    expect(r).toMatchObject({ ok: false, card_id: 't-8b3c1d0a' })
    expect(r!.did).toContain('挪到「待办」')
    expect(r!.did).toContain('没挪到「完成」')
    expect(r!.why).toContain('账没写进去')
    // 停在中间格:只走出一段,卡待在「待办」。
    expect(transitions).toEqual([{ id: 't-8b3c1d0a', from: 'backlog', to: 'todo' }])
    expect(statusOf['t-8b3c1d0a']).toBe('todo')
  })

  it('原地不动照旧办成,不碰账', async () => {
    const { h, transitions } = walkingHands({ 't-d7eeb2ff': 'todo' })
    const [r] = await run([{ name: 'move_status', card_id: 't-d7eeb2ff', status: 'todo' }], h)
    expect(h.calls).toEqual([])
    expect(transitions).toEqual([])
    expect(r).toMatchObject({ ok: true, card_id: 't-d7eeb2ff' })
  })
})

describe('user_layer_fix:派前核手;换手归派发口,中枢只派一下', () => {
  it('默认推荐的 Claude 登录过期 → 跳过,交给下一只能改本机文件的', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'user_layer_fix', said: '随手记的提示语改成「记一笔」', widget: 'quick-note' }], h)
    expect(h.calls).toEqual(['ulfix to=kimi'])
    expect(r).toMatchObject({ ok: true, who: 'Kimi', card_id: 't-ul1' })
  })
  it('派发失败不再中枢自己换手:只派一下,如实说为什么、建议下一只(真换手归派发口,按执行记录兜底)', async () => {
    let n = 0
    const h = fakeHands({ userLayerFix: async input => { n += 1; h.calls.push(`ulfix to=${input.to}${input.cardId === undefined ? '' : ` card=${input.cardId}`}`); return n === 1 ? { ok: false, id: 't-ul1', note: '起不来' } : { ok: true, id: 't-ul1' } } })
    const [r] = await run([{ name: 'user_layer_fix', said: 'x' }], h)
    // 中枢只派一下,不循环换人;换手由派发口按执行记录里的候选表兜底(起跑失败那一下它看得见)。
    expect(h.calls).toEqual(['ulfix to=kimi'])
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('起不来')
    expect(r!.next).toMatch(/换.*Codex/u)
    expect(r!.card_id).toBe('t-ul1')
  })
  it('点名的手不行:不换,说为什么', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'user_layer_fix', said: 'x', to: 'claude' }], h)
    expect(h.calls).toEqual([])
    expect(r!.ok).toBe(false)
    expect(r!.why).toContain('登录过期')
  })
})

describe('remember / feedback / ask / chat', () => {
  it('各走各的手;ask 与 chat 不碰板', async () => {
    const h = fakeHands()
    const out = await run([
      { name: 'remember', text: '派活前先核额度', scope: 'dispatch' },
      { name: 'feedback', text: '设置页打不开' },
      { name: 'ask', question: '指的是哪张?', options: ['t-ea1e8702', 't-c323ffa6'] },
      { name: 'chat', reply: '在呢。' },
    ], h)
    expect(h.calls).toEqual(['rule dispatch 派活前先核额度', 'feedback 设置页打不开'])
    expect(out[2]).toMatchObject({ command: 'ask', ok: true, ask: { question: '指的是哪张?', options: ['t-ea1e8702', 't-c323ffa6'] } })
    expect(out[3]).toMatchObject({ command: 'chat', ok: true, reply: '在呢。' })
  })
})

describe('verify:按卡上条件核一遍已交回的卡(任务书 1029)', () => {
  const PASS_TEXT = 't-d66412f5「核一遍的活」核过了,验收通过,挪到「完成」'
  const verifyHand = (calls: string[], out: { verdict: 'pass' | 'fail' | 'unknown', text: string }) => ({
    verifyAcceptance: async (id: string, input: { acceptance: readonly string[] }) => { calls.push(`verify ${id} ${input.acceptance.join('|')}`); return out },
  })

  it('① confirm 卡 + 卡上有条件 + 核过:照过,note 那句照实回', async () => {
    const calls: string[] = []
    const h = fakeHands(verifyHand(calls, { verdict: 'pass', text: PASS_TEXT }))
    const [r] = await run([{ name: 'verify', card_id: 't-d66412f5' }], h)
    expect(calls).toEqual(['verify t-d66412f5 同数|补用例'])
    expect(r).toMatchObject({ command: 'verify', ok: true, card_id: 't-d66412f5' })
    expect(r!.did).toContain('验收通过')
  })

  it('② 回执缺一条:退修那句照实回(卡回进行中、留言含缺的那条、派回原执行者都在那只手里)', async () => {
    const h = fakeHands(verifyHand([], { verdict: 'fail', text: 't-d66412f5「核一遍的活」没核过:缺补用例 —— 退修给小K(重生版)接着改了' }))
    const [r] = await run([{ name: 'verify', card_id: 't-d66412f5' }], h)
    expect(r).toMatchObject({ command: 'verify', ok: true, card_id: 't-d66412f5' })
    expect(r!.did).toContain('缺补用例')
    expect(r!.did).toContain('退修')
  })

  it('③ 卡上没条件:不动卡,回「没给验收条件」并问按什么条件核;她这句带了条件 → 先落卡再核', async () => {
    const calls1: string[] = []
    const h = fakeHands(verifyHand(calls1, { verdict: 'pass', text: PASS_TEXT }))
    const [r1] = await run([{ name: 'verify', card_id: 't-3109f7ab' }], h)
    expect(r1).toMatchObject({ command: 'verify', ok: true, card_id: 't-3109f7ab' })
    expect(r1!.ask?.question).toContain('没给验收条件')
    expect(r1!.ask?.question).toContain('要按什么条件核')
    expect(calls1).toEqual([])
    // 同句(同命令)带了条件:先落卡再核。
    const calls2: string[] = []
    const h2 = fakeHands(verifyHand(calls2, { verdict: 'pass', text: PASS_TEXT }))
    const [r2] = await run([{ name: 'verify', card_id: 't-3109f7ab', acceptance: ['同数'] }], h2)
    expect(h2.calls).toEqual(['update t-3109f7ab {"acceptance":["同数"]}'])
    expect(calls2).toEqual(['verify t-3109f7ab 同数'])
    expect(r2).toMatchObject({ command: 'verify', ok: true })
  })

  it('④ 非 confirm 的卡:拒,说清「还没交回 / 已完成」,不碰核验的手', async () => {
    const calls4: string[] = []
    const h = fakeHands(verifyHand(calls4, { verdict: 'pass', text: PASS_TEXT }))
    const [rDoing] = await run([{ name: 'verify', card_id: 't-c323ffa6' }], h)
    expect(rDoing).toMatchObject({ command: 'verify', ok: false, card_id: 't-c323ffa6' })
    expect(rDoing!.why).toContain('还没交回')
    // 已完成的卡(done 不在未结卡里,原话带卡号点进来)同样拒。
    const [rDone] = await run([{ name: 'verify', card_id: 't-7f2e9b1c' }], h, '把 t-7f2e9b1c 核一遍')
    expect(rDone).toMatchObject({ command: 'verify', ok: false, card_id: 't-7f2e9b1c' })
    expect(rDone!.why).toContain('完成')
    expect(calls4).toEqual([])
  })

  it('核不了(unknown):如实说为什么,卡不动', async () => {
    const h = fakeHands(verifyHand([], { verdict: 'unknown', text: '没有独立工作区,按产物核的那几条核不了' }))
    const [r] = await run([{ name: 'verify', card_id: 't-d66412f5' }], h)
    expect(r).toMatchObject({ command: 'verify', ok: false, card_id: 't-d66412f5' })
    expect(r!.why).toContain('核不了')
  })

  it('核验的手没接上:如实说,不动卡', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'verify', card_id: 't-d66412f5' }], h)
    expect(r).toMatchObject({ command: 'verify', ok: false })
    expect(r!.why).toContain('没接上')
    expect(h.calls).toEqual([])
  })

  it('一句点多张:一张一条 verify,互不拖累(这张核不了不拖那张过)', async () => {
    const h = fakeHands({
      verifyAcceptance: async (id: string) => { h.calls.push(`verify ${id}`); return { verdict: 'pass' as const, text: PASS_TEXT } },
    })
    const out = await run([
      { name: 'verify', card_id: 't-d66412f5' },
      { name: 'verify', card_id: 't-3109f7ab', acceptance: ['同数'] },
    ], h)
    expect(h.calls).toEqual(['verify t-d66412f5', 'update t-3109f7ab {"acceptance":["同数"]}', 'verify t-3109f7ab'])
    expect(out[0]).toMatchObject({ command: 'verify', ok: true })
    expect(out[1]).toMatchObject({ command: 'verify', ok: true })
  })
})

describe('voice:换音色(原「改」白名单里那一项,搬进命令表)', () => {
  it('照实回那一换的结果', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'voice', gender: 'female' }], h)
    expect(h.calls).toEqual(['voice female'])
    expect(r).toMatchObject({ ok: true, did: '音色换成女声了' })
  })
})

describe('任务书 1029(中枢派到窗口手不按发送)', () => {
  // ③ 「X 补一句:…」整句都是给 X 的补话:模型出一条 supplement → 只落卡,不建卡不派;
  //    只有明说「另开一张」才 supplement + dispatch 两条。
  it('③「t-X 补一句:…顺带查 Y 为什么…」→ 一条 supplement(整句进 text),不出 dispatch', async () => {
    const h = fakeHands()
    const whole = '把派发词里那条补话带上;顺带查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天'
    const [r] = await run([{ name: 'supplement', card_id: 't-c323ffa6', text: whole }], h)
    expect(h.calls).toEqual(['comment t-c323ffa6 ' + whole, 'carry t-c323ffa6 ' + whole])
    expect(h.calls.some(one => one.startsWith('create') || one.startsWith('dispatch'))).toBe(false)
    expect(r).toMatchObject({ ok: true, command: 'supplement', card_id: 't-c323ffa6' })
  })

  it('③ 明说「另开一张」→ supplement + dispatch 两条都办', async () => {
    const h = fakeHands()
    const [supplement, dispatch] = await run([
      { name: 'supplement', card_id: 't-c323ffa6', text: '把派发词里那条补话带上' },
      { name: 'dispatch', new: { title: '查两张卡为什么派发 done 还挂着' }, text: '查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天', to: 'agent:me:k1' },
    ], h)
    expect(h.calls.filter(one => one.startsWith('comment'))).toEqual(['comment t-c323ffa6 把派发词里那条补话带上'])
    expect(h.calls.some(one => one.startsWith('dispatch'))).toBe(true)
    expect(supplement).toMatchObject({ ok: true, command: 'supplement' })
    expect(dispatch).toMatchObject({ ok: true, command: 'dispatch' })
  })

  // ④ 要进仓库查根因的活(jobKindOf 认成 code)挑「能改本机文件」的手;
  //    窗口手拿不到仓库 —— 点名它也不派,说清为什么、给下一只。
  const CODE_HANDS: HubHand[] = [
    { id: 'claude', title: 'Claude', family: 'claude', card: false, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true, recommended: true },
    { id: 'doubao', title: '豆包', family: 'doubao', card: false, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: false },
    { id: 'agent:me:k1', title: '小K(重生版)', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true },
  ]
  const CODE_TEXT = '查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天'
  function codeCtx() {
    return buildContext({ said: '', entrance: 'desktop', now: NOW, says: [], hands: CODE_HANDS, widgets: [], tasks: [], goals: [] })
  }
  async function runCode(commands: HubCommand[], hands: HubHands) {
    return executeCommands(commands, codeCtx(), hands, { said: CODE_TEXT })
  }

  it('④ 查卡号根因的活是 code:点名窗口手(豆包,拿不到仓库)→ 不派,说「改不了本机文件」并给下一只', async () => {
    const h = fakeHands()
    const [r] = await runCode([{ name: 'dispatch', new: { title: '查两张卡为什么挂一天' }, text: CODE_TEXT, to: 'doubao' }], h)
    expect(h.calls.some(one => one.startsWith('dispatch'))).toBe(false)
    expect(r).toMatchObject({ ok: false })
    expect(r!.why).toContain('改不了本机文件')
    expect(r!.next).toBeDefined()
  })

  it('④ 没点名:跳过窗口手,挑能改本机文件的(默认推荐 Claude)', async () => {
    const h = fakeHands()
    const [r] = await runCode([{ name: 'dispatch', new: { title: '查两张卡为什么挂一天' }, text: CODE_TEXT }], h)
    expect(h.calls).toEqual(['create 查两张卡为什么挂一天 status=todo who=claude', 'dispatch t-new1 to=claude'])
    expect(r).toMatchObject({ ok: true, who: 'Claude' })
  })

  it('④ 点名的就是能改本机文件的(小K)→ 照派', async () => {
    const h = fakeHands()
    const [r] = await runCode([{ name: 'dispatch', new: { title: '查两张卡为什么挂一天' }, text: CODE_TEXT, to: 'agent:me:k1' }], h)
    expect(h.calls).toEqual(['create 查两张卡为什么挂一天 status=todo who=agent:me:k1', 'dispatch t-new1 to=agent:me:k1'])
    expect(r).toMatchObject({ ok: true, who: '小K(重生版)' })
  })

  it('④ 改派同一张卡:卡上的活是查根因(带卡号),改派给窗口手也拒(同一判据)', async () => {
    const h = fakeHands()
    const ctx = buildContext({
      said: '', entrance: 'desktop', now: NOW, says: [], hands: CODE_HANDS, widgets: [], goals: [],
      tasks: [{ id: 't-c323ffa6', title: '查 t-7ba4acd2 为什么派发 done 还挂在进行中', status: 'todo', updated_at: iso }],
    })
    const [r] = await executeCommands([{ name: 'reassign', card_id: 't-c323ffa6', to: 'doubao', restart: true }], ctx, h, { said: '改派给豆包' })
    expect(h.calls).toEqual([])
    expect(r).toMatchObject({ ok: false, command: 'reassign' })
    expect(r!.why).toContain('改不了本机文件')
  })

  it('④ 不是在窗口里问一句的活(无卡号):照旧走窗口,不受影响', async () => {
    const h = fakeHands()
    const [r] = await run([{ name: 'dispatch', new: { title: '查一下国庆放几天' }, text: '查一下国庆放几天', to: 'kimi' }], h)
    expect(r).toMatchObject({ ok: true })
    expect(h.calls).toEqual(['create 查一下国庆放几天 status=todo who=kimi', 'dispatch t-new1 to=kimi'])
  })
})

describe('一条失败不拖累其余', () => {
  it('手抛错 → 那一条 ok:false,后面照办', async () => {
    const h = fakeHands({ moveCard: async () => { throw new Error('boom') } })
    const out = await run([{ name: 'cancel', card_id: 't-d7eeb2ff' }, { name: 'rename', card_id: 't-c323ffa6', title: 'x' }], h)
    expect(out[0]!.ok).toBe(false)
    expect(out[1]!.ok).toBe(true)
  })
})
