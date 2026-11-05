// @vitest-environment node
/**
 * 自进化最小闭环 —— 偏好那一截(2026-09-23,`docs/设计-事务官自进化闭环-2026-09-23.md` 第三节)。
 *
 * Ben 的原话里两条硬要求,这一份各钉一半:
 *
 * ① **「不能把一次临时要求直接固化成长期偏好」** —— 同一句打回意见要在 ≥ PREF_MIN_TOPICS 条
 *    **不同**选题上出现过才记;一条选题上说一次、同一条选题上说两次,都不是偏好。
 * ② **「调整 → 验证效果 → 保留或回滚」** —— 记下之后下一次推进,她通过了就保留、又打回同一处就撤;
 *    保留与撤都写进进化日志(原来那一条不删),收件箱至多两条提示、过期自己消失。
 *
 * 外加:纯函数不接模型、不碰盘;服务落盘全走注入的 io(2026-09-04 事故纪律)。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOTICE_MAX,
  NOTICE_TTL_DAYS,
  PREF_MIN_TOPICS,
  PREF_WINDOW_DAYS,
  annotateLog,
  appendLog,
  createEvolveService,
  createEvolveStore,
  findPreferences,
  preferenceId,
  preferenceLine,
  renderVerdictLine,
  reviseMatches,
  verifyPreference,
  type EvolveIo,
  type EvolvePreference,
  type EvolveReviewSay,
} from '../src/server/evolve.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const NOW = Date.parse('2026-09-23T12:00:00Z')
const day = (offset: number, hour = 10): string => new Date(NOW - offset * 86_400_000 + (hour - 12) * 3_600_000).toISOString()

/** 两条不同选题上都打回过「开头太长」。 */
const TWO_TOPICS: EvolveReviewSay[] = [
  { topic: '露营锅具怎么选', tab: '初稿', action: 'revise', text: '开头太长了', at: day(5) },
  { topic: '露营锅具怎么选', tab: '初稿', action: 'pass', at: day(4) },
  { topic: '帐篷选购避坑', tab: '初稿', action: 'revise', text: '开头太长', at: day(2) },
]

// ─────────────────────────── ① 一次临时要求 ≠ 偏好 ───────────────────────────

