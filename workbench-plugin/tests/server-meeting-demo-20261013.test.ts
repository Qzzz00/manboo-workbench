// @vitest-environment node
/**
 * 三场演示用的历史会(2026-10-13,卡「会议页不再空着」)。维护者原话:
 * 「会议里还是空的,我想的是会议里要有一些方便演示的历史会议案例,一样按照会前会中会后三个来看」。
 *
 * 这份用例钉三件事:
 *
 * 1. **走的是真路**:`plan` 登记 → `answer` 答五问(预案卡自己排上去)→ `import` 用现成的转写出纪要。
 *    产物与真会同形:同一份 `会议/<日期>-<标题>/`、`会前.md` + `转写.md` + `纪要.md`、同一批待办。
 *    会前与会后在**同一个会议对象**上(同一个 id)—— 手机上才翻得出会前 / 会中 / 会后三段。
 * 2. **重复点不重复放**:同一天同名的会已经有了就跳过,模型一次都不再问。
 * 3. **样例材料配得上第 9 条那道闸**:每场转写里本来就有的行动项(`nextSteps`)里的人名与期限,
 *    在转写里都找得到 —— 否则纪要出来会被整条丢掉。样例一改,这条当场红。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEETING_NO_WORKDIR, createMeetingService } from '../src/server/meeting.ts'
import { MEETING_DEMO_CASES, MEETING_DEMO_FROM, MEETING_DEMO_TAG } from '../src/server/meetingDemoCases.ts'
import { MEETING_SECTIONS, MEETING_TOPIC_FIELDS, evidenceOf } from '../src/server/meetingText.ts'
import { answerPrep, draftMeetingPlan, nextPrepAsk } from '../src/server/meetingPrep.ts'
import { meetingItem } from '../src/server/butlerInbox.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW = Date.parse('2026-10-13T06:00:00.000Z')

function tempHome(): { file: string, workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb-meeting-demo-'))
  return { file: join(root, 'meetings.json'), workdir: join(root, 'repo') }
}

/** 预案卡那一次的回话。**一个数字都不写**:数由代码按编号填,凭空的数会被整条丢掉。 */
const CARD_REPLY = JSON.stringify([
  { q: '这条为什么值得做', fact: null, line: '我按手上的情况说一遍思路。', fallback: '这个我会后给您补一份。' },
  { q: '排期上能不能更早', fact: null, line: '我按现在排的说,挪动要连拍摄一起看。', fallback: '这个我会后给您补一份。' },
  { q: '数据上怎么支撑', fact: null, line: '我手上这几条的情况我来说。', fallback: '这个我会后给您补一份。' },
])

/**
 * 梳理那一次的回话:**下一步照样例里写的那几条抄**,再加一条编出来的人
 * (「阿杏」三场转写里都没有)—— 它应当被程序整条丢掉。
 */
function notesReplyFor(prompt: string): string {
  const one = MEETING_DEMO_CASES.find(demo => prompt.includes(demo.title))
  if (one === undefined) throw new Error(`这段提示不像是三场演示里的任何一场:${prompt.slice(0, 40)}`)
  return [
    `## ${MEETING_SECTIONS.solved}`,
    `- ${one.title}:该定的定了`,
    `## ${MEETING_SECTIONS.topic}:${one.title}的头一件事`,
    `### ${MEETING_TOPIC_FIELDS.discussed}`,
    '- 把情况过了一遍',
    `### ${MEETING_TOPIC_FIELDS.claims}`,
    '- [已确定] 该定的那一条定了',
    '- [初步想法] 另一条只是想法',
    `### ${MEETING_TOPIC_FIELDS.why}`,
    '- 手上只有这一条,说明不了更多',
    `## ${MEETING_SECTIONS.keep}`,
    '- 定了的那一条照做',
    `## ${MEETING_SECTIONS.next}`,
    ...one.nextSteps.map(step => `- ${step.who ?? ''}|把这一条办掉|${step.due}`),
    '- 阿杏|跟剪辑对一下片头|后天上午',
    `## ${MEETING_SECTIONS.unsure}`,
    '- 有一句没听清是哪个场地',
  ].join('\n')
}

function svc(over: { workdir?: () => string | undefined, chat?: ((prompt: string) => Promise<string>) | undefined } = {}) {
  const { file, workdir } = tempHome()
  const prompts: string[] = []
  const chat = 'chat' in over
    ? over.chat
    : async (prompt: string): Promise<string> => (prompt.includes('预案卡') ? CARD_REPLY : notesReplyFor(prompt))
  const deps = {
    file,
    workdir: over.workdir ?? (() => workdir),
    now: () => NOW,
    tasks: createTasksService({ file: join(workdir, 'tasks.json') }),
    ...(chat === undefined ? {} : { chat: async (prompt: string) => { prompts.push(prompt); return await chat(prompt) } }),
  }
  return { service: createMeetingService(deps as unknown as Parameters<typeof createMeetingService>[0]), workdir, prompts }
}

