/**
 * 进化循环骨架(2026-09-22,卡 ⑥;设计文档 §五「持续进化的一条线」)。
 *
 * 钉六件(卡里点名的那六条用例):
 * ① **重复检测的阈值与归一化** —— 三次才提、窗口外不算、不同类不并;
 * ② **候选去重** —— 已在 pending / 已做过 / 已拒过的不再进来,同时挂着的有上限;
 * ③ **「不要」记忆** —— 点过一次,以后扫多少遍都不再提这一条;
 * ④ **日志写入与撤销** —— 一次一条(哪天/为什么/做成了什么/怎么撤),撤销**不删**原来那一段;
 * ⑤ **收件箱条目形状** —— 只新增一种 kind,别的几档一条不多一条不少;
 * ⑥ **不改工作台本体代码** —— 这条链路能写出去的只有仓库 `docs/技能/固化-*.md` 与
 *    一条**待确认**的小组件需求;`src/` 底下一个字节都不碰。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEV_TOOL_DRAFT } from '../src/protocol.ts'
import {
  EVOLVE_LOG_NAME,
  EVOLVE_SKILL_SECTIONS,
  MAX_PENDING,
  MIN_KEYWORDS,
  OVERLAP_MIN,
  REPEAT_MIN,
  WINDOW_DAYS,
  appendLog,
  candidateId,
  createEvolveService,
  createEvolveStore,
  evolveSkillDoc,
  evolveSkillDraft,
  evolveSkillName,
  findRepeats,
  keywordsOf,
  markUndone,
  normalizeSay,
  overlap,
  proposalOf,
  reviewLine,
  safeSkillName,
  type EvolveIo,
  type EvolveSay,
} from '../src/server/evolve.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const day = (offset: number): string => new Date(NOW - offset * 86_400_000).toISOString()

/** 同一类:三次说「把评论区的问题整理成选题」。 */
const COMMENTS: EvolveSay[] = [
  { id: 'a', text: '把评论区里的问题整理成选题', at: day(10) },
  { id: 'b', text: '把评论区的问题整理一下变成选题', at: day(6) },
  { id: 'c', text: '评论区问题整理成选题', at: day(2) },
]

// ─────────────────────────── ① 阈值与归一化 ───────────────────────────

describe('归一化', () => {
  it('★「开发一个小工具」那句预填的开头切掉——它是按钮塞进去的,不是她说的话', () => {
    expect(normalizeSay(`${DEV_TOOL_DRAFT}一个番茄钟`)).toBe('一个番茄钟')
  })

  it('★只取第一行:标题是第一行,后面是补充', () => {
    expect(normalizeSay('整理评论区问题\n顺便把重复的合并掉')).toBe('整理评论区问题')
  })

  it('全角与半角标点一律当空白,英文小写', () => {
    expect(normalizeSay('整理 评论区,问题!')).toBe('整理 评论区 问题')
    expect(normalizeSay('查一下 SEO 关键词')).toBe('查一下 seo 关键词')
  })
})

describe('关键词', () => {
  it('中文切二元组——两次说法不逐字相同也认得出是同一件事', () => {
    expect([...keywordsOf('评论区问题')]).toEqual(['评论', '论区', '区问', '问题'])
  })

  it('英文/数字整词算一个;一个字符的丢掉(跟谁都像)', () => {
    const words = keywordsOf('查 seo 和 a 的排名')
    expect(words.has('seo')).toBe(true)
    expect(words.has('a')).toBe(false)
  })

  it('★任一边没关键词时重合度是 0,不是 1——"没有关键词"不等于"跟谁都一样"', () => {
    expect(overlap(new Set(), new Set(['评论']))).toBe(0)
  })

  it('重合系数问的是"短的那句是不是被长的那句包住了"', () => {
    const a = keywordsOf(normalizeSay('评论区问题整理成选题'))
    const b = keywordsOf(normalizeSay('把评论区里读者问的那些问题整理成选题'))
    expect(overlap(a, b)).toBeGreaterThanOrEqual(OVERLAP_MIN)
  })
})