describe('沉淀偏好的判据', () => {
  it(`★ 同一处在 ${PREF_MIN_TOPICS} 条不同选题上都打回过 → 一条偏好(试用),代表句取最短那一条`, () => {
    const found = findPreferences({ reviews: TWO_TOPICS, nowMs: NOW })
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('开头太长')
    expect(found[0]?.topics).toEqual(['露营锅具怎么选', '帐篷选购避坑'])
    expect(found[0]?.status).toBe('trial')
    expect(found[0]?.evidence).toHaveLength(2)
  })

  it('★ 一条选题上说一次 = 这一篇的临时要求,不是偏好', () => {
    expect(findPreferences({ reviews: TWO_TOPICS.slice(0, 1), nowMs: NOW })).toEqual([])
  })

  it('★ 同一条选题上打回两次同一处,还是不算 —— 那是事务官上一轮没改对,不是她的偏好', () => {
    const same: EvolveReviewSay[] = [
      { topic: '露营锅具怎么选', tab: '初稿', action: 'revise', text: '开头太长', at: day(5) },
      { topic: '露营锅具怎么选', tab: '初稿', action: 'revise', text: '开头还是太长', at: day(3) },
    ]
    expect(findPreferences({ reviews: same, nowMs: NOW })).toEqual([])
  })

  it('★ 只数「改一改」;通过 / 她自己改 / 推进时补的那句,一概不算打回意见', () => {
    const notRevise: EvolveReviewSay[] = [
      { topic: 'A', tab: '初稿', action: 'run', text: '开头太长', at: day(5) },
      { topic: 'B', tab: '初稿', action: 'self', text: '开头太长', at: day(3) },
      { topic: 'C', tab: '初稿', action: 'pass', text: '开头太长', at: day(1) },
    ]
    expect(findPreferences({ reviews: notRevise, nowMs: NOW })).toEqual([])
  })

  it(`★ 窗口 ${PREF_WINDOW_DAYS} 天:第二次落在窗口外就凑不够`, () => {
    const stale: EvolveReviewSay[] = [
      { topic: 'A', tab: '初稿', action: 'revise', text: '开头太长', at: day(PREF_WINDOW_DAYS + 1) },
      { topic: 'B', tab: '初稿', action: 'revise', text: '开头太长', at: day(1) },
    ]
    expect(findPreferences({ reviews: stale, nowMs: NOW })).toEqual([])
  })

  it('不同的意见不并成一条 —— 「开头太长」与「结尾没有关注理由」各算各的', () => {
    const mixed: EvolveReviewSay[] = [
      ...TWO_TOPICS,
      { topic: 'A', tab: '定稿', action: 'revise', text: '结尾没给关注理由', at: day(3) },
      { topic: 'B', tab: '定稿', action: 'revise', text: '结尾要给关注理由', at: day(1) },
    ]
    const found = findPreferences({ reviews: mixed, nowMs: NOW })
    expect(found.map(one => one.text).sort()).toEqual(['开头太长', '结尾没给关注理由'])
  })

  it('★ id 只由归一化文本决定;已记过的(含撤过的)不再出', () => {
    const [one] = findPreferences({ reviews: TWO_TOPICS, nowMs: NOW })
    expect(one?.id).toBe(preferenceId('开头太长'))
    expect(findPreferences({ reviews: TWO_TOPICS, nowMs: NOW, known: [one?.id as string] })).toEqual([])
  })

  it('reviseMatches:说的是同一处才算(关键词重合过半)', () => {
    const pref = { text: '开头太长' }
    expect(reviseMatches(pref, { topic: 'x', tab: '初稿', action: 'revise', text: '开头还是太长了', at: day(0) })).toBe(true)
    expect(reviseMatches(pref, { topic: 'x', tab: '初稿', action: 'revise', text: '结尾没给关注理由', at: day(0) })).toBe(false)
    expect(reviseMatches(pref, { topic: 'x', tab: '初稿', action: 'pass', text: '开头太长', at: day(0) })).toBe(false)
  })
})

// ─────────────────────────── ② 验证 → 保留或回滚 ───────────────────────────

const PREF: EvolvePreference = {
  id: preferenceId('开头太长'),
  text: '开头太长',
  topics: ['露营锅具怎么选', '帐篷选购避坑'],
  evidence: [],
  status: 'trial',
  adopted_at: day(2, 12),
}