describe('放三场演示用的会', () => {
  it('★ 三场都走真路:会前五问 + 预案卡 + 转写出的纪要落在同一场、同一个目录里', async () => {
    const { service, workdir, prompts } = svc()
    const seeded = await service.seedDemo()
    expect(seeded.ok).toBe(true)
    expect(seeded.cases).toHaveLength(MEETING_DEMO_CASES.length)
    expect(seeded.cases.every(one => one.skipped === undefined)).toBe(true)
    await service.idle()

    // 一场两次模型调用(一张预案卡 + 一份纪要),三场共六次 —— 这是「放一下要花多少钱」那笔账。
    expect(prompts).toHaveLength(MEETING_DEMO_CASES.length * 2)

    for (const [at, one] of MEETING_DEMO_CASES.entries()) {
      const seededCase = seeded.cases[at]!
      expect(seededCase.title).toBe(one.title)
      const view = await service.get(seededCase.id ?? '')
      expect(view, `${one.title} 没放成`).toBeDefined()
      expect(view!.title).toBe(one.title)
      expect(view!.date).toBe('2026-10-13')
      expect(view!.status).toBe('done')
      expect(view!.demo).toBe(true)
      expect(view!.dir).toBe(join(workdir, '会议', `2026-10-13-${one.title}`))

      // 会前:五问齐了(没有还在问的那一问)、预案卡好了、会前.md 落了盘
      expect(view!.prep?.said).toBe(one.said)
      expect(view!.prep?.ask).toBeUndefined()
      expect(view!.prep?.card_status).toBe('ready')
      expect(view!.prep?.card?.questions.length).toBeGreaterThan(0)
      expect(existsSync(join(view!.dir!, '会前.md'))).toBe(true)

      // 会中:没有录音(转写是现成的),但转写里的时间戳摆出了一条时间线
      expect(view!.segments).toBe(0)
      expect(existsSync(join(view!.dir!, '录音'))).toBe(false)
      expect(view!.timeline?.length).toBeGreaterThan(2)
      expect(view!.timeline?.[0]?.at).toBe('00:00:00')

      // 会后:转写原样落盘(文件头如实说是演示样例)、纪要按规则分段、待办是转写里本来有的那几条
      const transcript = readFileSync(join(view!.dir!, '转写.md'), 'utf8')
      expect(transcript).toContain(MEETING_DEMO_FROM)
      expect(transcript).toContain(one.transcript.split('\n')[0]!)
      const notes = readFileSync(join(view!.dir!, '纪要.md'), 'utf8')
      expect(notes).toContain(`# ${one.title} · 纪要`)
      expect(notes).toContain(MEETING_SECTIONS.keep)
      expect(view!.summary).toContain(MEETING_SECTIONS.solved)
      // 编出来的那个人(阿杏)整条没留,样例里本来有的那几条都在
      expect(view!.todos).toHaveLength(one.nextSteps.length)
      expect(view!.todos.map(todo => todo.due)).toEqual(one.nextSteps.map(step => step.due))
      expect(view!.todos.map(todo => todo.who)).toEqual(one.nextSteps.map(step => step.who))
      expect(notes).toContain('阿杏')
    }
  })

  it('三场都进「最近几场」、按进来的时刻倒序;一场都不留在「待开的会」里', async () => {
    const { service } = svc()
    await service.seedDemo()
    await service.idle()
    const view = await service.view()
    expect(view.recent.map(one => one.title).sort()).toEqual(MEETING_DEMO_CASES.map(one => one.title).sort())
    expect(view.recent.every(one => one.demo === true)).toBe(true)
    // 真会与导进来的会在同一个列表里,新的在前(用例里三场的时刻是同一个,所以这里只核没乱序)
    const times = view.recent.map(one => one.started_at)
    expect([...times].sort().reverse()).toEqual(times)
    // 会前登记那一步过去了:它们不再是「待开的会」(不然手机首页会一直亮着点)
    expect(view.upcoming ?? []).toHaveLength(0)
  })

  it('★ 再点一次:三场都跳过,一个新目录都不建、模型一次都不问', async () => {
    const { service, prompts } = svc()
    await service.seedDemo()
    await service.idle()
    const before = prompts.length
    const ids = (await service.view()).recent.map(one => one.id)

    const again = await service.seedDemo()
    await service.idle()
    expect(again.ok).toBe(true)
    expect(again.cases.every(one => one.skipped === true)).toBe(true)
    expect(prompts).toHaveLength(before)
    expect((await service.view()).recent.map(one => one.id)).toEqual(ids)
  })

  it('工作目录没配:当场拒,和开一场会说同一句话(不猜一个路径)', async () => {
    const { service } = svc({ workdir: () => undefined })
    const seeded = await service.seedDemo()
    expect(seeded.ok).toBe(false)
    expect(seeded.error).toBe(MEETING_NO_WORKDIR)
    expect(seeded.cases).toHaveLength(0)
    expect((await service.view()).recent).toHaveLength(0)
  })

  it('模型没接上:会前画像、转写与时间线都在,预案卡和纪要如实说没做成(不编一份)', async () => {
    const { service } = svc({ chat: undefined })
    const seeded = await service.seedDemo()
    expect(seeded.ok).toBe(true)
    await service.idle()
    const view = await service.get(seeded.cases[0]?.id ?? '')
    expect(view?.prep?.ask).toBeUndefined()
    expect(view?.prep?.card_status).toBe('failed')
    expect(view?.prep?.card_error).toContain('模型服务没接上')
    expect(view?.summary).toBeUndefined()
    expect(view?.error).toContain('模型服务没接上')
    // 转写在盘上,会中那条时间线也在(她至少能顺着时间看这一场讲到哪儿)
    expect(existsSync(join(view?.dir ?? '', '转写.md'))).toBe(true)
    expect(view?.timeline?.length).toBeGreaterThan(2)
  })

  it('电脑收件箱那一档说得出这是演示用的(不冒充真会)', async () => {
    const { service } = svc()
    await service.seedDemo()
    await service.idle()
    const latest = (await service.view()).recent[0]!
    expect(meetingItem(latest)?.note).toContain(MEETING_DEMO_TAG)
  })

  it('勾着建事项照旧(待办与真会同一条路)', async () => {
    const { service } = svc()
    const seeded = await service.seedDemo()
    await service.idle()
    const id = seeded.cases[0]?.id ?? ''
    const applied = await service.apply(id, [])
    expect(applied.ok).toBe(true)
    expect(applied.created.length).toBe(MEETING_DEMO_CASES[0]!.nextSteps.length)
    expect((await service.get(id))?.todos.every(todo => todo.task_id !== undefined)).toBe(true)
  })
})