describe('重复检测', () => {
  it(`★满 ${REPEAT_MIN} 次才出候选;差一次就不提`, () => {
    expect(findRepeats({ says: COMMENTS.slice(0, 2), nowMs: NOW })).toEqual([])
    const found = findRepeats({ says: COMMENTS, nowMs: NOW })
    expect(found).toHaveLength(1)
    expect(found[0]?.says).toHaveLength(3)
  })

  it('★代表句取最短的那一条——短的更接近"这件事本身"', () => {
    expect(findRepeats({ says: COMMENTS, nowMs: NOW })[0]?.sample).toBe('评论区问题整理成选题')
  })

  it(`★窗口是 ${WINDOW_DAYS} 天:第三次落在窗口外就不算重复`, () => {
    const stale = [COMMENTS[0] as EvolveSay, COMMENTS[1] as EvolveSay, { id: 'c', text: '评论区问题整理成选题', at: day(WINDOW_DAYS + 1) }]
    expect(findRepeats({ says: stale, nowMs: NOW })).toEqual([])
  })

  it('★不同类的不并成一簇——「整理评论区」与「查违禁词」各算各的', () => {
    const mixed = [
      ...COMMENTS,
      { id: 'd', text: '发布前查一遍违禁词', at: day(3) },
      { id: 'e', text: '发布之前查一遍违禁词', at: day(1) },
    ]
    const found = findRepeats({ says: mixed, nowMs: NOW })
    expect(found).toHaveLength(1)
    expect(found[0]?.sample).toBe('评论区问题整理成选题')
  })

  it('认不出时刻的、未来的、同一个 id 重复给的,一律丢掉(不拿"现在"顶)', () => {
    const noisy = [
      ...COMMENTS,
      ...COMMENTS, // 同一批再给一遍:id 相同,只数一次
      { id: 'bad', text: '评论区问题整理成选题', at: '不是时间' },
      { id: 'future', text: '评论区问题整理成选题', at: day(-3) },
    ]
    expect(findRepeats({ says: noisy, nowMs: NOW })[0]?.says).toHaveLength(3)
  })

  it(`★关键词少于 ${MIN_KEYWORDS} 个的句子不参与聚类——「发一下」跟谁都像`, () => {
    const thin = [
      { id: '1', text: '发', at: day(1) },
      { id: '2', text: '发', at: day(2) },
      { id: '3', text: '发', at: day(3) },
    ]
    expect(findRepeats({ says: thin, nowMs: NOW })).toEqual([])
  })

  it('★候选 id 只由归一化文本决定——换个顺序扫、隔一天再扫,还是同一个 id', () => {
    const first = findRepeats({ says: COMMENTS, nowMs: NOW })[0]?.id
    const second = findRepeats({ says: [...COMMENTS].reverse(), nowMs: NOW + 86_400_000 })[0]?.id
    expect(first).toBe(second)
    expect(first).toBe(candidateId('评论区问题整理成选题'))
  })

  it('★点过「不要」的那一条,扫多少遍都不再冒出来', () => {
    const id = candidateId('评论区问题整理成选题')
    expect(findRepeats({ says: COMMENTS, nowMs: NOW, declined: [id] })).toEqual([])
  })
})

// ─────────────────────────── ② 候选去重与「不要」记忆 ───────────────────────────

