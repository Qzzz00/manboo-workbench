/**
 * 已有项目拉齐(2026-09-24,维护者 12:40:「我真的很需要她能扫仓库啊,不然我还得口述一遍吗」)——工人这一头。
 * 设计 docs/设计-已有项目拉齐-2026-09-24.md 第三节;8791 那一头在 workbench-plugin/tests/server-onboarding-project-brief-http.test.ts。
 *
 * 钉住:
 *   - 找到唯一一个时,path(注明别念)、摘要与工作台的 note **原样**交给模型(顺手修掉「path 丢了」那个漏);
 *   - 候选 / 多个匹配也把 path 交给模型,念只念名字;
 *   - 新工具 read_project:带 path 走 project-brief、只有名字走按名字找;开跑报一声(慢工具);
 *   - 403 两种:没授权 → 工作台那段「先问后看」原样交出去(问句是新的那句);新点子那一支 → 别再调、别提;
 *   - 系统提示 ②′ 按新顺序(找到就读、用读到的问「是这个吗」、不问「你手上有哪些事」、改口先问);新点子那一支一个字不提;
 *   - 读目录那一问与工作台 projectBrief.ts 的 ASK_TO_READ 逐字相同;
 *   - 2026-09-24 下午小修:改口时「直接照那句问」,系统提示与兜底里都没有「再问一遍」;找到时已读好就不用再调 read_project。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FillerSignaller, SLOW_TOOLS, type FillerSignal } from '../src/filler.ts'
import {
  ASK_TO_READ,
  TOOL_READ_PROJECT,
  TOOL_RECORD_ANSWER,
  TOOL_SCAN_PROJECTS,
  buildOnboardingInstructions,
  createOnboardingTools,
  projectBriefText,
  scanResultText,
  type OnboardingBrief,
} from '../src/onboarding.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

type Deps = Parameters<typeof createOnboardingTools>[0]

/** 工作台 note 的替身:用例只关心它被**原样**交出去,不关心它说了什么。 */
const NOTE = '上面是从他仓库里读来的素材(不是结论)。1. 一次说完……最后只问一句「是这个吗?」'
const BRIEF = '【项目】desktop-workbench\n读了:说明(README.md)、最近的交接(docs/交接-0924-统筹会话交接.md)。\n\n【说明】README.md\n一个记得你、替你组织工作、随叫随到的事务官。'
const PATH = '/Users/example/Documents/GitHub/desktop-workbench'

function projectsBrief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'projects',
    label: '②′ 项目(A 授权线∥访谈线 / B 从零)',
    done: false,
    speak_seed: false,
    goals: [],
    keys: [
      { name: 'read_scan_roots', kind: 'bool', desc: '读三个扫描根', required: false },
      { name: 'project', kind: 'project', desc: '项目的一项或几项', required: false },
      { name: 'done', kind: 'bool', desc: '聊完了', required: true },
    ],
    answered: { opening: ['nickname'], branch: ['mode'], template: ['template'] },
    nickname: 'Ben',
    mode: 'existing',
    ...over,
  }
}

describe('找到唯一一个:path、摘要与 note 原样交给模型', () => {
  it('scan 回包带着 brief:path(别念)+ 摘要 + 【怎么用】= 工作台的 note,一字不差', () => {
    const got = scanResultText({
      status: 200,
      body: { query: '工作台', located: [{ name: 'desktop-workbench', path: PATH }], brief: BRIEF, sources: [], note: NOTE },
    })
    expect(got.ok).toBe(true)
    expect(got.text).toContain(`path 是 ${PATH}`)
    expect(got.text).toContain('别念出来')
    expect(got.text).toContain(BRIEF)
    expect(got.text).toContain(`【怎么用】\n${NOTE}`)
  })

  it('读项目的回包:同一段 note 原样交出去(两条路拿到的是同一段)', () => {
    const got = projectBriefText({ status: 200, body: { ok: true, name: 'desktop-workbench', path: PATH, brief: BRIEF, sources: [], note: NOTE } })
    expect(got.ok).toBe(true)
    expect(got.text).toContain(`【怎么用】\n${NOTE}`)
    expect(got.text).toContain(`path 是 ${PATH}`)
    const viaScan = scanResultText({ status: 200, body: { located: [{ name: 'desktop-workbench', path: PATH }], brief: BRIEF, note: NOTE } }).text
    expect(viaScan.slice(viaScan.indexOf('【读到的摘要】'))).toBe(got.text.slice(got.text.indexOf('【读到的摘要】')))
  })

  it('老工作台(回包没有 brief):path 照样交给模型,告诉它要读就调 read_project', () => {
    const got = scanResultText({ status: 200, body: { query: '工作台', located: [{ name: 'desktop-workbench', path: PATH }], note: '他确认之后记 project 时把 path 原样带上(project.path)' } })
    expect(got.text).toContain(`path 是 ${PATH}`)
    expect(got.text).toContain('是这个吗')
    expect(got.text).toContain(TOOL_READ_PROJECT)
    expect(got.text).toContain('工作台的话:他确认之后记 project 时把 path 原样带上(project.path)')
  })
})