describe('三场样例自己要站得住', () => {
  it('★ 每场转写里本来就有的行动项:人名与期限在转写里都找得到(第 9 条那道闸不会丢掉它们)', () => {
    for (const one of MEETING_DEMO_CASES) {
      const evidence = evidenceOf(one.transcript)
      for (const step of one.nextSteps) {
        for (const part of [step.who, step.due]) {
          if (part === undefined) continue
          expect(evidence.includes(evidenceOf(part)), `「${one.title}」的转写里没有「${part}」`).toBe(true)
        }
      }
      // 三场里至少各有一条**没说谁**的下一步 / 或明确的负责人 —— 两种都要有人演
      expect(one.nextSteps.length).toBeGreaterThan(1)
    }
    expect(MEETING_DEMO_CASES.some(one => one.nextSteps.some(step => step.who === undefined))).toBe(true)
  })

  it('标题就是登记那句话里切出来的那一截(不是另起一个名字)', () => {
    for (const one of MEETING_DEMO_CASES) {
      expect(draftMeetingPlan(one.said, NOW).title).toBe(one.title)
      expect(draftMeetingPlan(one.said, NOW).date).toBe('2026-10-13')
    }
  })

  it('五问:样例给的答案够把那一场问完(不会停在某一问上)', () => {
    for (const one of MEETING_DEMO_CASES) {
      let prep = draftMeetingPlan(one.said, NOW).prep
      const asked: string[] = []
      for (let round = 0; round < 8; round += 1) {
        const ask = nextPrepAsk(prep)
        if (ask === undefined) break
        asked.push(ask.id)
        const reply = one.answers[ask.id]
        expect(reply, `「${one.title}」少了「${ask.text}」这一问的答案`).toBeDefined()
        const got = answerPrep(prep, ask.id, reply!)
        expect(got.ok, `「${one.title}」的「${ask.text}」这一答没被收下`).toBe(true)
        if (!got.ok) break
        prep = got.prep
      }
      expect(asked.length).toBeGreaterThan(0)
      expect(nextPrepAsk(prep), `「${one.title}」还停在一问上`).toBeUndefined()
      // 样例里写了答案、却没有谁问过的那一问 = 白写的(答案与问法走漂了会在这里露出来)
      expect([...Object.keys(one.answers)].sort()).toEqual([...asked].sort())
    }
  })

  it('三场都不写联系方式、不写凭据(花名制那条纪律)', () => {
    for (const one of MEETING_DEMO_CASES) {
      const text = `${one.said}\n${one.transcript}`
      expect(text).not.toMatch(/@|\d{6,}|微信|手机号|邮箱/)
      expect(text).not.toMatch(/密码|token|密钥/i)
    }
  })
})