describe('验证:下一次推进的结果说了算', () => {
  it('★ 记下之后还没推进过 → 仍在试用,不下结论', () => {
    expect(verifyPreference(PREF, TWO_TOPICS).status).toBe('trial')
  })

  it('★ 推进之后她通过了那份产物、没再打回同一处 → 保留', () => {
    const reviews: EvolveReviewSay[] = [
      ...TWO_TOPICS,
      { topic: '睡袋怎么挑', tab: '初稿', action: 'run', at: day(1) },
      { topic: '睡袋怎么挑', tab: '初稿', action: 'pass', at: day(0) },
    ]
    const verdict = verifyPreference(PREF, reviews)
    expect(verdict.status).toBe('kept')
    expect(verdict.why).toContain('《睡袋怎么挑》')
    expect(verdict.why).toContain('没再打回同一处')
  })

  it('★ 推进之后她又打回了同一处 → 没见效,撤', () => {
    const reviews: EvolveReviewSay[] = [
      ...TWO_TOPICS,
      { topic: '睡袋怎么挑', tab: '初稿', action: 'run', at: day(1) },
      { topic: '睡袋怎么挑', tab: '初稿', action: 'revise', text: '开头还是太长', at: day(0) },
    ]
    const verdict = verifyPreference(PREF, reviews)
    expect(verdict.status).toBe('reverted')
    expect(verdict.why).toContain('「开头还是太长」')
  })

  it('打回的是别处不算数,接着往后看;之后通过了照样算保留', () => {
    const reviews: EvolveReviewSay[] = [
      { topic: 'C', tab: '初稿', action: 'run', at: day(1, 9) },
      { topic: 'C', tab: '初稿', action: 'revise', text: '结尾没给关注理由', at: day(1, 10) },
      { topic: 'C', tab: '初稿', action: 'pass', at: day(1, 11) },
    ]
    expect(verifyPreference(PREF, reviews).status).toBe('kept')
  })

  it('★ 记下之前的推进不算 —— 那时的话里还没带这一条,结果与它无关', () => {
    const reviews: EvolveReviewSay[] = [
      { topic: 'C', tab: '初稿', action: 'run', at: day(3) },
      { topic: 'C', tab: '初稿', action: 'revise', text: '开头太长', at: day(2, 13) },
    ]
    expect(verifyPreference(PREF, reviews).status).toBe('trial')
  })

  it('通过的是别的页签不算(推进的是初稿,她通过的是框架)', () => {
    const reviews: EvolveReviewSay[] = [
      { topic: 'C', tab: '初稿', action: 'run', at: day(1) },
      { topic: 'C', tab: '框架', action: 'pass', at: day(0) },
    ]
    expect(verifyPreference(PREF, reviews).status).toBe('trial')
  })

  it('又一次推进 = 上一轮到此为止;第一个有结论的说了算', () => {
    const reviews: EvolveReviewSay[] = [
      { topic: 'C', tab: '初稿', action: 'run', at: day(1, 9) },
      { topic: 'C', tab: '初稿', action: 'run', at: day(1, 10) },
      { topic: 'C', tab: '初稿', action: 'pass', at: day(1, 11) },
      { topic: 'D', tab: '初稿', action: 'run', at: day(0, 9) },
      { topic: 'D', tab: '初稿', action: 'revise', text: '开头太长', at: day(0, 10) },
    ]
    // C 那一轮先有结论(通过),D 上的打回是之后的事 —— 这一次验证的结论是保留。
    expect(verifyPreference(PREF, reviews).status).toBe('kept')
  })
})

describe('那一行与日志', () => {
  it('★ 一行里带原话、在哪几条选题上说过、状态、从哪天起 —— 三处(话/账号.md/收件箱)同一行', () => {
    const line = preferenceLine(PREF)
    expect(line).toContain('「开头太长」')
    expect(line).toContain('《露营锅具怎么选》《帐篷选购避坑》')
    expect(line).toContain('试用中')
    expect(line).toContain(PREF.adopted_at.slice(0, 10))
    expect(preferenceLine({ ...PREF, status: 'kept' })).toContain('已验证')
  })

  it('★ 验证结论补在原来那一条底下,原来那一段一个字不删;同一行不写第二遍', () => {
    const text = appendLog(undefined, {
      id: PREF.id, date: '2026-09-21', way: 'preference',
      why: '在两条选题上都打回过', what: '记下一条偏好(试用):「开头太长」', how_to_undo: '撤',
    })
    const kept: EvolvePreference = { ...PREF, status: 'kept', verdict: '《C》推进之后她通过了 初稿,没再打回同一处' }
    const line = renderVerdictLine(kept, '2026-09-23')
    const once = annotateLog(text, PREF.id, line)
    expect(once.marked).toBe(true)
    expect(once.text).toContain('记下一条偏好(试用)')
    expect(once.text).toContain('- **已验证保留**:2026-09-23')
    expect(once.text.indexOf('已验证保留')).toBeGreaterThan(once.text.indexOf('提议 id'))
    const twice = annotateLog(once.text, PREF.id, line)
    expect(twice.text).toBe(once.text)
    expect(annotateLog(text, 'pref:没有这条', line).marked).toBe(false)
  })

  it('撤那一行写明「没见效」', () => {
    expect(renderVerdictLine({ ...PREF, status: 'reverted', verdict: '又打回了' }, '2026-09-23')).toContain('已撤(没见效)')
  })
})

