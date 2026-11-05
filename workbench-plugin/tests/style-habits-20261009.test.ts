// @vitest-environment node
/**
 * 从她的话里学风格(2026-10-09,卡「学风格」;设计 `docs/设计-事务官从她的行为里学-2026-10-09.md` 第三节第 3 条、第四节第 3 张)。
 *
 * 模型只做一件事:读原话,从一张固定的风格维度表里挑候选,并摘原话当证据(认不出就不提)。
 * 计数、试用、验证、撤回全在代码:不同的两件事上出现同一候选才试用;试用里下一次交付她没再这么说 = 留,又说了 = 撤。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BEHAVIOR_EVENTS, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import { EVOLVE_LOG_NAME } from '../src/server/evolve.ts'
import { createHabitService, HABIT_KIND_TITLES, type StoredHabit } from '../src/server/habits.ts'
import { createRulesService } from '../src/server/rules.ts'
import {
  STYLE_BATCH, STYLE_CANDIDATES, STYLE_DAILY_CALLS, STYLE_ID_PREFIX, findStyleHabits, observationLines, parseStyleReply,
  revisionNoteOf, revisionStyleOf, styleCandidate, styleNotesOfRevisions, styleSayable, styleThingOf, verifyStyleHabit,
  type StyleNote,
} from '../src/server/styleHabits.ts'

function local(month: number, day: number, hour: number, minute = 0): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString()
}
const ms = (iso: string): number => Date.parse(iso)

function e(at: string, 事: string, rest: Partial<BehaviorEntry> = {}): BehaviorEntry {
  return { at, 端: '电脑', 事, 对象: '', 结果: '', ...rest }
}
const say = (at: string, 对象: string, 原话: string): BehaviorEntry => e(at, BEHAVIOR_EVENTS.say, { 对象, 结果: '补一句', 原话 })
const review = (at: string, 对象: string, 结果: '通过' | '打回', 原话?: string): BehaviorEntry =>
  e(at, BEHAVIOR_EVENTS.review, { 对象, 结果, ...(原话 === undefined ? {} : { 原话 }) })
const revision = (at: string, 对象: string, ids: string[]): BehaviorEntry =>
  e(at, BEHAVIOR_EVENTS.revise, { 对象, 结果: ids.join('、'), 类: ids.join(',') })

function note(at: string, thing: string, candidate: string, quote = '太长了', source: StyleNote['source'] = '说'): StyleNote {
  return { at, thing, candidate, quote, source, from: `电脑 · 补一句 · ${thing}` }
}

function trial(over: Partial<StoredHabit> = {}): StoredHabit {
  const at = local(10, 6, 12)
  return {
    id: `${STYLE_ID_PREFIX}长短.短`, kind: 'style', 类: '长短', value: '长短.短', text: styleCandidate('长短.短')?.rule ?? '',
    status: 'trial', evidence: [], applied: [], created_at: at, updated_at: at, adopted_at: at, from: ['说'], ...over,
  }
}

describe('一张固定的风格维度表(同一候选怎么判「同一个」靠 id,不靠模型判相同)', () => {
  it('每个候选有维度、人话标题、照做的那句;相反的两条互指', () => {
    const ids = STYLE_CANDIDATES.map(one => one.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const one of STYLE_CANDIDATES) {
      expect(one.dim).not.toBe('')
      expect(one.title).not.toBe('')
      expect(one.rule).not.toBe('')
      if (one.opposite !== undefined) expect(styleCandidate(one.opposite)?.opposite).toBe(one.id)
    }
    expect(styleCandidate('长短.短')?.opposite).toBe('长短.长')
    expect(HABIT_KIND_TITLES.style).toBe('说话和做事风格')
  })

  it('风格表里没有一条碰权限(问不问、花钱、对外、亲手做都不在表里)', () => {
    for (const one of STYLE_CANDIDATES) expect(`${one.title}${one.rule}`).not.toMatch(/问她|不问|花钱|额度|发布|对外|登录|权限|授权/u)
  })
})

describe('模型那一步的回包:只认表里的 id,原话必须逐字在她说的话里', () => {
  const inputs = ['这个汇报太长了,我看不完', '好', '能不能先说结论?别绕']

  it('对得上的留下,带原话', () => {
    const got = parseStyleReply('{"items":[{"n":1,"id":"长短.短","quote":"太长了"},{"n":3,"id":"结论先行","quote":"先说结论"}]}', inputs)
    expect(got).toEqual([{ n: 1, id: '长短.短', quote: '太长了' }, { n: 3, id: '结论先行', quote: '先说结论' }])
  })

  it('编的原话、表外的 id、越界的 n、坏 JSON 一律丢掉', () => {
    expect(parseStyleReply('{"items":[{"n":1,"id":"长短.短","quote":"她嫌长"}]}', inputs)).toEqual([])
    expect(parseStyleReply('{"items":[{"n":1,"id":"爱用表情","quote":"太长了"}]}', inputs)).toEqual([])
    expect(parseStyleReply('{"items":[{"n":9,"id":"长短.短","quote":"太长了"}]}', inputs)).toEqual([])
    expect(parseStyleReply('不是 json', inputs)).toEqual([])
    expect(parseStyleReply('```json\n{"items":[]}\n```', inputs)).toEqual([])
  })

  it('原话里的空白不同也认(摘录时模型常吞空格),同一条同一候选只算一次', () => {
    const got = parseStyleReply('{"items":[{"n":1,"id":"长短.短","quote":"太长 了"},{"n":1,"id":"长短.短","quote":"太长了"}]}', inputs)
    expect(got).toHaveLength(1)
  })

  it('「好」「收到」这种不送去认(省额度);打回带原话的也算她说的话', () => {
    expect(styleSayable(say(local(10, 5, 9), 't-1 改首页', '好的'))).toBe(false)
    expect(styleSayable(say(local(10, 5, 9), 't-1 改首页', '收到!'))).toBe(false)
    expect(styleSayable(say(local(10, 5, 9), 't-1 改首页', '这段太长了'))).toBe(true)
    expect(styleSayable(review(local(10, 5, 9), 't-1 改首页', '打回', '还是太啰嗦'))).toBe(true)
    expect(styleSayable(review(local(10, 5, 9), 't-1 改首页', '通过'))).toBe(false)
  })

  it('「同一件事」怎么数:卡上的事按卡,选题按选题(不分页签),电话按那一通,对事务官随口说的每句各算一件', () => {
    expect(styleThingOf(say(local(10, 5, 9), 't-1 改首页', 'x'))).toBe('t-1')
    expect(styleThingOf(say(local(10, 5, 9), '选题 露营锅具 · 初稿', 'x'))).toBe('选题 露营锅具')
    expect(styleThingOf(say(local(10, 5, 9), '通话 c-9', 'x'))).toBe('通话 c-9')
    expect(styleThingOf(say(local(10, 5, 9), '事务官', 'x'))).not.toBe(styleThingOf(say(local(10, 5, 10), '事务官', 'x')))
  })
})

describe('改稿比对:初稿与她的终稿按段比,只记改了哪类(不经模型)', () => {
  const body = '露营锅具选铝的还是钛的,看你一年出去几次。\n\n钛锅轻,但导热差,煮饭容易糊。\n\n铝锅便宜,导热好,重一点。'

  it('删了开头客套', () => {
    expect(revisionStyleOf(`大家好,很高兴又和你们见面啦!\n\n${body}`, body)).toContain('语气.少客套')
  })

  it('缩短 / 加长', () => {
    const long = `${body}\n\n${'再补充一句很长的说明,'.repeat(12)}`
    expect(revisionStyleOf(long, body)).toContain('长短.短')
    expect(revisionStyleOf(body, long)).toContain('长短.长')
  })

  it('加了数据', () => {
    expect(revisionStyleOf(body, body.replace('钛锅轻', '钛锅轻(约 120 克,比铝锅轻 40%)'))).toContain('依据.数据')
  })

  it('把结论挪到开头', () => {
    const draft = '先说说钛锅。\n\n再说说铝锅。\n\n结论:一年出去不到五次买铝的。'
    const final = '结论:一年出去不到五次买铝的。\n\n先说说钛锅。\n\n再说说铝锅。'
    expect(revisionStyleOf(draft, final)).toContain('结论先行')
  })

  it('去掉列表和符号 / 改成分点', () => {
    const listed = '- **钛锅**:轻\n- **铝锅**:便宜\n- **不锈钢**:耐用\n- **铸铁**:重'
    const plain = '钛锅轻,铝锅便宜,不锈钢耐用,铸铁重。'
    expect(revisionStyleOf(listed, plain)).toContain('格式.少符号')
    expect(revisionStyleOf(plain, listed)).toContain('格式.分点')
  })

  it('只改了个错字 → 什么都不记', () => {
    expect(revisionStyleOf(body, body.replace('煮饭', '煮米饭'))).toEqual([])
  })

  it('进行为账的那一条:改了哪几类(人话)+ 类(表里的 id);没改出哪类就不记', () => {
    const row = revisionNoteOf({ 对象: '选题 露营锅具 · 初稿', ids: ['语气.少客套', '长短.短'] })
    expect(row).toEqual({ 事: BEHAVIOR_EVENTS.revise, 对象: '选题 露营锅具 · 初稿', 结果: '删了开头客套、缩短', 类: '语气.少客套,长短.短' })
    expect(revisionNoteOf({ 对象: '选题 x · 初稿', ids: [] })).toBeUndefined()
  })

  it('行为账里的改稿 → 候选(证据是改了哪类,出处是哪份稿)', () => {
    const notes = styleNotesOfRevisions([revision(local(10, 5, 9), '选题 露营锅具 · 初稿', ['长短.短'])])
    expect(notes).toEqual([{ at: local(10, 5, 9), thing: '选题 露营锅具', candidate: '长短.短', quote: '缩短', source: '改稿', from: '改稿 · 选题 露营锅具 · 初稿' }])
  })
})

describe('观察 → 候选(观察里没原话,以观察原文为证据,标出处)', () => {
  it('只读「观察」一节的条目,带日期', () => {
    const md = '# 用户:Ben\n\n## 自述\n- 做内容\n\n## 观察(倒序)\n- 2026-10-08 · 汇报喜欢先听结论 · 依据:会话 x\n- 他喜欢听播客\n\n## 别的\n- 不读'
    const lines = observationLines(md)
    expect(lines.map(one => one.text)).toEqual(['2026-10-08 · 汇报喜欢先听结论 · 依据:会话 x', '他喜欢听播客'])
    expect(lines[0]?.date).toBe('2026-10-08')
    expect(lines[0]?.key).not.toBe(lines[1]?.key)
  })
})

describe('计数:不同的两件事上出现同一候选才试用', () => {
  const now = ms(local(10, 9, 12))

  it('同一件事上说两次不算;两件不同的事 → 一条试用,证据带原话与出处', () => {
    expect(findStyleHabits([note(local(10, 5, 9), 't-1', '长短.短'), note(local(10, 5, 10), 't-1', '长短.短')], [], now)).toEqual([])
    const found = findStyleHabits([note(local(10, 5, 9), 't-1', '长短.短'), note(local(10, 7, 9), 't-2', '长短.短', '又这么长')], [], now)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: `${STYLE_ID_PREFIX}长短.短`, kind: 'style', 类: '长短', value: '长短.短', status: 'trial', from: ['说'] })
    expect(found[0]?.evidence.map(one => one.what).join(';')).toContain('「又这么长」')
    expect(found[0]?.evidence.map(one => one.what).join(';')).toContain('出处')
  })

  it('观察一条 + 她说一次 = 两件不同的事,也算', () => {
    const found = findStyleHabits([note(local(10, 5, 9), '观察 ab12', '结论先行', '先听结论', '观察'), note(local(10, 7, 9), 't-2', '结论先行', '先说结论')], [], now)
    expect(found[0]?.from).toEqual(['观察', '说'])
  })

  it('撤过的(她纠正了 / 她撤掉)不再自动学回来;相反的那条正在试用也不学', () => {
    const notes = [note(local(10, 5, 9), 't-1', '长短.短'), note(local(10, 7, 9), 't-2', '长短.短')]
    expect(findStyleHabits(notes, [trial({ status: 'reverted' })], now)).toEqual([])
    expect(findStyleHabits(notes, [trial({ status: 'removed' })], now)).toEqual([])
    expect(findStyleHabits(notes, [trial({ id: `${STYLE_ID_PREFIX}长短.长`, value: '长短.长' })], now)).toEqual([])
  })

  it('30 天以前的不数', () => {
    expect(findStyleHabits([note(local(8, 1, 9), 't-1', '长短.短'), note(local(10, 7, 9), 't-2', '长短.短')], [], now)).toEqual([])
  })
})

describe('验:试用里下一次交付她没再这么说 = 留,又说了 = 撤', () => {
  const scannedAll = local(10, 9, 23)

  it('下一件事上她回话没再提 → 留', () => {
    const entries = [say(local(10, 7, 9), 't-3 改首页', '这样可以,接着做')]
    expect(verifyStyleHabit(trial(), [], entries, scannedAll)).toMatchObject({ status: 'kept' })
  })

  it('下一件事上她又说了同一处(或说了相反的)→ 撤', () => {
    const entries = [say(local(10, 7, 9), 't-3 改首页', '还是太长了')]
    expect(verifyStyleHabit(trial(), [note(local(10, 7, 9), 't-3', '长短.短', '还是太长了')], entries, scannedAll)).toMatchObject({ status: 'reverted' })
    expect(verifyStyleHabit(trial(), [note(local(10, 7, 9), 't-3', '长短.长', '太简单了')], entries, scannedAll)).toMatchObject({ status: 'reverted' })
  })

  it('通过 / 打回那一下她没再提 → 留', () => {
    expect(verifyStyleHabit(trial(), [], [review(local(10, 7, 9), 't-3 改首页', '通过')], scannedAll)).toMatchObject({ status: 'kept' })
  })

  it('那句还没认过(额度用完了没送去认)→ 先不下结论', () => {
    const entries = [say(local(10, 7, 9), 't-3 改首页', '这样可以')]
    expect(verifyStyleHabit(trial(), [], entries, local(10, 7, 8))).toMatchObject({ status: 'trial' })
    expect(verifyStyleHabit(trial(), [], entries, undefined)).toMatchObject({ status: 'trial' })
  })

  it('对事务官随口说的新事不算一次交付(不能拿来过),但她在里面又嫌了照样撤', () => {
    expect(verifyStyleHabit(trial(), [], [say(local(10, 7, 9), '事务官', '帮我查下明天的天气')], scannedAll)).toMatchObject({ status: 'trial' })
    const entries = [say(local(10, 7, 9), '事务官', '你汇报太长了')]
    const thing = styleThingOf(entries[0] as BehaviorEntry)
    expect(verifyStyleHabit(trial(), [note(local(10, 7, 9), thing, '长短.短')], entries, scannedAll)).toMatchObject({ status: 'reverted' })
  })

  it('从改稿学来的:同类交付是下一份稿 —— 下一份她没再缩短 = 留,又缩短 = 撤;她随口回的话不算', () => {
    const fromDraft = trial({ from: ['改稿'] })
    expect(verifyStyleHabit(fromDraft, [], [say(local(10, 7, 9), 't-3 改首页', '这样可以')], scannedAll)).toMatchObject({ status: 'trial' })
    expect(verifyStyleHabit(fromDraft, [], [revision(local(10, 7, 9), '选题 新的 · 初稿', ['依据.数据'])], scannedAll)).toMatchObject({ status: 'kept' })
    expect(verifyStyleHabit(fromDraft, [], [revision(local(10, 7, 9), '选题 新的 · 初稿', ['长短.短'])], scannedAll)).toMatchObject({ status: 'reverted' })
    expect(verifyStyleHabit(fromDraft, [], [review(local(10, 7, 9), '选题 新的 · 初稿', '通过')], scannedAll)).toMatchObject({ status: 'kept' })
  })

  it('试用以前的不算', () => {
    expect(verifyStyleHabit(trial(), [], [say(local(10, 5, 9), 't-3 改首页', '可以')], scannedAll)).toMatchObject({ status: 'trial' })
  })
})

// ───────────────────────────── 服务:假模型夹具 ─────────────────────────────

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 假模型:按原话里的字眼回(像真模型那样只回表里的 id 与原话片段),记下每次被问了什么。 */
function fakeModel() {
  const prompts: string[] = []
  return {
    prompts,
    ask: async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      const items: { n: number, id: string, quote: string }[] = []
      for (const m of prompt.matchAll(/^(\d+)\. (.*)$/gmu)) {
        const n = Number(m[1])
        const text = m[2] ?? ''
        for (const [word, id] of [['太长', '长短.短'], ['先说结论', '结论先行'], ['先听结论', '结论先行']] as const) {
          if (text.includes(word)) items.push({ n, id, quote: word })
        }
      }
      return JSON.stringify({ items })
    },
  }
}

