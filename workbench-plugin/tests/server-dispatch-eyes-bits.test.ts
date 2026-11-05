// @vitest-environment node
/**
 * 卡 O「派活的眼睛」挂在别人模块上的几小块(2026-09-25):
 *
 * - 派活读回答时剥掉「Show more」「显示更多」这类折叠键的字(引导落地派的第一件,交付物开头夹着「Show more」);
 * - DSH 会话 feed 记下每条会话用的模型、调了几次模型、**在跑**了多久(等他批的那段不算)—— 上限用它算;
 * - 事项生命周期:这一次「被停了」是工作台自己停的(到上限 / 停掉这一件)→ 照那张单子挪,不写「你停了它」;
 * - 规矩表按标题收「引导里」的那一条(与统筹手加的「派活默认分工」去重,他删过的不再加);
 * - 看板存 `dispatch_block` / `budget` 两格,坏形状进不了盘。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dispatchPrompt, extractReply } from '../src/server/dispatchReply.ts'
import { createDshSessionFeed } from '../src/server/dshSessionFeed.ts'
import { createButlerLifecycle } from '../src/server/butlerLifecycle.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createTasksService, sanitizeBudget, sanitizeDispatchBlock } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-eyes-'))
  dirs.push(dir)
  return dir
}

describe('派活读回答:剥掉折叠键的字', () => {
  it('★引导落地派的第一件(Codex,t-371c3ba9):「Show more」是单独一截,拼句时不再粘到回答开头', () => {
    const prompt = dispatchPrompt({ taskId: 't-371c3ba9', said: '接着把参赛网页架构剩下的补完' })
    const texts = [
      '【工作台派活 371c3b】接着把参赛网页架构剩下的补完',
      '(这是工作台转交的活,做完直接回结果,我在手机上看。)',
      '13:58',
      'Show more',
      '已接着原有11屏补完导航、异常回退和构建校验,并修复字体重复下载。',
      '改动涉及网页入口、样式、翻页与粒子脚本、构建脚本、测试及交接文档。',
      '显示更多',
    ]
    expect(extractReply(texts, { family: 'codex', prompt }).text).toBe('已接着原有11屏补完导航、异常回退和构建校验,并修复字体重复下载。\n改动涉及网页入口、样式、翻页与粒子脚本、构建脚本、测试及交接文档。')
  })

  it('折叠键的字挤在同一截里:只剥开头那几个字,回答照留', () => {
    const prompt = dispatchPrompt({ taskId: 't-1', said: '说一下' })
    const texts = ['【工作台派活 1】说一下', 'Show more已接着原有11屏补完导航。']
    expect(extractReply(texts, { family: 'codex', prompt }).text).toBe('已接着原有11屏补完导航。')
  })
})

describe('DSH 会话 feed:模型、调了几次、在跑多久', () => {
  it('★等他批的那一段不算她在跑;一回合结束停表;记下最近一次请求的模型', () => {
    let now = 1_000
    const feed = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {}, now: () => now })
    const activity: string[] = []
    const withActivity = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {}, now: () => now, onActivity: id => activity.push(id) })
    for (const one of [feed, withActivity]) {
      one.handleEvent('s-1', { type: 'turn/start' })
      one.handleEvent('s-1', { type: 'request/header', data: { header: { config: { provider: 'workbench-relay', model: 'deepseek-v4-flash' } } } })
      one.handleEvent('s-1', { type: 'step/start' })
    }
    now = 1_060 // 跑了 1 分钟
    feed.handleEvent('s-1', { type: 'approval/asked' })
    now = 1_660 // 等他批了 10 分钟
    feed.handleEvent('s-1', { type: 'approval/decided' })
    feed.handleEvent('s-1', { type: 'step/start' })
    now = 1_780 // 又跑了 2 分钟
    expect(feed.usage('s-1')).toMatchObject({ model: 'deepseek-v4-flash', steps: 2, running: true, run_ms: 180_000 })
    feed.handleEvent('s-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    now = 5_000
    expect(feed.usage('s-1')).toMatchObject({ running: false, run_ms: 180_000 })
    feed.handleProjection('s-1', 'tokenUsage', { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 })
    expect(feed.usage('s-1')?.tokenUsage).toEqual({ uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 })
    expect(feed.usage('nope')).toBeUndefined()
    // 一回合开始、调一次模型:叫上限那一层看一眼
    expect(activity).toEqual(['s-1', 's-1'])
  })
})

describe('事项生命周期:工作台自己停的,照单子挪', () => {
  it('★到上限停下来的:挪到「阻塞 · 等你输入」、卡上是那一句,不是「你停了它」;单子取一次就销', async () => {
    const dir = tmp()
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => 't-1' })
    await tasks.create({ title: '修首页球', status: 'todo', direction: 'mine' })
    await tasks.update('t-1', { conversation: { agent: 'dsh', session_id: 's-1' } })
    await tasks.move('t-1', 'doing')
    const orders = new Map([['s-1', { status: 'blocked' as const, blockReason: 'input' as const, note: '到上限了,先停下来了' }]])
    const lifecycle = createButlerLifecycle({
      tasks,
      expectedAbort: (sessionId) => { const one = orders.get(sessionId); orders.delete(sessionId); return one },
    })
    await lifecycle.handleSessionEnd('s-1', { kind: 'aborted', ts: Math.floor(Date.now() / 1000) - 60 })
    const task = (await tasks.list()).tasks[0]
    expect(task).toMatchObject({ status: 'blocked', block_reason: 'input', note: '到上限了,先停下来了' })
    // 再来一次「被停了」(他自己按的停止键):单子已经销了 → 老行为
    await tasks.move('t-1', 'doing')
    await lifecycle.handleSessionEnd('s-1', { kind: 'aborted', ts: Math.floor(Date.now() / 1000) + 5 })
    expect((await tasks.list()).tasks[0]).toMatchObject({ status: 'todo', note: '你停了它' })
  })
})

describe('规矩表:按标题收「引导里」那一条', () => {
  const TEXT = '派活默认分工:写代码的活派 Claude;综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'
  async function rules() {
    const service = createRulesService({ file: join(tmp(), 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
    await service.load()
    return service
  }

  it('没有 → 新记一条,来源「引导」;再来一次不重复', async () => {
    const service = await rules()
    const first = await service.adoptTitled({ title: '派活默认分工', text: TEXT, said: 'Claude 擅长写代码' })
    expect(first).toMatchObject({ ok: true, added: true })
    expect(first.rule).toMatchObject({ title: '派活默认分工', origin: 'onboarding', area: 'all', status: 'active' })
    expect(first.rule?.evidence[0]).toMatchObject({ channel: 'onboarding', text: 'Claude 擅长写代码' })
    expect(service.hasTitled('派活默认分工')).toBe(true)
    const again = await service.adoptTitled({ title: '派活默认分工', text: TEXT, said: 'x' })
    expect(again).toMatchObject({ ok: true, added: false })
    expect(service.view().rules.length).toBe(1)
  })

  it('★统筹手加的那一条在:不改他的字,只多记一条「引导里」的依据;他删过的不再加', async () => {
    const service = await rules()
    const manual = '派活默认分工:写代码的活派 Claude(他的主力,额度 Max 二十倍);综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'
    const added = await service.add({ text: manual, channel: 'butler' })
    expect(added.ok).toBe(true)
    const adopted = await service.adoptTitled({ title: '派活默认分工', text: TEXT, said: '引导里的原话' })
    expect(adopted).toMatchObject({ ok: true, added: false })
    const only = service.view().rules
    expect(only.length).toBe(1)
    expect(only[0]?.text).toBe(manual)
    expect(only[0]?.evidence.map(one => one.channel)).toEqual(['butler', 'onboarding'])
    if (added.ok) await service.remove(added.rule.id)
    const afterRemove = await service.adoptTitled({ title: '派活默认分工', text: TEXT, said: 'x' })
    expect(afterRemove.note).toContain('你删过')
    expect(service.view().rules.length).toBe(0)
  })
})

describe('看板:两格新字段的体检', () => {
  it('dispatch_block / budget:好形状留,坏形状整格丢(卡照留)', async () => {
    expect(sanitizeDispatchBlock({ family: 'claude', kind: 'code', why: '没登录', fix: { kind: 'login_cli', family: 'claude', label: '帮我接上' }, at: 'x' }))
      .toMatchObject({ family: 'claude', fix: { label: '帮我接上' } })
    expect(sanitizeDispatchBlock({ family: 'wechat', kind: 'code', why: 'x' })).toBeUndefined()
    expect(sanitizeBudget({ limit_cny: 0.5, limit_minutes: 10, state: 'paused', spent_cny: 0.52 })).toMatchObject({ state: 'paused', spent_cny: 0.52 })
    expect(sanitizeBudget({ limit_cny: 0, limit_minutes: 10, state: 'paused' })).toBeUndefined()
    const dir = tmp()
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => 't-1' })
    await tasks.create({ title: 'x', status: 'todo' })
    await tasks.update('t-1', { dispatchBlock: { family: 'claude', kind: 'code', why: '没登录', at: 'x' }, budget: { limit_cny: 0.5, limit_minutes: 10, state: 'running' } })
    expect((await tasks.list()).tasks[0]).toMatchObject({ dispatch_block: { why: '没登录' }, budget: { state: 'running' } })
    await tasks.update('t-1', { dispatchBlock: null })
    expect((await tasks.list()).tasks[0]?.dispatch_block).toBeUndefined()
  })
})
