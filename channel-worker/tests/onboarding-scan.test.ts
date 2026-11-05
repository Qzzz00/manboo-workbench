/**
 * ①「授权扫仓库,但是没去扫」与 ③「响应延迟有点高」(2026-09-20,Ben 真机第二轮)。
 *
 * 他那一通的日志里只有十几条 `record_answer`,**一次扫描都没有** —— 通话模式的工人
 * 手上只有「记一项」这一件工具,②′ 那一段它只能凭空问。这一组钉三件:
 *   ① `scan_projects` 真去调 8791,**开口那句「我看一下你的仓库」由工人自己说**(不等模型);
 *   ② 没授权时回的是「怎么拿到授权」,不是一句「我没权限」;
 *   ③ 「先说后记」:落盘慢就先回话,真没记上再补一句实话 —— 绝不「答应了但其实没记」。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RECORD_WAIT_MS,
  TOOL_RECORD_ANSWER,
  TOOL_SCAN_PROJECTS,
  buildOnboardingInstructions,
  createOnboardingTools,
  parseScanResult,
  scanResultText,
  type OnboardingBrief,
} from '../src/onboarding.ts'

type Deps = Parameters<typeof createOnboardingTools>[0]

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'projects',
    label: '②′ 项目',
    done: false,
    speak_seed: false,
    goals: [],
    keys: [{ name: 'read_scan_roots', kind: 'bool', desc: '读扫描根', required: false }],
    answered: {},
    ...over,
  }
}

const SCAN_BODY = {
  repos: [
    { name: 'desktop-workbench', path: '/Users/example/Documents/GitHub/desktop-workbench', last_commit: '2026-09-20T02:00:00Z', summary: '今天还在动;有 3 处还没提交' },
    { name: 'aiboo', path: '/Users/example/Documents/GitHub/aiboo', last_commit: '2026-09-12T02:00:00Z', summary: '1 周没动' },
  ],
  total: 13,
  more: 11,
  scanned_at: '2026-09-20T03:00:00Z',
  errors: [],
}

describe('scan_projects', () => {
  it('真去调 8791,并且**开跑那一下先报一声**(扫描要几秒,那几秒不能是安静的)', async () => {
    const started: string[] = []
    let called = 0
    const workbench = {
      onboardingScan: async () => { called += 1; return { status: 200, body: SCAN_BODY } },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief, onStart: name => started.push(name) })
    const text = String(await tools[TOOL_SCAN_PROJECTS].execute({}, {} as never))
    expect(called).toBe(1)
    // 09-20 第二版:开口那句不再由工人合成,而是广播一条信号,手机拿包里那句放出来。
    expect(started).toEqual([TOOL_SCAN_PROJECTS])
    expect(text).toContain('扫到 13 个仓库')
    expect(text).toContain('desktop-workbench')
    expect(text).toContain('还有 11 个没列出来')
    // 2026-09-23:只念候选让他挑,挑中的才录。
    expect(text).toContain('是哪个')
    expect(text).toContain('别一条条念完')
    expect(text).toContain('没挑的一个都不记')
  })

  it('带 name(2026-09-23 先问交哪一个):只找这一个,name 原样交给 8791;找到 / 没找到 / 同名多个各一句', async () => {
    const asked: (string | undefined)[] = []
    const workbench = {
      onboardingScan: async (name?: string) => { asked.push(name); return { status: 200, body: { query: '工作台', located: [{ name: '工作台', path: '/Users/x/工作台' }], errors: [] } } },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    const text = String(await tools[TOOL_SCAN_PROJECTS].execute({ name: ' 工作台 ' }, {} as never))
    expect(asked).toEqual(['工作台'])
    expect(text).toContain('找到了:工作台')
    expect(text).toContain('是这个吗')
    // 2026-09-24(已有项目拉齐):path 交给模型(记 project 时原样带上),注明别念 —— 以前丢了它,引导录的项目与项目区那一行靠不上。
    expect(text).toContain('path 是 /Users/x/工作台')
    expect(text).toContain('别念出来')
    expect(scanResultText({ status: 200, body: { query: 'foo', located: [], errors: [] } }).text).toContain('放在哪')
    expect(scanResultText({ status: 200, body: { query: 'a', located: [{ name: 'a', path: '/1/a' }, { name: 'a', path: '/2/a' }] } }).text).toContain('找到 2 个像的')
  })

  it('没给授权:回的是「怎么拿到授权」,不是一句「我没权限」', () => {
    const text = scanResultText({ status: 403, body: { error: '事务官还没有这项授权:读三个扫描根…' } })
    expect(text.ok).toBe(false)
    // 2026-09-24:「只看名字」那句作废 —— 找它、读它一起问(老工作台不带 note 时的兜底也是这一句)。
    expect(text.text).toContain('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?')
    expect(text.text).not.toContain('只看名字')
    expect(text.text).toContain('read_scan_roots')
    expect(text.text).toContain(TOOL_SCAN_PROJECTS)
    expect(text.text).toContain('他说不行就照访谈线问')
  })

  it('一个仓库都没扫到就如实说,**不让她退回去装作看过**', () => {
    expect(scanResultText({ status: 200, body: { repos: [], total: 0, more: 0, errors: [] } }).text)
      .toContain('一个 git 仓库都没有')
    expect(scanResultText({
      status: 200,
      body: { repos: [], total: 0, more: 0, errors: [{ root: '/Users/example/Documents/GitHub', reason: 'EACCES' }] },
    }).text).toContain('EACCES')
  })

  it('工作台连不上 / 回了 503:不抛,回一句能说出口的话', async () => {
    const workbench = { onboardingScan: async () => { throw new Error('boom') } } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    expect(String(await tools[TOOL_SCAN_PROJECTS].execute({}, {} as never))).toContain('连不上')
    expect(scanResultText({ status: 503, body: { error: '这台工作台没接项目区,扫不了仓库' } }).text)
      .toContain('没接项目区')
  })

  it('parseScanResult:读不懂就 undefined,不编一份清单', () => {
    expect(parseScanResult(null)).toBeUndefined()
    expect(parseScanResult({ total: 3 })).toBeUndefined()
    expect(parseScanResult({ repos: [{ name: 'a', summary: 'x' }] })?.repos[0]?.path).toBe('')
    expect(parseScanResult({ repos: [{ summary: 'x' }] })?.repos).toEqual([])
  })
})

describe('系统提示里的扫描那一段', () => {
  it('这一段能扫就写进去(key 里有 read_scan_roots)', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain(TOOL_SCAN_PROJECTS)
    expect(text).toContain('先问交哪一个,不先扫')
    expect(text).toContain('带上 name')
    expect(text).toContain('素材不是结论')
  })

  it('开场那一段**一个字都不提扫描**(不然她一上来就想读人家的硬盘)', () => {
    const text = buildOnboardingInstructions({
      brief: brief({ stage: 'opening', keys: [{ name: 'nickname', kind: 'string', desc: '称呼', required: true }] }),
    })
    expect(text).not.toContain(TOOL_SCAN_PROJECTS)
    expect(text).not.toContain('扫一')
  })

  it('「先说后记」写在说话规矩里', () => {
    expect(buildOnboardingInstructions({ brief: brief() })).toContain('先说后记')
  })
})

describe('先说后记', () => {
  function slowWorkbench(delayMs: number, reply: { status: number, body: unknown }) {
    return {
      onboardingAnswer: async () => {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        return reply
      },
    } as unknown as Deps['workbench']
  }

  it('落得快(常态)→ 回话和以前一模一样,「下一段问什么」一个字没少', async () => {
    const workbench = slowWorkbench(0, {
      status: 200,
      body: { ok: true, advanced: true, next: { label: '②′ 项目', seed: '先聊哪个?' } },
    })
    const tools = createOnboardingTools({ workbench, brief, recordWaitMs: 200 })
    const text = String(await tools[TOOL_RECORD_ANSWER].execute({ stage: 'branch', key: 'mode', value: 'existing' }, {} as never))
    expect(text).toContain('②′ 项目')
    expect(text).toContain('先聊哪个?')
  })

  it('落得慢 → 先回一句「在后台记着」,不让他在电话那头干等', async () => {
    const workbench = slowWorkbench(120, { status: 200, body: { ok: true, advanced: false } })
    const tools = createOnboardingTools({ workbench, brief, recordWaitMs: 10 })
    const text = String(await tools[TOOL_RECORD_ANSWER].execute({ stage: 'branch', key: 'mode', value: 'existing' }, {} as never))
    expect(text).toContain('在后台记着')
    expect(text).toContain('接着往下说')
  })

  it('后台真没记上 → 补一句实话(绝不「答应了但其实没记」)', async () => {
    const said: string[] = []
    const workbench = slowWorkbench(30, { status: 400, body: { error: 'key 不在这一阶段的白名单里' } })
    const tools = createOnboardingTools({ workbench, brief, recordWaitMs: 1, say: text => said.push(text) })
    await tools[TOOL_RECORD_ANSWER].execute({ stage: 'branch', key: 'mode', value: 'existing' }, {} as never)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(said).toEqual(['刚才那条我没记上,等会儿我再记一次。'])
  })

  it('赶上了回话的失败不再补那一句(话里已经说了「没记上」)', async () => {
    const said: string[] = []
    const workbench = slowWorkbench(0, { status: 400, body: { error: '不认这个 key' } })
    const tools = createOnboardingTools({ workbench, brief, recordWaitMs: 200, say: text => said.push(text) })
    const text = String(await tools[TOOL_RECORD_ANSWER].execute({ stage: 'branch', key: 'x', value: '1' }, {} as never))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(text).toContain('没记上')
    expect(said).toEqual([])
  })

  it('后台那条路炸了也不把通话带走(未处理拒绝是会掀翻工人进程的)', async () => {
    const said: string[] = []
    const log = vi.fn()
    const workbench = {
      onboardingAnswer: async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('boom') },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief, recordWaitMs: 1, say: t => said.push(t), log })
    await tools[TOOL_RECORD_ANSWER].execute({ stage: 'branch', key: 'mode', value: 'existing' }, {} as never)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(said).toEqual(['刚才那条我没记上,等会儿我再记一次。'])
  })

  it('等 400 毫秒:回环 POST 通常几十毫秒,慢的是阶段机那一次 git commit', () => {
    expect(RECORD_WAIT_MS).toBe(400)
  })
})
