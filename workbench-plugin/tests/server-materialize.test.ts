// @vitest-environment node
/**
 * 引导落地的纯函数那一半(卡 feat/onboarding-materialize)。
 *
 * 夹具是维护者 2026-09-24 18:25–18:52 那一通电话引导的存档(onboarding.json 只留答案那几格)与当晚的 tasks.json 副本 ——
 * 设计第三节的对照表就是拿它对的:两个项目、冲刺「Spotlight 参赛 · 10-04」、十张卡、例程、免打扰、资讯、撤掉的七条、第一件派给 Codex。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { MaterializeArchive, PlanContext } from '../src/server/materialize.ts'
import {
  archiveClauses, buildPlan, cancelCandidates, dateIn, mergeExtractions, normalizeTitle, parseModelExtraction, planLine, rulesExtract, selectRows,
  spokenTime, staleVersionOf, timesOf, titleSimilarity,
} from '../src/server/materialize.ts'

const archive = JSON.parse(readFileSync(new URL('./fixtures/materialize/onboarding-0924.json', import.meta.url), 'utf8')) as MaterializeArchive
const tasksFile = JSON.parse(readFileSync(new URL('./fixtures/materialize/tasks-0924.json', import.meta.url), 'utf8')) as { tasks: TaskView[] }
const TODAY = '2026-09-24'
const NOW = new Date('2026-09-24T12:30:00.000Z')

function context(over: Partial<PlanContext> = {}): PlanContext {
  const extraction = rulesExtract(archive, TODAY)
  return {
    now: NOW,
    today: TODAY,
    archive,
    extraction,
    board: { tasks: tasksFile.tasks, sprints: [], modules: [] },
    projects: {
      stored: [{ id: 'desktop-workbench', name: 'desktop-workbench', repoPath: '/Users/example/Documents/GitHub/desktop-workbench' }],
      repos: [
        { id: 'desktop-workbench', name: 'desktop-workbench', path: '/Users/example/Documents/GitHub/desktop-workbench' },
        { id: 'echo', name: 'Echo', path: '/Users/example/Documents/GitHub/Echo' },
        { id: 'aiboo', name: 'Aiboo', path: '/Users/example/Documents/GitHub/Aiboo' },
      ],
    },
    routines: { morning: {}, evening: { at: '18:30' } },
    quiet: { from: '23:00', to: '08:00' },
    feed: { podcast: true, interests: [{ project_id: 'desktop-workbench', project_name: 'desktop-workbench', keywords: [] }, { project_id: 'echo', project_name: 'Echo', keywords: [] }] },
    apps: { enabled: ['claude', 'codex', 'kimi', 'wechat', 'wecom'] },
    readClientFiles: '可以',
    currentVersion: '0.2.83',
    codexThread: { id: '01a0ccd1-5e62-7eb2-a0af-224d9d844cfd', title: '制作参赛网页' },
    wired: { tasks: true, projects: true, routines: true, quiet: true, feed: true, slot: false, quota: false, memories: true, dispatch: true },
    ...over,
  }
}

describe('规则表:维护者那份存档 → 第三节对照表的卡', () => {
  const extraction = rulesExtract(archive, TODAY)

  it('十张卡,顺序、负责人、状态照对照表', () => {
    expect(extraction.source).toBe('rules')
    expect(extraction.cards.map(card => [card.title, card.owner, card.status])).toEqual([
      ['参赛网页架构收尾', 'codex', 'doing'],
      ['参赛视频', 'other', 'todo'],
      ['参赛文案', 'colleague', 'todo'],
      ['9/28 把材料整理好放同事桌上', 'me', 'todo'],
      ['手机远程派单 + 汇报 / 进度评估准确', 'claude', 'todo'],
      ['定核心体验流程(四段)', 'me', 'confirm'],
      ['验证自我迭代能力', 'claude', 'todo'],
      ['打磨自媒体布局', 'claude', 'todo'],
      ['服务器与手机版本同步', 'claude', 'todo'],
      ['额度显示 / 会话读取', 'claude', 'todo'],
    ])
  })

  it('细节照他的话:同事 9/29 回来、9/28 截止、最高优先、不阻塞、第一件是参赛网页', () => {
    const by = new Map(extraction.cards.map(card => [card.topic, card]))
    expect(by.get('copy')?.owner_note).toBe('9/29 回来写')
    expect(by.get('handover')?.due).toBe('2026-09-28')
    expect(by.get('remote')?.priority).toBe('high')
    expect(by.get('quota-ui')).toMatchObject({ blocking: false, priority: 'low' })
    expect(extraction.cards.filter(card => card.first === true).map(card => card.topic)).toEqual(['web'])
    // 同一件事在细节、拿不准、下一步里各说了一遍:只出一张,出处攒在一起。
    expect(by.get('core-flow')?.quote).toContain('核心体验流程')
    expect(by.get('ops-layout')?.quote).toContain('自媒体')
  })

  it('冲刺、背景、第二个项目、资讯关键词都从他的话里来', () => {
    expect(extraction.sprint).toEqual({ name: 'Spotlight 参赛 · 10-04', deadline: '2026-10-04' })
    expect(extraction.contest).toBe('Spotlight')
    expect(extraction.background).toBe('9/29 起远程(只带 Pad);中秋 9/25-9/27,国庆 10/1 起')
    expect(extraction.projects).toEqual([{ name: 'Lapis', repo: 'Echo', owner: 'kimi', note: 'Kimi 负责;也参赛;仓库名 Echo' }])
    expect(extraction.keywords['desktop-workbench']).toEqual(['Spotlight 比赛', 'AI 事务官', 'Agent 调度', '远程派单', '会议录音转待办'])
    expect(extraction.keywords.Lapis).toEqual(['Spotlight 比赛'])
  })

  it('不出卡的:照搬交接的旧清单、他说没必要的 Windows 端', () => {
    const why = extraction.skipped.map(one => `${one.why}|${one.text}`)
    expect(why.some(line => line.includes('旧清单') && line.includes('按交接里的三件'))).toBe(true)
    expect(why.some(line => line.includes('旧清单') && line.includes('扫仓库'))).toBe(true)
    expect(why.some(line => line.includes('没必要') && line.includes('Windows'))).toBe(true)
    expect(extraction.cards.some(card => /扫仓库|聚球|0\.2\.80|Windows/.test(card.title))).toBe(false)
  })

  it('确定性:同一份存档跑两次一模一样', () => {
    expect(rulesExtract(archive, TODAY)).toEqual(extraction)
  })
})

describe('计划:对照项目区 / 看板 / 例程排出一行一行', () => {
  it('维护者这份:两个项目、冲刺、十件事、每天三样、桌面两样、补拷记忆、撤掉七条、第一件派 Codex', () => {
    const plan = buildPlan(context())
    const rows = plan.rows.map(row => `${row.group}|${row.kind}|${row.title}|${row.checked ? '勾' : '不勾'}${row.done === true ? '|已有' : ''}${row.placeholder === undefined ? '' : '|占位'}`)
    expect(rows).toEqual([
      'projects|project|工作台(desktop-workbench)|勾',
      'projects|project|Lapis(仓库 Echo)|勾',
      'sprint|sprint|冲刺「Spotlight 参赛 · 10-04」|勾',
      'sprint|task|参赛网页架构收尾|勾',
      'sprint|task|参赛视频|勾',
      'sprint|task|参赛文案|勾',
      'sprint|task|9/28 把材料整理好放同事桌上|勾',
      'sprint|task|手机远程派单 + 汇报 / 进度评估准确|勾',
      'sprint|task|定核心体验流程(四段)|勾',
      'sprint|task|验证自我迭代能力|勾',
      'sprint|task|打磨自媒体布局|勾',
      'sprint|task|服务器与手机版本同步|勾',
      'sprint|task|额度显示 / 会话读取|勾',
      'daily|routine|早上 8 点半:播客和早报准备好|勾',
      'daily|routine|晚上 8 点半:收尾|勾',
      'daily|quiet|晚上 9 点到早上 8 点半不打扰|勾',
      'daily|feed|资讯与播客只按 工作台、Lapis 定向搜|勾',
      'desk|slot|窗口槽:Claude、Codex、Kimi、微信、企业微信|不勾|占位',
      'desk|quota|额度:DeepSeek、Claude、Codex、Kimi|不勾|占位',
      // 卡 O:引导里说的分工 → 规矩表「派活默认分工」(这份上下文没接规矩表,占位不勾)。
      'rules|division|派活默认分工|不勾|占位',
      'memory|memories|补拷记忆:Claude、Codex、Kimi 里记着的东西拷一份过来|勾',
      'cleanup|cancel|让事务官能自己扫仓库,不用口述|勾',
      'cleanup|cancel|查 0.2.80 真机聚球还卡不卡|勾',
      'cleanup|cancel|按三层清单自验 0.2.80|勾',
      'cleanup|cancel|让她能自己扫仓库,不用你口述|勾',
      'cleanup|cancel|和事务官通了个电话(4 秒)|勾',
      'cleanup|cancel|和事务官通了个电话(34 秒)|勾',
      'cleanup|cancel|和事务官通了个电话(46 秒)|勾',
      'first|dispatch|参赛网页架构收尾 → Codex|勾',
    ])
    expect(plan.counts).toEqual({ projects: 2, tasks: 10, cancel: 7 })
    expect(plan.line).toBe('都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?')
    expect(plan.groups.map(group => group.title)).toEqual(['项目', '冲刺 · Spotlight 参赛 · 10-04', '每天', '桌面', '派活分工', '记忆', '撤掉(改成「取消」,不删)', '第一件'])
  })

  /**
   * 卡 O(2026-09-25,设计第 4 条):他在引导里说的「Claude 写代码、Codex 做综合、Kimi 负责 Lapis」落地时自动成规矩。
   * 统筹 09-25 手加的那一条是样板;规矩表里已经有同标题的就只多记一条依据(单子上说清)。
   */
  it('★派活分工:从存档抽出「写代码 → Claude、综合 → Codex、Lapis(Echo)→ Kimi」,接了规矩表才勾', () => {
    const base = context()
    const plan = buildPlan({ ...base, wired: { ...base.wired, rules: true } })
    const row = plan.rows.find(one => one.kind === 'division')
    expect(row).toMatchObject({ key: 'rules:division', group: 'rules', title: '派活默认分工', checked: true })
    expect(row?.placeholder).toBeUndefined()
    expect(row?.detail).toContain('写代码的活派 Claude;综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi')
    expect(row?.data).toMatchObject({ kind: 'division', text: '派活默认分工:写代码的活派 Claude;综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。' })
    const said = (row?.data as { said: string }).said
    expect(said).toContain('Claude 擅长写代码')
    expect(said).toContain('Codex 用 GPT6 后审美好')
    const again = buildPlan({ ...base, wired: { ...base.wired, rules: true }, rules: { hasDivision: true } })
    expect(again.rows.find(one => one.kind === 'division')?.detail).toContain('规矩表里已经有这一条')
  })

  it('小字写清负责人、截止、等你确认、为什么撤', () => {
    const plan = buildPlan(context())
    const detail = new Map(plan.rows.map(row => [row.title, row.detail]))
    expect(detail.get('工作台(desktop-workbench)')).toBe('Spotlight 报名截止 10/4,倒计时;9/29 起远程(只带 Pad);中秋 9/25-9/27,国庆 10/1 起;状态写「冲刺 Spotlight,10/4 截止;参赛网页架构基本快弄完(Codex 在跑)」')
    expect(detail.get('Lapis(仓库 Echo)')).toBe('Kimi 负责;也参赛;仓库名 Echo')
    expect(detail.get('参赛网页架构收尾')).toBe('负责:Codex · 进行中')
    expect(detail.get('参赛文案')).toBe('负责:同事(9/29 回来写)')
    expect(detail.get('参赛视频')).toBe('负责:别人(接手做)')
    expect(detail.get('9/28 把材料整理好放同事桌上')).toBe('负责:你 · 截止 9/28')
    expect(detail.get('定核心体验流程(四段)')).toBe('负责:你 · 等你确认')
    expect(detail.get('额度显示 / 会话读取')).toBe('负责:Claude · 不阻塞')
    expect(detail.get('晚上 9 点到早上 8 点半不打扰')).toContain('现在是 23:00–08:00')
    expect(detail.get('查 0.2.80 真机聚球还卡不卡')).toBe('照搬中午交接的旧清单:提到 0.2.80,现在已经 0.2.83')
    expect(detail.get('让她能自己扫仓库,不用你口述')).toContain('重复')
    expect(detail.get('和事务官通了个电话(34 秒)')).toContain('测试')
    expect(detail.get('参赛网页架构收尾 → Codex')).toContain('制作参赛网页')
  })

  it('第一件交给事务官的那句:接着那条会话、派不进就新开并写清', () => {
    const dispatch = buildPlan(context()).rows.find(row => row.kind === 'dispatch')
    expect(dispatch?.data.kind).toBe('dispatch')
    if (dispatch?.data.kind !== 'dispatch') return
    expect(dispatch.data.owner).toBe('codex')
    expect(dispatch.data.text).toContain('接着「制作参赛网页」那条会话的工作')
    expect(dispatch.data.text).toContain('01a0ccd1-5e62-7eb2-a0af-224d9d844cfd')
    expect(dispatch.data.text).toContain('派不进指定会话就新开一条')
    // 直接说给 Codex 听的那一句(卡 F 的 dispatchItem):明说是新开的、先看提交接着做、做完几句话汇报。
    expect(dispatch.data.agent_text).toContain('接着「制作参赛网页」那条会话的工作:把参赛网页架构剩下的补完,完了汇报')
    expect(dispatch.data.agent_text).toContain('工作台送不进那条会话,所以新开了这一条')
    expect(dispatch.data.agent_text).toContain('做完用三五句话汇报')
  })

  it('重跑不重复建:看板上已经有的卡、已经设过的例程标「已经有了」,不再勾', () => {
    const first = buildPlan(context())
    const created: TaskView[] = first.rows.filter(row => row.data.kind === 'task').map((row, index) => ({
      id: `m-${index}`, title: row.title, status: 'todo', source: { kind: 'manual' }, created_at: '2026-09-24T12:31:00.000Z', updated_at: '2026-09-24T12:31:00.000Z',
      // 第一件派过了:卡上挂着事务官那条会话。
      ...(index === 0 ? { status: 'doing', conversation: { agent: 'dsh', session_id: 'sess-1' } } : {}),
    } as TaskView))
    const canceled = tasksFile.tasks.map(task => (first.rows.some(row => row.key === `cancel:${task.id}`) ? { ...task, status: 'canceled' as const } : task))
    const again = buildPlan(context({
      board: { tasks: [...canceled, ...created], sprints: [{ id: 's1', project_id: 'desktop-workbench', name: 'Spotlight 参赛 · 10-04' }], modules: [] },
      projects: {
        stored: [
          // 上一次落的时候写下的那一行状态(落过了就不再提)。
          { id: 'desktop-workbench', name: '工作台', repoPath: '/Users/example/Documents/GitHub/desktop-workbench', ddl: { date: '2026-10-04', title: 'Spotlight 报名截止' }, status: '冲刺 Spotlight,10/4 截止;参赛网页架构基本快弄完(Codex 在跑)' },
          { id: 'echo', name: 'Lapis', repoPath: '/Users/example/Documents/GitHub/Echo' },
        ],
        repos: [],
      },
      routines: { morning: { at: '08:30' }, evening: { at: '20:30' } },
      quiet: { from: '21:00', to: '08:30' },
      feed: { podcast: true, interests: [
        { project_id: 'desktop-workbench', project_name: '工作台', keywords: ['Spotlight 比赛', 'AI 事务官', 'Agent 调度', '远程派单', '会议录音转待办'] },
        { project_id: 'echo', project_name: 'Lapis', keywords: ['Spotlight 比赛'] },
      ] },
    }))
    const live = again.rows.filter(row => row.checked && row.done !== true && row.placeholder === undefined)
    expect(live.map(row => row.key)).toEqual(['memories'])
    expect(again.rows.filter(row => row.kind === 'cancel')).toEqual([])
    expect(again.rows.filter(row => row.kind === 'task').every(row => row.done === true)).toBe(true)
  })

  it('同样的输入同样的计划 id;输入变了 id 就变', () => {
    expect(buildPlan(context()).id).toBe(buildPlan(context()).id)
    expect(buildPlan(context({ quiet: { from: '22:00', to: '08:00' } })).id).not.toBe(buildPlan(context()).id)
  })

  it('没接看板 / 没接事务官会话:那几行写占位、不勾,不装成能做', () => {
    const plan = buildPlan(context({ wired: { tasks: false, projects: true, routines: true, quiet: true, feed: true, slot: false, quota: false, memories: false, dispatch: false } }))
    const task = plan.rows.find(row => row.kind === 'task')
    expect(task?.placeholder).toBe('这台工作台没接看板')
    expect(plan.rows.find(row => row.kind === 'dispatch')).toMatchObject({ checked: false, placeholder: '这台工作台没接事务官会话,派不出去' })
    expect(plan.rows.find(row => row.kind === 'memories')).toMatchObject({ checked: false })
  })

  it('窗口槽用卡 C 的预览:ready 不说「摆好了」,没开着的写「点一下拉进来」', () => {
    const plan = buildPlan(context({
      wired: { tasks: true, projects: true, routines: true, quiet: true, feed: true, slot: true, quota: false, memories: true, dispatch: true },
      slotPreview: { results: [
        { app: 'claude', label: 'Claude', state: 'ready' },
        { app: 'codex', label: 'Codex', state: 'already' },
        { app: 'kimi', label: 'Kimi', state: 'not_running' },
        { app: 'wechat', label: '微信', state: 'ready' },
        { app: 'wecom', label: '企业微信', state: 'needs_click' },
      ] },
      quotaStatus: { providers: [], line: 'DeepSeek 已接上;Claude、Codex 要你点一次「全部接上」;Kimi 要你自己登一次' },
    }))
    const slot = plan.rows.find(row => row.kind === 'slot')
    expect(slot).toMatchObject({ checked: true })
    expect(slot?.placeholder).toBeUndefined()
    expect(slot?.detail).toBe('Codex 已经在窗口槽里;Claude、微信 开着,落地时直接拉进来;Kimi、企业微信 标签上写「点一下拉进来」')
    expect(slot?.detail).not.toContain('摆好了')
    expect(plan.rows.find(row => row.kind === 'quota')?.detail).toBe('DeepSeek 已接上;Claude、Codex 要你点一次「全部接上」;Kimi 要你自己登一次')
  })
})