describe('落盘的仓', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wb-evolve-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const proposalsOf = (...names: string[]) =>
    names.map(name => proposalOf(
      { id: candidateId(name), sample: name, says: [{ id: name, text: name, at: day(1) }], shared: [] },
      new Date(NOW).toISOString(),
    ))

  it('★同一条候选加两遍只进一条', async () => {
    const store = createEvolveStore({ file: join(dir, 'evolve.json') })
    await store.load()
    expect(await store.add(proposalsOf('整理评论区问题'))).toBe(1)
    expect(await store.add(proposalsOf('整理评论区问题'))).toBe(0)
    expect(store.pending()).toHaveLength(1)
  })

  it('★点过「不要」的不再进来(重启之后也记得)', async () => {
    const file = join(dir, 'evolve.json')
    const store = createEvolveStore({ file })
    await store.load()
    await store.add(proposalsOf('整理评论区问题'))
    await store.drop(candidateId('整理评论区问题'), { decline: true })
    expect(store.pending()).toEqual([])
    expect(await store.add(proposalsOf('整理评论区问题'))).toBe(0)

    // 重启:同一份文件重新读一遍,「不要」还在。
    const again = createEvolveStore({ file })
    await again.load()
    expect(again.declined()).toContain(candidateId('整理评论区问题'))
    expect(await again.add(proposalsOf('整理评论区问题'))).toBe(0)
  })

  it('「以后再说」只撤下这一次,下次还会再提', async () => {
    const store = createEvolveStore({ file: join(dir, 'evolve.json') })
    await store.load()
    await store.add(proposalsOf('整理评论区问题'))
    await store.drop(candidateId('整理评论区问题'))
    expect(store.declined()).toEqual([])
    expect(await store.add(proposalsOf('整理评论区问题'))).toBe(1)
  })

  it(`★同时挂着的最多 ${MAX_PENDING} 条——攒一屏没人点的提议等于一条都没在办`, async () => {
    const store = createEvolveStore({ file: join(dir, 'evolve.json') })
    await store.load()
    const many = proposalsOf('整理评论区问题', '查一遍违禁词表', '统计本周发布数', '拆解爆款笔记')
    expect(await store.add(many)).toBe(MAX_PENDING)
    expect(store.pending()).toHaveLength(MAX_PENDING)
  })

  it('文件坏了当"一条都没有",不抛——一份读不懂的 json 不该让工作台起不来', async () => {
    const file = join(dir, 'evolve.json')
    await writeFile(file, '{ 这不是 json', 'utf8')
    const store = createEvolveStore({ file })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.pending()).toEqual([])
  })
})

// ─────────────────────────── ④ 日志与撤销(纯函数那一半) ───────────────────────────