describe('几个像的 / 候选:path 交给模型,念只念名字', () => {
  it('多个匹配:名字一句念,path 单独一行注明别念,挑中了带 path 调 read_project', () => {
    const got = scanResultText({ status: 200, body: { query: 'workbench', located: [{ name: 'desktop-workbench', path: '/u/desktop-workbench' }, { name: 'ben-dsh-workbench', path: '/u/ben-dsh-workbench' }] } })
    const [say, paths] = got.text.split('\n')
    expect(say).toContain('找到 2 个像的:desktop-workbench、ben-dsh-workbench')
    expect(say).toContain(TOOL_READ_PROJECT)
    expect(say).not.toContain('/u/')
    expect(paths).toContain('desktop-workbench → /u/desktop-workbench;ben-dsh-workbench → /u/ben-dsh-workbench')
    expect(paths).toContain('**别念**')
  })

  it('整份扫出来的清单:最后一行是各自的 path(别念),挑中了带它读', () => {
    const got = scanResultText({
      status: 200,
      body: { repos: [{ name: 'desktop-workbench', path: '/u/dw', summary: '今天还在动' }, { name: 'Aiboo', path: '/u/a', summary: '1 周没动' }], total: 2, more: 0, errors: [] },
    })
    expect(got.text).toContain(`挑中了调 ${TOOL_READ_PROJECT} 带上它的 path 读一遍`)
    expect(got.text).toContain('desktop-workbench → /u/dw;Aiboo → /u/a')
  })
})

describe('403 两种', () => {
  it('没授权:工作台那段「先问后看」原样交出去,后面补电话里用哪件工具', () => {
    const consentNote = `还没有读目录的授权……先问他一句「${ASK_TO_READ}」……他后来改口……`
    for (const got of [
      scanResultText({ status: 403, body: { error: '事务官还没有这项授权', reason: 'consent', note: consentNote } }),
      projectBriefText({ status: 403, body: { error: '事务官还没有这项授权', reason: 'consent', note: consentNote } }),
    ]) {
      expect(got.ok).toBe(false)
      expect(got.text.startsWith(consentNote)).toBe(true)
      expect(got.text).toContain(`${TOOL_RECORD_ANSWER} 把 read_scan_roots 记成 true`)
      expect(got.text).toContain(TOOL_SCAN_PROJECTS)
    }
  })

  it('老工作台 403 不带 note:兜底那段用的也是新问句;改口时直接照这句问,不说过程话(2026-09-24 下午小修)', () => {
    const got = scanResultText({ status: 403, body: { error: '事务官还没有这项授权' } })
    expect(got.text).toContain(`「${ASK_TO_READ}」`)
    expect(got.text).toContain('他后来改口说「你去看吧」:直接照这句问他,像头一回问那样,不提前面问过,也不说「确认一下」这类话')
    expect(got.text).not.toContain('再问一遍')
    expect(got.text).not.toContain('只看名字')
  })

  it('新点子 / 运营那一支:别再调、别提读仓库', () => {
    const body = { error: '这一段是新点子 / 账号那一支:不找也不读他的目录。', reason: 'branch' }
    for (const got of [scanResultText({ status: 403, body }), projectBriefText({ status: 403, body })]) {
      expect(got.text).toContain('不找也不读')
      expect(got.text).toContain(`别再调 ${TOOL_SCAN_PROJECTS} / ${TOOL_READ_PROJECT}`)
      expect(got.text).not.toContain(ASK_TO_READ)
    }
  })

  it('路径不认 / 不存在:如实说没读成,别自己猜;工作台挂了也一样', () => {
    expect(projectBriefText({ status: 403, body: { error: '这个目录不在能读的范围里', reason: 'outside' } }).text).toContain('别自己猜里面写了什么')
    expect(projectBriefText({ status: 400, body: { error: '路径里不能有「..」', reason: 'dotdot' } }).text).toContain('没读成')
    expect(projectBriefText({ status: 404, body: { error: '这个目录不存在', reason: 'missing' } }).text).toContain('没读成')
    expect(projectBriefText({ status: 503, body: { error: '这台工作台没接读项目' } }).text).toContain('别装作读过')
  })
})

