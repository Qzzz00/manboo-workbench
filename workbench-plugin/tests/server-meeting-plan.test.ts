// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEETING_CARD_DAILY_CALLS, createMeetingService } from '../src/server/meeting.ts'
import { MEETING_ORGANIZER_ASK, PREP_FILE_NAME, type MeetingFact } from '../src/server/meetingPrep.ts'

/** 2026-10-10 上午 10:00(本机时区)。 */
const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime()

const FACTS: MeetingFact[] = [{ id: 'f1', text: '账号「小鱼日记」近7天:净涨粉 32', source: '小红书创作者数据(2026-10-09 取)' }]
const CARD = JSON.stringify([
  { q: '最近涨粉怎么样?', fact: 'f1', line: '近七天净涨粉 32。', fallback: '细的我会后补。' },
  { q: '预算多少?', fact: null, line: '要看这次谈的结果。', fallback: '' },
  { q: '转化率?', fact: null, line: '大概 15%。', fallback: '' },
])

function svc(over: { chat?: (prompt: string) => Promise<string>, workdir?: string | undefined, cap?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-meeting-plan-'))
  const prompts: string[] = []
  const workdir = 'workdir' in over ? over.workdir : join(root, 'repo')
  const service = createMeetingService({
    file: join(root, 'meetings.json'),
    workdir: () => workdir,
    transcribe: async () => '一句话。',
    chat: over.chat ?? (async (prompt) => { prompts.push(prompt); return CARD }),
    facts: async () => FACTS,
    now: () => NOW,
    ...(over.cap === undefined ? {} : { cardDailyCalls: over.cap }),
  })
  return { service, prompts, root }
}

async function answerAll(service: ReturnType<typeof svc>['service'], id: string, goal = '下季度投放预算定个数') {
  await service.answer({ id, question: 'kind', answer: '谈判会' })
  await service.answer({ id, question: 'people', answer: 'B客户拍板,小鱼执行' })
  await service.answer({ id, question: 'my_role', answer: '汇报人' })
  return await service.answer({ id, question: 'goal', answer: goal })
}

describe('一句话登记一场会', () => {
  it('落成一场「待开的会」:不在最近几场里,在 upcoming 里;那句话认得出的已经填了', async () => {
    const { service } = svc()
    const got = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    expect(got.ok).toBe(true)
    expect(got.note).toContain('记下了')
    expect(got.note).toContain('什么类型的会')
    const view = await service.view()
    expect(view.recent).toHaveLength(0)
    expect(view.upcoming?.[0]?.status).toBe('planned')
    expect(view.upcoming?.[0]?.prep?.scope).toEqual({ value: '外部', from: 'said' })
    expect(view.upcoming?.[0]?.prep?.ask?.id).toBe('kind')
    expect(view.upcoming?.[0]?.prep?.card_status).toBe('answers')
  })

  it('答完五问 → 自动做预案卡(一次模型调用);数按编号原样填、带出处;会前.md 落在这场会的目录里', async () => {
    const { service, prompts } = svc()
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    const done = await answerAll(service, meeting!.id)
    expect(done.note).toContain('预案卡在做')
    await service.idle()
    const view = await service.get(meeting!.id)
    expect(prompts).toHaveLength(1)
    expect(view?.prep?.card_status).toBe('ready')
    expect(view?.prep?.card?.questions).toHaveLength(2) // 「15%」那条编了数,整条不要
    expect(view?.prep?.card?.questions[0]?.number?.source).toBe('小红书创作者数据(2026-10-09 取)')
    expect(view?.prep?.card?.questions[1]?.none).toBe(true)
    const md = readFileSync(join(view!.dir!, PREP_FILE_NAME), 'utf8')
    expect(md).toContain('预案卡')
    expect(md).toContain('B客户(拍板)')
  })

  it('目的说不清 → 先拦:不做预案卡,替她拟一句问话;点「先照现在的准备」才做', async () => {
    const { service, prompts } = svc()
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    const blocked = await answerAll(service, meeting!.id, '说不清')
    expect(blocked.note).toContain(MEETING_ORGANIZER_ASK)
    expect(blocked.note).toContain('发不发由你')
    await service.idle()
    let view = await service.get(meeting!.id)
    expect(view?.prep?.card_status).toBe('goal')
    expect(view?.prep?.organizer_ask).toBe(MEETING_ORGANIZER_ASK)
    expect(prompts).toHaveLength(0)
    await service.card({ id: meeting!.id, proceed: true })
    await service.idle()
    view = await service.get(meeting!.id)
    expect(view?.prep?.card_status).toBe('ready')
    expect(prompts[0]).toContain('她还没问清')
  })

  it('不给 id 的回答(电话里)→ 答的是最近那场还在问的会', async () => {
    const { service } = svc()
    await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    const got = await service.answer({ answer: '谈判会' })
    expect(got.ok).toBe(true)
    expect(got.meeting?.prep?.kind).toEqual({ value: '谈判会', from: 'asked' })
    expect(got.note).toContain('谁来')
  })

  it('答「谁来」→ 花名进档案(她电脑上);下次同一个花名,谁来从记录认出;档案能看、能删', async () => {
    const { service } = svc()
    const first = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    await answerAll(service, first.meeting!.id)
    await service.idle()
    expect((await service.people()).map(p => p.alias)).toEqual(['B客户', '小鱼'])
    const second = await service.plan({ text: '下周二下午两点跟 B 客户再对一下' })
    expect(second.meeting?.prep?.people?.from).toBe('record')
    expect(second.meeting?.prep?.decider?.value).toBe('B客户')
    expect((await service.forgetPerson('小鱼')).ok).toBe(true)
    expect((await service.people()).map(p => p.alias)).toEqual(['B客户'])
  })

  it('模型每天有上限:到了就不再调,说清楚', async () => {
    const { service, prompts } = svc({ cap: 1 })
    const a = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    await answerAll(service, a.meeting!.id)
    await service.idle()
    await service.card({ id: a.meeting!.id })
    await service.idle()
    expect(prompts).toHaveLength(1)
    const view = await service.get(a.meeting!.id)
    expect(view?.prep?.card_error).toContain('上限')
    expect(view?.prep?.card?.questions.length).toBeGreaterThan(0) // 旧卡还在
    expect(MEETING_CARD_DAILY_CALLS).toBeGreaterThan(0)
  })

  it('模型没接上 → 画像照存,卡没做成说清为什么', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-meeting-plan-'))
    const service = createMeetingService({ file: join(root, 'm.json'), workdir: () => join(root, 'repo'), now: () => NOW })
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈,要敲定下季度报价' })
    await service.answer({ id: meeting!.id, question: 'kind', answer: '谈判会' })
    await service.answer({ id: meeting!.id, question: 'people', answer: 'B客户拍板' })
    await service.answer({ id: meeting!.id, question: 'my_role', answer: '汇报人' })
    await service.idle()
    const view = await service.get(meeting!.id)
    expect(view?.prep?.card_status).toBe('failed')
    expect(view?.prep?.card_error).toContain('模型')
  })
})