describe('进化日志', () => {
  const entry = {
    id: 'evolve:x', date: '2026-09-22', why: '说过 3 次', what: '起草了一条技能', how_to_undo: '删掉那份文件', way: 'skill' as const,
  }

  it('★文件不存在时先铺抬头,一条一段,四件事都在', () => {
    const text = appendLog(undefined, entry)
    expect(text).toContain('# 进化日志')
    expect(text).toContain('- **为什么**:说过 3 次')
    expect(text).toContain('- **做成了什么**:起草了一条技能')
    expect(text).toContain('- **怎么撤**:删掉那份文件')
    expect(text).toContain('- **提议 id**:`evolve:x`')
  })

  it('第二条追加在后面,抬头不重复', () => {
    const text = appendLog(appendLog(undefined, entry), { ...entry, id: 'evolve:y', what: '提了一条小组件需求' })
    expect(text.match(/# 进化日志/g)).toHaveLength(1)
    expect(text.indexOf('evolve:x')).toBeLessThan(text.indexOf('evolve:y'))
  })

  it('★撤销**不删**原来那一段,底下补一行「已撤」——撤了也是发生过的事', () => {
    const before = appendLog(undefined, entry)
    const after = markUndone(before, 'evolve:x', '2026-09-23')
    expect(after.marked).toBe(true)
    expect(after.text).toContain('- **做成了什么**:起草了一条技能')
    expect(after.text).toContain('- **已撤**:2026-09-23(提议 id `evolve:x`)')
  })

  it('★同一条撤两次不重复写「已撤」;找不到那一条时如实说没找到,不在末尾凭空补一行', () => {
    const once = markUndone(appendLog(undefined, entry), 'evolve:x', '2026-09-23')
    const twice = markUndone(once.text, 'evolve:x', '2026-09-24')
    expect(twice.text.match(/\*\*已撤\*\*/g)).toHaveLength(1)
    const missing = markUndone(once.text, 'evolve:没有这条', '2026-09-24')
    expect(missing.marked).toBe(false)
    expect(missing.text).toBe(once.text)
  })

  it('★回看那一句:一样都没固化过时整条缺席,不拿一句话占位', () => {
    expect(reviewLine([])).toBeUndefined()
    expect(reviewLine([entry])).toContain('起草了一条技能')
    expect(reviewLine([entry])).toContain('用了没')
  })
})

// ─────────────────────────── 技能草稿与名字闸 ───────────────────────────

describe('技能那条路', () => {
  it('★名字闸挡住路径分隔符、`..`、点开头与空名——别在她的仓库里按一个句子建文件', () => {
    expect(safeSkillName('评论区选题')).toBe('评论区选题')
    expect(safeSkillName('  ')).toBeUndefined()
    expect(safeSkillName('../../etc/passwd')).toBeUndefined()
    expect(safeSkillName('a/b')).toBeUndefined()
    expect(safeSkillName('.hidden')).toBeUndefined()
    expect(safeSkillName('一'.repeat(25))).toBeUndefined()
    expect(safeSkillName(42)).toBeUndefined()
  })

  it('段名 = 文件名(去掉 .md),一处推出来', () => {
    expect(evolveSkillName('评论区选题')).toBe('固化-评论区选题')
    expect(evolveSkillDoc('评论区选题')).toBe('docs/技能/固化-评论区选题.md')
  })

  it('★草稿开口就说自己是草稿,「怎么做」那一节留空——不替她编步骤', () => {
    const proposal = proposalOf(
      { id: candidateId('评论区问题整理成选题'), sample: '评论区问题整理成选题', says: COMMENTS, shared: [] },
      new Date(NOW).toISOString(),
    )
    const draft = evolveSkillDraft({ name: '评论区选题', proposal, date: '2026-09-22' })
    expect(draft).toContain('它现在是草稿')
    expect(draft).toContain('等你填')
    for (const section of EVOLVE_SKILL_SECTIONS) expect(draft).toContain(`## ${section}`)
    // 依据那一节里逐字是她自己说过的话,一句都不是生成的。
    for (const say of COMMENTS) expect(draft).toContain(say.text)
  })
})

// ─────────────────────────── ⑤ 收件箱条目形状 ───────────────────────────

describe('收件箱', () => {
  const proposal = proposalOf(
    { id: candidateId('评论区问题整理成选题'), sample: '评论区问题整理成选题', says: COMMENTS, shared: [] },
    new Date(NOW).toISOString(),
  )

  it('★只新增一种 kind:没接这条链路时一条都不多', () => {
    expect(deriveButlerInbox({ sessions: [] }).items).toEqual([])
  })

  it('★一条提议 = 一条 evolve 条目,id 就是提议 id,note 是「它准备怎么做、会碰什么」', () => {
    const items = deriveButlerInbox({ sessions: [], evolve: [proposal] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('evolve')
    expect(items[0]?.id).toBe(proposal.id)
    expect(items[0]?.title).toBe(proposal.ask)
    expect(items[0]?.note).toBe(proposal.plans[proposal.suggested_way])
    // **不给 task_id / conversation**:它不是一件事项,也没有一段对话可点开。
    expect(items[0]?.task_id).toBeUndefined()
    expect(items[0]?.conversation).toBeUndefined()
  })

  it('★问句里带上"这几次"的次数与代表句——她要能看出我凭什么提这一条', () => {
    expect(proposal.ask).toContain('3 次')
    expect(proposal.ask).toContain('评论区问题整理成选题')
    expect(proposal.says).toEqual(COMMENTS.map(say => say.text))
  })

  it('三条路各有一段「会碰什么」,一条都不少', () => {
    expect(proposal.plans.skill).toContain('docs/技能')
    expect(proposal.plans.tool).toContain('不替你发出去')
    expect(proposal.plans.template).toContain('还没做')
  })
})

// ─────────────────────────── ③④⑥ 服务:三条路 + 留痕可撤 ───────────────────────────

describe('服务', () => {
  let dir: string
  let repo: string
  let workdir: string
  const wrote = new Map<string, string>()

  const io = (): EvolveIo => ({
    readFile: async file => wrote.get(file) ?? (await readFile(file, 'utf8').catch(() => undefined)),
    writeFile: async (file, text) => { wrote.set(file, text) },
    removeFile: async file => wrote.delete(file),
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-evolve-svc-'))
    repo = join(dir, 'repo')
    workdir = join(dir, 'work')
    wrote.clear()
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  let seq = 0
  const make = async (extra: Partial<Parameters<typeof createEvolveService>[0]> = {}) => {
    // 每一次 make 用自己那份 evolve.json:同一个用例里要起两台服务时,
    // 共用一份文件会让前一台记下的「不要」漏给后一台。
    seq += 1
    const store = createEvolveStore({ file: join(dir, `evolve-${seq}.json`) })
    const service = createEvolveService({
      store, io: io(), repo, workdir, now: () => NOW,
      says: async () => COMMENTS,
      ...extra,
    })
    await service.load()
    return { store, service }
  }

  it('★扫一遍 → 提议进 /state;一天只扫一次', async () => {
    const { service } = await make()
    const first = await service.scan()
    expect(first.added).toBe(1)
    expect(service.view().pending).toHaveLength(1)
    // 同一天再扫不重复提。
    expect((await service.scan()).added).toBe(0)
    expect((await service.scan()).note).toContain('今天已经扫过')
  })

  it('★一条都没有时如实说,不编一条凑数', async () => {
    const { service } = await make({ says: async () => [] })
    const done = await service.scan()
    expect(done.added).toBe(0)
    expect(done.note).toContain(`近 ${WINDOW_DAYS} 天`)
  })

  it('★技能那条路:落一份草稿 + 一条日志,**不接进 AGENTS.md**(等她过一遍)', async () => {
    let applied: string | undefined
    const { service } = await make({ skill: { apply: async (name) => { applied = name; return { ok: true } }, revert: async () => ({ ok: true, removed: true }) } })
    await service.scan()
    const id = service.view().pending[0]?.id as string
    const done = await service.accept({ id, way: 'skill', name: '评论区选题' })
    expect(done.ok).toBe(true)
    expect(applied).toBeUndefined()
    expect(wrote.get(join(repo, 'docs/技能/固化-评论区选题.md'))).toContain('它现在是草稿')
    expect(wrote.get(join(workdir, EVOLVE_LOG_NAME))).toContain('固化-评论区选题')
    expect(service.view().pending).toEqual([])
  })

  it('★草稿她过了才接进 AGENTS.md;撤销时既摘段又删文件,日志补「已撤」', async () => {
    const calls: string[] = []
    const { service } = await make({
      skill: {
        apply: async (name) => { calls.push(`apply:${name}`); return { ok: true } },
        revert: async (name) => { calls.push(`revert:${name}`); return { ok: true, removed: true } },
      },
    })
    await service.scan()
    const id = service.view().pending[0]?.id as string
    await service.accept({ id, way: 'skill', name: '评论区选题' })
    expect((await service.wire(id)).ok).toBe(true)
    expect(calls).toEqual(['apply:固化-评论区选题'])

    const reverted = await service.revert(id)
    expect(reverted.ok).toBe(true)
    expect(calls).toEqual(['apply:固化-评论区选题', 'revert:固化-评论区选题'])
    expect(wrote.has(join(repo, 'docs/技能/固化-评论区选题.md'))).toBe(false)
    expect(await service.log()).toContain('**已撤**')
    // 原来那一条还在——撤了也是发生过的事。
    expect(await service.log()).toContain('固化-评论区选题')
  })

  it('★技能没起名字 / 重名 / 没仓库:整件事停下,一个字节都不写', async () => {
    const { service } = await make()
    await service.scan()
    const id = service.view().pending[0]?.id as string
    expect(await service.accept({ id, way: 'skill' })).toMatchObject({ ok: false })
    expect(await service.accept({ id, way: 'skill', name: '../坏名字' })).toMatchObject({ ok: false })
    expect(wrote.size).toBe(0)

    wrote.set(join(repo, 'docs/技能/固化-评论区选题.md'), '早就有的一份')
    const dup = await service.accept({ id, way: 'skill', name: '评论区选题' })
    expect(dup).toMatchObject({ ok: false })
    expect(wrote.get(join(repo, 'docs/技能/固化-评论区选题.md'))).toBe('早就有的一份')
  })

  it('★小组件那条路:预填进现有链路,**不自动发**', async () => {
    const asked: { request: string, restate: string }[] = []
    const { service } = await make({ tool: async input => { asked.push(input); return { ok: true } } })
    await service.scan()
    const id = service.view().pending[0]?.id as string
    const done = await service.accept({ id, way: 'tool' })
    expect(done).toMatchObject({ ok: true })
    expect(asked).toHaveLength(1)
    // 预填的那句话就是「开发一个小工具」那条链路认得出的形状,正文逐字是她自己的话。
    expect(asked[0]?.request.startsWith(DEV_TOOL_DRAFT)).toBe(true)
    expect(asked[0]?.restate).toBe('评论区问题整理成选题')
    expect(await service.log()).toContain('还没发')
  })

  it('没接那条链路时如实拒绝,不悄悄换一条路', async () => {
    const { service } = await make()
    await service.scan()
    const id = service.view().pending[0]?.id as string
    expect(await service.accept({ id, way: 'tool' })).toMatchObject({ ok: false })
  })

  it('★模板那条路这一版只记「待做」,一个文件都不动', async () => {
    const { service } = await make()
    await service.scan()
    const id = service.view().pending[0]?.id as string
    expect(await service.accept({ id, way: 'template' })).toMatchObject({ ok: true })
    // 只有进化日志那一份。
    expect([...wrote.keys()]).toEqual([join(workdir, EVOLVE_LOG_NAME)])
    expect(await service.log()).toContain('待做')
  })

  it('★没配工作目录 = 留不了痕,那就不动手(一个字节都不写)', async () => {
    const store = createEvolveStore({ file: join(dir, 'evolve-nowork.json') })
    const service = createEvolveService({ store, io: io(), repo, now: () => NOW, says: async () => COMMENTS })
    await service.load()
    await service.scan()
    const id = service.view().pending[0]?.id as string
    expect(await service.accept({ id, way: 'template' })).toMatchObject({ ok: false })
    expect(wrote.size).toBe(0)
  })

  it('★「不要」之后再扫也不会重新提;「以后再说」下次还会问', async () => {
    const { service } = await make()
    await service.scan()
    const id = service.view().pending[0]?.id as string
    expect(await service.decline(id)).toBe(true)
    expect((await service.scan({ force: true })).added).toBe(0)

    const later = await make()
    await later.service.scan()
    const laterId = later.service.view().pending[0]?.id as string
    expect(await later.service.later(laterId)).toBe(true)
    expect((await later.service.scan({ force: true })).added).toBe(1)
  })

  it('★回看那一句进 /state:固化过之后才有', async () => {
    const { service } = await make()
    await service.scan()
    expect(service.view().review).toBeUndefined()
    const id = service.view().pending[0]?.id as string
    await service.accept({ id, way: 'template' })
    expect(service.view().review).toContain('用了没')
  })

  it('★这条链路写出去的路径里没有一条落在 src/——不改工作台本体代码', async () => {
    const { service } = await make({
      skill: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true, removed: true }) },
      tool: async () => ({ ok: true }),
    })
    await service.scan()
    const id = service.view().pending[0]?.id as string
    await service.accept({ id, way: 'skill', name: '评论区选题' })
    await service.wire(id)
    for (const file of wrote.keys()) {
      expect(file.includes('/src/')).toBe(false)
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(false)
    }
  })
})