describe('他勾掉 / 改了 / 电话里说「那件不用」', () => {
  it('勾掉的不做;改了标题负责人照改;卡被勾掉第一件也不派', () => {
    const plan = buildPlan(context())
    const web = plan.rows.find(row => row.title === '参赛网页架构收尾')?.key as string
    const copy = plan.rows.find(row => row.title === '参赛文案')?.key as string
    const picked = selectRows(plan, { uncheck: [web], edits: { [copy]: { title: '参赛文案(同事写)', owner: 'colleague' } } })
    expect(picked.rows.some(row => row.key === web)).toBe(false)
    expect(picked.rows.some(row => row.kind === 'dispatch')).toBe(false)
    expect(picked.rows.find(row => row.key === copy)?.title).toBe('参赛文案(同事写)')
    // 占位的(窗口槽、额度)永远不在「真做」里。
    expect(picked.rows.some(row => row.kind === 'slot' || row.kind === 'quota')).toBe(false)
  })

  it('电话里他说「视频那件不用」:按标题认出来勾掉;认不出的原样回去', () => {
    const picked = selectRows(buildPlan(context()), { skip: ['参赛视频', '飞书那件'] })
    expect(picked.rows.some(row => row.title === '参赛视频')).toBe(false)
    expect(picked.unmatched).toEqual(['飞书那件'])
  })
})