async function service(dir: string, rows: BehaviorEntry[], opts: { observations?: string, startAt?: string } = {}) {
  const rules = createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  const ledger = { rows }
  const clock = { now: ms(opts.startAt ?? local(10, 9, 12)) }
  const model = fakeModel()
  const workdir = join(dir, 'work')
  const habits = createHabitService({
    store: rules,
    behavior: { read: async () => ledger.rows },
    now: () => clock.now,
    workdir,
    io: {
      readFile: async (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
      writeFile: async (file, text) => {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, text, 'utf8')
      },
    },
    style: {
      ask: model.ask,
      ...(opts.observations === undefined ? {} : { observations: async () => opts.observations }),
    },
  })
  return { habits, rules, ledger, clock, model, logFile: join(workdir, EVOLVE_LOG_NAME) }
}

describe('习惯服务 · 风格', () => {
  it('她在两件事上嫌长 → 认一次(一批)→ 试用 → 规矩表四处都带上 → 进化日志一行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [
      say(local(10, 5, 9), 't-1 改首页', '这个汇报太长了'),
      say(local(10, 6, 9), 't-2 写周报', '又太长了,我没空看'),
      say(local(10, 6, 10), 't-2 写周报', '好的'),
    ])
    const done = await s.habits.learn({ style: true })
    expect(done.adopted).toBe(1)
    expect(s.model.prompts).toHaveLength(1)
    expect(s.model.prompts[0]).not.toContain('好的')

    const view = s.habits.view()
    expect(view.trial[0]).toMatchObject({ kind: 'style', kind_title: '说话和做事风格', status: 'trial' })
    expect(view.trial[0]?.evidence.map(one => one.what).join(';')).toContain('「太长」')

    const rule = styleCandidate('长短.短')?.rule as string
    expect(s.rules.brief('agents').text).toContain(rule)
    expect(s.rules.brief('say').text).toContain(rule)
    expect(s.rules.brief('dispatch', '改首页', 'code').text).toContain(rule)
    expect(s.rules.brief('review', '改首页').text).toContain(rule)
    // 设置里「记住的规矩」那张表不重复列(风格在「它学到了什么」里看、撤)。
    expect(s.rules.view().rules.map(one => one.text)).not.toContain(rule)

    expect(readFileSync(s.logFile, 'utf8')).toContain('试用习惯(说话和做事风格)')

    // 认过的不再送去认(不重复花额度)。
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(1)
  })

  it('试用后下一件事她没再嫌 → 留下;撤掉 → 四处都不带了,也不再学回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [say(local(10, 5, 9), 't-1 x', '太长'), say(local(10, 6, 9), 't-2 y', '太长')])
    await s.habits.learn({ style: true })
    s.clock.now = ms(local(10, 9, 15))
    s.ledger.rows.push(say(local(10, 9, 14), 't-3 z', '这样可以,接着做'))
    const done = await s.habits.learn({ style: true })
    expect(done.kept).toBe(1)
    const id = s.habits.view().kept[0]?.id as string
    expect(readFileSync(s.logFile, 'utf8')).toContain('**留下**')

    await s.habits.revoke(id)
    expect(s.rules.brief('agents').text ?? '').not.toContain(styleCandidate('长短.短')?.rule as string)
    s.ledger.rows.push(say(local(10, 9, 16), 't-4 a', '太长'), say(local(10, 9, 17), 't-5 b', '太长'))
    expect((await s.habits.learn({ style: true })).adopted).toBe(0)
  })

  it('又嫌了 → 自动撤', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [say(local(10, 5, 9), 't-1 x', '太长'), say(local(10, 6, 9), 't-2 y', '太长')])
    await s.habits.learn({ style: true })
    s.clock.now = ms(local(10, 9, 15))
    s.ledger.rows.push(say(local(10, 9, 14), 't-3 z', '还是太长'))
    expect((await s.habits.learn({ style: true })).reverted).toBe(1)
    expect(s.habits.view().retired[0]?.verdict).toContain('还是太长'.slice(2))
  })

  it(`额度:每天最多问 ${STYLE_DAILY_CALLS} 次模型(一次一批 ${STYLE_BATCH} 句);没用完的明天接着认`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const rows = Array.from({ length: STYLE_BATCH * (STYLE_DAILY_CALLS + 2) }, (_, i) => say(new Date(ms(local(10, 8, 9)) + i * 60_000).toISOString(), `t-${i} x`, `第 ${i} 件,这样做可以`))
    const s = await service(dir, rows)
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(STYLE_DAILY_CALLS)
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(STYLE_DAILY_CALLS)
    s.clock.now = ms(local(10, 10, 9))
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(STYLE_DAILY_CALLS + 2)
  })

  it('平时(派活、拍板触发的那一遍)攒不满一批不去认 —— 只在下班例程 / 启动那一遍认', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [say(local(10, 5, 9), 't-1 x', '太长')])
    await s.habits.learn()
    expect(s.model.prompts).toHaveLength(0)
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(1)
  })

  it('模型出错 → 这一批不算认过,下次再认;习惯照旧', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [say(local(10, 5, 9), 't-1 x', '太长'), say(local(10, 6, 9), 't-2 y', '太长')])
    const real = s.model.ask
    let fail = true
    const rules = createRulesService({ file: join(dir, 'rules2.json') })
    await rules.load()
    const habits = createHabitService({
      store: rules,
      behavior: { read: async () => s.ledger.rows },
      now: () => s.clock.now,
      style: { ask: async (p) => { if (fail) throw new Error('模型超时'); return await real(p) } },
    })
    expect((await habits.learn({ style: true })).adopted).toBe(0)
    fail = false
    expect((await habits.learn({ style: true })).adopted).toBe(1)
  })

  it('观察 → 候选:以观察原文为证据、标出处;观察与她的话各一件 → 试用;同一条观察不再送去认', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const md = '# 用户:Ben\n\n## 观察\n- 2026-10-08 · 汇报他喜欢先听结论 · 依据:会话 x\n- 2026-10-07 · 他喜欢听播客'
    const s = await service(dir, [say(local(10, 9, 9), 't-1 x', '能不能先说结论')], { observations: md })
    expect((await s.habits.learn({ style: true })).adopted).toBe(1)
    const what = s.habits.view().trial[0]?.evidence.map(one => one.what).join(';') ?? ''
    expect(what).toContain('「先听结论」')
    expect(what).toContain('观察')
    expect(s.model.prompts.some(p => p.includes('不是她的原话'))).toBe(true)
    const calls = s.model.prompts.length
    await s.habits.learn({ style: true })
    expect(s.model.prompts).toHaveLength(calls)
  })

  it('改稿两份不同的稿都缩短 → 试用(不经模型)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [
      revision(local(10, 5, 9), '选题 甲 · 初稿', ['长短.短']),
      revision(local(10, 6, 9), '需求 乙 · 需求', ['长短.短', '依据.数据']),
    ])
    expect((await s.habits.learn()).adopted).toBe(1)
    expect(s.model.prompts).toHaveLength(0)
    expect(s.habits.view().trial[0]?.evidence.map(one => one.what).join(';')).toContain('改稿')
  })

  it('风格学习不碰权限:学到风格之后「问不问」照旧一条都不放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-style-'))
    dirs.push(dir)
    const s = await service(dir, [say(local(10, 5, 9), 't-1 x', '太长'), say(local(10, 6, 9), 't-2 y', '太长')])
    await s.habits.learn({ style: true })
    expect(s.habits.noAsk({ kind: 'browser' })).toBeUndefined()
    expect(s.habits.noAsk({ kind: '长短' })).toBeUndefined()
    expect(s.habits.noAsk({ kind: `${STYLE_ID_PREFIX}长短.短` })).toBeUndefined()
  })
})