// ─────────────────────────── 服务:学一遍、提示、手撤 ───────────────────────────

describe('服务', () => {
  let home: string
  let files: Map<string, string>
  let io: EvolveIo
  let reviews: EvolveReviewSay[]
  let clock: number

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-evolve-prefs-'))
    files = new Map()
    io = {
      readFile: async file => files.get(file),
      writeFile: async (file, text) => { files.set(file, text) },
      removeFile: async file => files.delete(file),
    }
    reviews = [...TWO_TOPICS]
    clock = NOW
  })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  function service(over: { workdir?: string, reviews?: boolean } = {}) {
    const store = createEvolveStore({ file: join(home, 'evolve.json') })
    return createEvolveService({
      store, io,
      workdir: over.workdir === undefined ? join(home, 'work') : over.workdir,
      now: () => clock,
      says: async () => [],
      ...(over.reviews === false ? {} : { reviews: async () => reviews }),
    })
  }

  it('★ 学一遍:记下一条偏好(试用)→ 日志一条 + 收件箱一条提示 + 推进的话里那一行', async () => {
    const svc = service()
    await svc.load()
    const learned = await svc.learn()
    expect(learned.adopted).toBe(1)
    expect(learned.note).toContain('记下 1 条偏好')
    const log = files.get(join(home, 'work', '进化日志.md')) as string
    expect(log).toContain('记下一条偏好(试用):「开头太长」')
    expect(log).toContain('《露营锅具怎么选》')
    expect(log).toContain('怎么撤')
    const view = svc.view()
    expect(view.preferences?.[0]?.status).toBe('trial')
    expect(view.notices).toHaveLength(1)
    expect(view.notices?.[0]?.kind).toBe('adopted')
    expect(view.notices?.[0]?.title).toContain('「开头太长」')
    expect(svc.preferenceLines()).toEqual([preferenceLine(view.preferences?.[0] as unknown as EvolvePreference)])
  })

  it('★ 再学一遍不重复记(幂等)', async () => {
    const svc = service()
    await svc.load()
    await svc.learn()
    const again = await svc.learn()
    expect(again.adopted).toBe(0)
    expect(svc.view().preferences).toHaveLength(1)
    // 日志里只有一条(每条带一行「提议 id」)。
    expect((files.get(join(home, 'work', '进化日志.md')) as string).split('- **提议 id**').length - 1).toBe(1)
  })

  it('★ 下一条选题她通过了 → 保留:状态、日志那一行、收件箱第二条', async () => {
    const svc = service()
    await svc.load()
    await svc.learn()
    clock = NOW + 3_600_000
    reviews.push(
      { topic: '睡袋怎么挑', tab: '初稿', action: 'run', at: new Date(NOW + 1_800_000).toISOString() },
      { topic: '睡袋怎么挑', tab: '初稿', action: 'pass', at: new Date(NOW + 3_000_000).toISOString() },
    )
    const learned = await svc.learn()
    expect(learned.kept).toBe(1)
    expect(svc.view().preferences?.[0]?.status).toBe('kept')
    expect(svc.view().preferences?.[0]?.verdict).toContain('《睡袋怎么挑》')
    expect(files.get(join(home, 'work', '进化日志.md'))).toContain('已验证保留')
    const notices = svc.view().notices ?? []
    expect(notices.map(one => one.kind)).toEqual(['adopted', 'kept'])
    expect(svc.preferenceLines()[0]).toContain('已验证')
  })

  it('★ 下一条选题她又打回同一处 → 没见效,自动撤:推进的话里不再带、日志补「已撤」、以后不再自动记', async () => {
    const svc = service()
    await svc.load()
    await svc.learn()
    clock = NOW + 3_600_000
    reviews.push(
      { topic: '睡袋怎么挑', tab: '初稿', action: 'run', at: new Date(NOW + 1_800_000).toISOString() },
      { topic: '睡袋怎么挑', tab: '初稿', action: 'revise', text: '开头还是太长', at: new Date(NOW + 3_000_000).toISOString() },
    )
    const learned = await svc.learn()
    expect(learned.reverted).toBe(1)
    expect(svc.preferenceLines()).toEqual([])
    expect(svc.view().preferences).toBeUndefined()
    expect(files.get(join(home, 'work', '进化日志.md'))).toContain('已撤(没见效)')
    expect(svc.view().notices?.at(-1)?.kind).toBe('reverted')
    // 这时把关记录里已经有三条选题都打回过「开头太长」—— 但撤过的不再自动记。
    expect((await svc.learn()).adopted).toBe(0)
  })

  it('★ 手撤:/evolve/revert 认 pref: 开头的 id;撤过的再撤如实拒', async () => {
    const svc = service()
    await svc.load()
    await svc.learn()
    const id = svc.view().preferences?.[0]?.id as string
    const done = await svc.revert(id)
    expect(done.ok).toBe(true)
    expect(svc.preferenceLines()).toEqual([])
    expect(files.get(join(home, 'work', '进化日志.md'))).toContain('她手动撤的')
    expect((await svc.revert(id)).ok).toBe(false)
    expect((await svc.revert('pref:没有')).ok).toBe(false)
  })

  it(`★ 收件箱至多 ${NOTICE_MAX} 条,过了 ${NOTICE_TTL_DAYS} 天自己消失`, async () => {
    const svc = service()
    await svc.load()
    reviews.push(
      { topic: 'A', tab: '定稿', action: 'revise', text: '结尾没给关注理由', at: day(3) },
      { topic: 'B', tab: '定稿', action: 'revise', text: '结尾要给关注理由', at: day(1) },
      { topic: 'A', tab: '定稿', action: 'revise', text: '标题别用问句', at: day(3, 11) },
      { topic: 'B', tab: '定稿', action: 'revise', text: '标题不要问句', at: day(1, 11) },
    )
    const learned = await svc.learn()
    expect(learned.adopted).toBe(3)
    expect(svc.view().notices).toHaveLength(NOTICE_MAX)
    expect(svc.view().preferences).toHaveLength(3)
    clock = NOW + (NOTICE_TTL_DAYS + 1) * 86_400_000
    expect(svc.view().notices).toBeUndefined()
    // 偏好本身不过期。
    expect(svc.view().preferences).toHaveLength(3)
  })

  it('★ 没配工作目录 = 留不了痕 = 不记(一条都不记,如实说)', async () => {
    const svc = service({ workdir: '' })
    await svc.load()
    const learned = await svc.learn()
    expect(learned.adopted).toBe(0)
    expect(learned.note).toContain('进化日志')
    expect(svc.preferenceLines()).toEqual([])
  })

  it('没接把关记录时偏好那一截整个不动,如实说', async () => {
    const svc = service({ reviews: false })
    await svc.load()
    expect((await svc.learn()).note).toContain('没接把关记录')
  })

  it('重启之后偏好与提示都还在(落在 evolve.json 里)', async () => {
    const first = service()
    await first.load()
    await first.learn()
    const second = service()
    await second.load()
    expect(second.view().preferences).toHaveLength(1)
    expect(second.view().notices).toHaveLength(1)
  })

  it('★ 提示进收件箱还是 kind:evolve 那一档 —— 没有新增 kind,也没有按钮', async () => {
    const svc = service()
    await svc.load()
    await svc.learn()
    const items = deriveButlerInbox({ sessions: [], evolve: svc.view().pending, evolve_notices: svc.view().notices }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('evolve')
    expect(items[0]?.title).toContain('「开头太长」')
    expect(items[0]?.note).toContain('不用你再交代')
    expect(items[0]?.task_id).toBeUndefined()
  })
})