describe('模型那一份:严格校验,和规则那一份合并', () => {
  const good = {
    sprint: { name: 'Spotlight 参赛 · 10-04', deadline: '2026-10-04' },
    cards: [
      { title: '网页架构收尾', owner: 'codex', status: 'doing', quote: '参赛主件是网页(架构基本快弄完,Codex 在跑)', first: true },
      { title: '给评委准备演示账号', owner: 'claude', status: 'todo', quote: '评委要能登进来看' },
      { title: '做 Windows 端', owner: 'claude', status: 'todo', quote: '曾想过做 Windows 端' },
    ],
    projects: [{ name: 'Lapis', repo: 'Echo', owner: 'kimi' }],
    keywords: { 'desktop-workbench': ['Spotlight'] },
  }

  it('形状对就收;负责人、状态、日期不认得就整份不要', () => {
    expect(parseModelExtraction(good, TODAY).ok).toBe(true)
    expect(parseModelExtraction({ cards: [{ ...good.cards[0], owner: '小王' }] }, TODAY)).toMatchObject({ ok: false })
    expect(parseModelExtraction({ cards: [{ ...good.cards[0], status: 'maybe' }] }, TODAY)).toMatchObject({ ok: false })
    expect(parseModelExtraction({ cards: [{ ...good.cards[0], due: '10月4号' }] }, TODAY)).toMatchObject({ ok: false })
    expect(parseModelExtraction({ cards: [{ ...good.cards[0], quote: '' }] }, TODAY)).toMatchObject({ ok: false })
    expect(parseModelExtraction('不是 JSON', TODAY)).toMatchObject({ ok: false })
    expect(parseModelExtraction({ cards: [] }, TODAY)).toMatchObject({ ok: false })
  })

  it('合并:同一件事以规则为准;规则不认得的补在后面;模型「第一件」不抢', () => {
    const parsed = parseModelExtraction(good, TODAY)
    if (!parsed.ok) throw new Error(parsed.why)
    const merged = mergeExtractions(rulesExtract(archive, TODAY), parsed.value)
    expect(merged.source).toBe('model+rules')
    expect(merged.cards.map(card => card.title)).toContain('参赛网页架构收尾')
    expect(merged.cards.map(card => card.title)).not.toContain('网页架构收尾')
    expect(merged.cards.at(-1)?.title).toBe('给评委准备演示账号')
    expect(merged.cards.filter(card => card.first === true)).toHaveLength(1)
    expect(merged.cards.length).toBe(11)
  })

  it('2026-09-24 晚 scratch 真跑出来的那几张多余的卡:现状(doing)、习惯偏好(出自「其它」)不收;主项目不当成「另一个项目」', () => {
    const parsed = parseModelExtraction({
      cards: [
        { title: '产品进一步研发', owner: 'claude', status: 'doing', quote: 'Claude 在做产品进一步研发,统筹交接那条最主要' },
        { title: '电脑上派活各家都能派', owner: 'me', status: 'doing', quote: '电脑上派活各家都能派,Mac 辅助功能和发版服务器通了' },
        { title: '按两个项目做定向搜索生成播客', owner: 'me', status: 'todo', quote: '他喜欢听播客,想按这两个项目做定向搜索、生成播客与项目进展' },
        { title: '把能力本身准备好', owner: 'butler', status: 'todo', quote: '把能力本身准备好(远程派单、汇报与进度评估、自媒体布局)' },
        // 同一句拆成两张:规则那张「手机远程派单 + 汇报 / 进度评估准确」已经出自这一句。
        { title: '远程汇报与进度评估要准', owner: 'butler', status: 'todo', quote: '远程汇报与进度评估要准' },
        { title: '新电脑装上自媒体那套布局', owner: 'me', status: 'todo', quote: '新电脑已到手，只差安装(几分钟)' },
      ],
      projects: [{ name: 'desktop-workbench', owner: 'butler' }, { name: 'Lapis', repo: 'Echo', owner: 'kimi' }],
    }, TODAY)
    if (!parsed.ok) throw new Error(parsed.why)
    const { clauses } = archiveClauses(archive)
    const merged = mergeExtractions(rulesExtract(archive, TODAY), parsed.value, undefined, undefined, clauses)
    expect(merged.cards.map(card => card.title)).toEqual(rulesExtract(archive, TODAY).cards.map(card => card.title))
    expect(merged.projects.map(one => one.name)).toEqual(['Lapis'])
  })

  it('模型没用上:照规则那一份,并记下原因', () => {
    const merged = mergeExtractions(rulesExtract(archive, TODAY), undefined, '模型超时(20 秒)')
    expect(merged).toMatchObject({ source: 'rules', model_note: '模型超时(20 秒)' })
  })
})