describe('read_project 工具', () => {
  it('带 path:走 project-brief,开跑报一声;读回来的摘要与 note 原样交给模型', async () => {
    const asked: string[] = []
    const started: string[] = []
    const logs: string[] = []
    const workbench = {
      onboardingProjectBrief: async (path: string) => {
        asked.push(path)
        return { status: 200, body: { ok: true, name: 'desktop-workbench', path, brief: BRIEF, sources: [{ label: '说明' }, { label: '最近的交接' }], note: NOTE } }
      },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief: () => projectsBrief(), onStart: name => started.push(name), log: line => logs.push(line) })
    const text = String(await tools[TOOL_READ_PROJECT].execute({ path: ` ${PATH} ` }, {} as never))
    expect(asked).toEqual([PATH])
    expect(started).toEqual([TOOL_READ_PROJECT])
    expect(text).toContain(BRIEF)
    expect(text).toContain(NOTE)
    // 日志记调用与返回的大小、读了哪几份,**不记内容**。
    expect(logs.join('\n')).toContain(`引导读项目 ${PATH} → 200`)
    expect(logs.join('\n')).toContain('(说明、最近的交接)')
    expect(logs.join('\n')).not.toContain('一个记得你')
  })

  it('只有名字:走按名字找(只找到一个时回包里同样带摘要)', async () => {
    const named: (string | undefined)[] = []
    const workbench = {
      onboardingScan: async (name?: string) => {
        named.push(name)
        return { status: 200, body: { query: name, located: [{ name: 'desktop-workbench', path: PATH }], brief: BRIEF, note: NOTE } }
      },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief: () => projectsBrief() })
    const text = String(await tools[TOOL_READ_PROJECT].execute({ name: '工作台' }, {} as never))
    expect(named).toEqual(['工作台'])
    expect(text).toContain(NOTE)
  })

  it('什么都没带:先问是哪一个;工作台连不上:如实说', async () => {
    const workbench = { onboardingProjectBrief: async () => { throw new Error('boom') } } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief: () => projectsBrief() })
    expect(String(await tools[TOOL_READ_PROJECT].execute({}, {} as never))).toContain('先问他是哪个项目')
    expect(String(await tools[TOOL_READ_PROJECT].execute({ path: PATH }, {} as never))).toContain('连不上')
  })

  it('是慢工具:开跑那一下往房间报一声(filler.ts SLOW_TOOLS)', () => {
    expect(SLOW_TOOLS).toContain(TOOL_READ_PROJECT)
    const sent: FillerSignal[] = []
    const signaller = new FillerSignaller({ send: signal => sent.push(signal), now: () => 1 })
    signaller.thinking()
    expect(signaller.toolStarted(TOOL_READ_PROJECT)).toBe(true)
    expect(sent.at(-1)).toMatchObject({ kind: 'tool', tool: TOOL_READ_PROJECT })
  })

  it('工作台客户端:POST /onboarding/project-brief,body 只有 path', async () => {
    const calls: { url: string, init: RequestInit | undefined }[] = []
    const client = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791/',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ ok: true, brief: 'x' }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const got = await client.onboardingProjectBrief(PATH)
    expect(got).toEqual({ status: 200, body: { ok: true, brief: 'x' } })
    expect(calls[0]?.url).toBe('http://127.0.0.1:8791/onboarding/project-brief')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ path: PATH })
  })
})

describe('系统提示 ②′', () => {
  it('已有项目:找到就读、用读到的问「是这个吗」、复述两句、不问「你手上有哪些事」、改口先问;问句是新的那句', () => {
    const text = buildOnboardingInstructions({ brief: projectsBrief() })
    expect(text).toContain(TOOL_READ_PROJECT)
    expect(text).toContain(`「${ASK_TO_READ}」`)
    expect(text).not.toContain('只看名字')
    expect(text).toContain('只找到一个时,工作台已经顺手读好了')
    expect(text).toContain('照【怎么用】说')
    expect(text).toContain('两句以内复述它做什么、给谁、现在到哪,再问「是这个吗」')
    expect(text).toContain('这一段不问「你手上有哪些事」')
    expect(text).toContain('他后来改口说「你去看吧」:**直接照上面那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话')
    expect(text).toContain('带上那一个的 path')
  })

  it('2026-09-24 下午小修:找到时已经读好就不用再调 read_project;改口那一条里没有「再问一遍」', () => {
    const text = buildOnboardingInstructions({ brief: projectsBrief() })
    expect(text).toContain(`回话里有摘要和【怎么用】,不用再调 ${TOOL_READ_PROJECT},**照【怎么用】说**`)
    const changeOfMind = text.split('\n').filter(line => line.includes('你去看吧'))
    expect(changeOfMind.length).toBeGreaterThan(0)
    for (const line of changeOfMind) expect(line).not.toContain('再问一遍')
  })

  it('新点子那一支(这一段的 key 里没有 read_scan_roots):一个字都不提找、读', () => {
    const text = buildOnboardingInstructions({
      brief: projectsBrief({
        mode: 'fresh',
        label: '②′ 从零开始(B1 点子访谈 → B2 立项)',
        keys: [{ name: 'idea', kind: 'idea', desc: '点子', required: true }, { name: 'plan', kind: 'plan', desc: '方案', required: false }],
      }),
    })
    expect(text).not.toContain(TOOL_READ_PROJECT)
    expect(text).not.toContain(TOOL_SCAN_PROJECTS)
    expect(text).not.toContain(ASK_TO_READ)
  })
})

describe('两边同一句', () => {
  it('读目录那一问与工作台 projectBrief.ts 的 ASK_TO_READ 逐字相同', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'projectBrief.ts'), 'utf8')
    expect(source).toContain(`export const ASK_TO_READ = '${ASK_TO_READ}'`)
  })
})