describe('开录接到同一场', () => {
  it('带 plan_id 开录 → 还是那一场(同一个 id、同一个目录),状态改成在录', async () => {
    const { service } = svc()
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈,要敲定下季度报价' })
    await service.answer({ id: meeting!.id, question: 'kind', answer: '谈判会' })
    await service.answer({ id: meeting!.id, question: 'people', answer: 'B客户拍板' })
    await service.answer({ id: meeting!.id, question: 'my_role', answer: '汇报人' })
    await service.idle()
    const planned = await service.get(meeting!.id)
    const started = await service.start({ title: '', client_key: 'k1', plan_id: meeting!.id })
    expect(started.id).toBe(meeting!.id)
    expect(started.dir).toBe(planned?.dir)
    expect(existsSync(join(started.dir!, '录音'))).toBe(true)
    const view = await service.get(meeting!.id)
    expect(view?.status).toBe('recording')
    expect(view?.prep?.goal?.value).toBe('敲定下季度报价')
    expect((await service.view()).upcoming).toHaveLength(0)
    // 同一个 client_key 重发 → 还是它
    expect((await service.start({ client_key: 'k1', plan_id: meeting!.id })).id).toBe(meeting!.id)
  })

  it('撤掉一场待开的会(她说「这不是会」):只撤还没开录的,不碰任何文件', async () => {
    const { service } = svc()
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈下季度合作' })
    expect((await service.drop(meeting!.id)).ok).toBe(true)
    expect((await service.view()).upcoming).toHaveLength(0)
    const started = await service.start({ title: '周会' })
    expect((await service.drop(started.id!)).ok).toBe(false)
  })
})

describe('会后:要定的定下来没有(先存,给以后的学习)', () => {
  it('存 yes / partly / no 与一句话;认不出的值不收', async () => {
    const { service } = svc()
    const { meeting } = await service.plan({ text: '下午三点跟 B 客户谈,要敲定下季度报价' })
    await service.start({ client_key: 'k', plan_id: meeting!.id })
    expect((await service.outcome({ id: meeting!.id, settled: 'maybe' })).ok).toBe(false)
    expect((await service.outcome({ id: meeting!.id, settled: 'partly', said: '报价定了,排期下周再说' })).ok).toBe(true)
    const view = await service.get(meeting!.id)
    expect(view?.outcome).toMatchObject({ settled: 'partly', said: '报价定了,排期下周再说' })
    expect(view?.prep?.goal?.value).toBe('敲定下季度报价')
  })
})