describe('小工具', () => {
  it('标题比对:「让她能自己扫仓库,不用你口述」与「让事务官能自己扫仓库,不用口述」是同一件', () => {
    expect(normalizeTitle('让她能自己扫仓库,不用你口述')).toBe(normalizeTitle('让事务官能自己扫仓库,不用口述'))
    expect(titleSimilarity('参赛网页架构收尾', '网页架构收尾')).toBeGreaterThan(0.72)
    expect(titleSimilarity('参赛视频', '服务器与手机版本同步')).toBeLessThan(0.3)
  })

  it('日子:9/29、28 号、10 月 4 日、2026-10-04', () => {
    expect(dateIn('他 9/29 回来', TODAY)).toBe('2026-09-29')
    expect(dateIn('Ben 28 号把东西放他桌上', TODAY)).toBe('2026-09-28')
    expect(dateIn('10 月 4 日截止', TODAY)).toBe('2026-10-04')
    expect(dateIn('2026-10-04(周日)', TODAY)).toBe('2026-10-04')
    expect(dateIn('下周', TODAY)).toBeUndefined()
  })

  it('例程与免打扰从他的话里取;说出来的时刻是人话', () => {
    expect(timesOf(archive)).toEqual({ morning: '08:30', evening: '20:30', quietFrom: '21:00', quietTo: '08:30' })
    expect(spokenTime('08:30')).toBe('早上 8 点半')
    expect(spokenTime('21:00')).toBe('晚上 9 点')
  })

  it('版本过时:提到 0.2.80,现在 0.2.83', () => {
    expect(staleVersionOf('查 0.2.80 真机聚球还卡不卡', '0.2.83')).toBe('0.2.80')
    expect(staleVersionOf('发 0.2.84', '0.2.83')).toBeUndefined()
    expect(staleVersionOf('让她能自己扫仓库', '0.2.83')).toBeUndefined()
  })

  it('撤掉的只列不撤,已经取消的不再列', () => {
    const list = cancelCandidates({ board: { tasks: tasksFile.tasks, sprints: [], modules: [] }, archive, currentVersion: '0.2.83' })
    expect(list.map(one => one.task.id)).toEqual(['t-fe044617', 't-b5302d3f', 't-26ad64dc', 't-d19da779', 't-991441d1', 't-af2d79df', 't-886ba5d8'])
    const after = cancelCandidates({ board: { tasks: tasksFile.tasks.map(task => ({ ...task, status: 'canceled' as const })), sprints: [], modules: [] }, archive, currentVersion: '0.2.83' })
    expect(after).toEqual([])
  })

  it('那一句:没有第一件时不提派活', () => {
    expect(planLine({ rows: [] })).toBe('都记好了,屏幕上有张单子,你看一眼,行吗?')
  })
})
