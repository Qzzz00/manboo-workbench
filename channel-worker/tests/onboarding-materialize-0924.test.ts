/**
 * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize)—— 工人这一头。
 *
 * 钉住:
 *   - 同一批 record_answer 里 `done` 放最后(真机上 projects.done 先到、projects.project 409);`import_memories` 在 `read_client_files` 后面;
 *   - 收尾那一段多等一会儿,「接着调 setup_preview」那句赶得上回话;
 *   - setup_preview:单子上屏,回话里**只说那一句**;setup_apply:带上次那张单子的 id、他说不要的那几件、他刚才那句话;落好了刷新简报;
 *   - 做完那一句不再「照复述清单说一遍」「以后我先开口」;收尾的系统提示不念清单、永不念文件路径;
 *   - 手机出了局域网也按得动「就这样」:房间代理白名单里有那两条;两件新工具算慢工具(垫一句)。
 */
import { describe, expect, it, vi } from 'vitest'
import { SLOW_TOOLS } from '../src/filler.ts'
import {
  TOOL_RECORD_ANSWER, TOOL_SETUP_APPLY, TOOL_SETUP_PREVIEW, answerRank, answerResultText, buildOnboardingInstructions, buildSetupInstructions,
  createOnboardingTools, parseOnboardingBrief, setupApplyText, setupPreviewText, type OnboardingBrief,
} from '../src/onboarding.ts'
import { isAllowedRpcPath } from '../src/rpc.ts'

type Workbench = Parameters<typeof createOnboardingTools>[0]['workbench']

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return { stage: 'projects', label: '②′ 项目', done: false, speak_seed: false, goals: [], keys: [
    { name: 'project', kind: 'project', desc: '项目', required: false },
    { name: 'done', kind: 'bool', desc: '聊完了', required: true },
    { name: 'read_client_files', kind: 'tri', desc: '读客户端文件', required: false },
    { name: 'import_memories', kind: 'bool', desc: '拷记忆', required: false },
  ], answered: {}, ...over }
}

describe('同一批 record_answer:done 放最后', () => {
  it('模型先交 done、再交 project(同一回合):工作台先收到 project,再收到 done', async () => {
    const order: string[] = []
    const workbench = {
      onboardingAnswer: async (input: { key: string }) => { order.push(input.key); return { status: 200, body: { ok: true, advanced: input.key === 'done' } } },
    } as unknown as Workbench
    const tools = createOnboardingTools({ workbench, brief: () => brief(), recordWaitMs: 200 })
    await Promise.all([
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'projects', key: 'done', value: 'true' }, {} as never),
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'projects', key: 'project', value: '{"name":"工作台","status":"快弄完了"}' }, {} as never),
    ])
    expect(order).toEqual(['project', 'done'])
  })

  it('③ 授权里同一批:先 read_client_files 再 import_memories(先授权再拷)', async () => {
    const order: string[] = []
    const workbench = { onboardingAnswer: async (input: { key: string }) => { order.push(input.key); return { status: 200, body: { ok: true, advanced: false } } } } as unknown as Workbench
    const tools = createOnboardingTools({ workbench, brief: () => brief({ stage: 'authorization' }), recordWaitMs: 200 })
    await Promise.all([
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'authorization', key: 'import_memories', value: 'true' }, {} as never),
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'authorization', key: 'read_client_files', value: '可以' }, {} as never),
    ])
    expect(order).toEqual(['read_client_files', 'import_memories'])
    expect([answerRank('project'), answerRank('import_memories'), answerRank('done')]).toEqual([0, 1, 2])
  })

  it('一项一项交:前一项落定了才交下一项', async () => {
    const events: string[] = []
    const workbench = {
      onboardingAnswer: async (input: { key: string }) => {
        events.push(`开始 ${input.key}`)
        await new Promise(resolve => setTimeout(resolve, 20))
        events.push(`落定 ${input.key}`)
        return { status: 200, body: { ok: true, advanced: false } }
      },
    } as unknown as Workbench
    const tools = createOnboardingTools({ workbench, brief: () => brief(), recordWaitMs: 500 })
    await Promise.all([
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'projects', key: 'project', value: '{"name":"a","status":"b"}' }, {} as never),
      tools[TOOL_RECORD_ANSWER].execute({ stage: 'projects', key: 'done', value: 'true' }, {} as never),
    ])
    expect(events).toEqual(['开始 project', '落定 project', '开始 done', '落定 done'])
  })
})

describe('收尾:做完那一刻接着把单子摆上屏', () => {
  it('做完 + setup_next:紧接着调 setup_preview,只说它那一句;不再「照复述清单说」「以后我先开口」', () => {
    const next = answerResultText({ status: 200, body: { ok: true, advanced: true, done: true, setup_next: true } })
    expect(next.text).toContain(`紧接着调 ${TOOL_SETUP_PREVIEW}`)
    expect(next.text).toContain('不念文件路径')
    expect(next.text).not.toContain('复述清单')
    expect(next.text).not.toContain('以后我先开口')
    const plain = answerResultText({ status: 200, body: { ok: true, advanced: true, done: true } })
    expect(plain.text).toContain('都记好了,有事叫我')
    expect(plain.text).not.toContain('以后我先开口')
  })

  it('收尾那一段多等一会儿:最后一项落得慢(阶段机在存版本)也把「接着调 setup_preview」带回来', async () => {
    const workbench = {
      onboardingAnswer: async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
        return { status: 200, body: { ok: true, advanced: true, done: true, setup_next: true } }
      },
    } as unknown as Workbench
    const tools = createOnboardingTools({ workbench, brief: () => brief({ stage: 'wrapup' }), recordWaitMs: 20, wrapupWaitMs: 1000 })
    const text = await tools[TOOL_RECORD_ANSWER].execute({ stage: 'wrapup', key: 'first_item', value: '让 Codex 把参赛网页架构补完' }, {} as never)
    expect(String(text)).toContain(TOOL_SETUP_PREVIEW)
  })

  it('收尾的系统提示:每轮两句、不复述、永不念文件路径;记下的只给她心里有数', () => {
    const text = buildOnboardingInstructions({ brief: brief({ stage: 'wrapup', label: '⑤ 收尾', keys: [], recap: '- 称呼:Ben' }) })
    expect(text).toContain('【收尾这一段】')
    expect(text).toContain('永不念文件路径')
    expect(text).toContain(TOOL_SETUP_PREVIEW)
    expect(text).not.toContain('【复述清单】')
    expect(text).toContain('不念、不复述')
  })
})

describe('setup_preview / setup_apply', () => {
  const LINE = '都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?'

  it('预览:单子上屏,只说那一句;落地带上那张单子的 id、他说不要的几件、他刚才那句话;落好了刷新简报', async () => {
    const applied: unknown[] = []
    const workbench = {
      onboardingMaterializePreview: async () => ({ status: 200, body: { ok: true, id: 'plan-1', line: LINE } }),
      onboardingMaterializeApply: async (input: unknown) => { applied.push(input); return { status: 200, body: { ok: true, line: '派出去了,做完叫你。', result: { ok: true } } } },
    } as unknown as Workbench
    const onAnswered = vi.fn()
    const started: string[] = []
    const heard = { asked: LINE, reply: '可以,视频那件不用' }
    const tools = createOnboardingTools({ workbench, brief: () => brief({ stage: 'done', done: true }), onAnswered, onStart: tool => started.push(tool), heard: () => heard })
    const preview = String(await tools[TOOL_SETUP_PREVIEW].execute({}, {} as never))
    expect(preview).toContain(`「${LINE}」`)
    expect(preview).toContain('只说这一句')
    const done = String(await tools[TOOL_SETUP_APPLY].execute({ skip: '视频那件' }, {} as never))
    expect(applied).toEqual([{ id: 'plan-1', skip: ['视频那件'], heard }])
    expect(done).toContain('「派出去了,做完叫你。」')
    expect(onAnswered).toHaveBeenCalledWith({ ok: true, advanced: true })
    expect(started).toEqual([TOOL_SETUP_PREVIEW, TOOL_SETUP_APPLY])
  })

  it('他没点头(409):先别落,问他要改哪;老工作台(没有这一步):一句话收,不念清单', async () => {
    expect(setupApplyText({ status: 409, body: { error: '他刚才说的是「等等」,听着没点头' } })).toEqual({ ok: false, text: '先别落:他刚才说的是「等等」,听着没点头' })
    expect(setupPreviewText({ status: 404, body: { error: '没接' } }).text).toContain('都记好了,有事叫我')
    const old = createOnboardingTools({ workbench: {} as Workbench, brief: () => brief() })
    expect(String(await old[TOOL_SETUP_PREVIEW].execute({}, {} as never))).toContain('别念清单')
  })

  it('他说不要的那件没认出来:照实说,让他在屏幕上改', () => {
    const text = setupApplyText({ status: 200, body: { ok: true, line: '派出去了,做完叫你。', result: { unmatched: ['飞书那件'] } } }).text
    expect(text).toContain('飞书那件')
    expect(text).toContain('屏幕上改')
  })

  it('做完了、单子还等他点头:只等他点头的那一套提示词', () => {
    const text = buildSetupInstructions({ brief: { setup: { pending: true, id: 'plan-1', line: LINE } }, butlerName: '拓麻鸽子' })
    expect(text).toContain('拓麻鸽子')
    expect(text).toContain(`「${LINE}」`)
    expect(text).toContain(TOOL_SETUP_APPLY)
    expect(text).toContain('永不念文件路径')
    const noLine = buildSetupInstructions({ brief: { setup: { pending: true } } })
    expect(noLine).toContain(`先调 ${TOOL_SETUP_PREVIEW}`)
  })

  it('简报认 setup 那一格;老工作台没有就缺席', () => {
    expect(parseOnboardingBrief({ stage: 'done', done: true, speak_seed: false, keys: [], setup: { pending: true, id: 'p', line: LINE } })?.setup)
      .toEqual({ pending: true, id: 'p', line: LINE })
    expect(parseOnboardingBrief({ stage: 'done', done: true, speak_seed: false, keys: [] })?.setup).toBeUndefined()
  })
})

describe('手机出了局域网也按得动;慢工具垫一句', () => {
  it('房间代理白名单:preview 与 apply 两条 POST', () => {
    expect(isAllowedRpcPath('POST', '/onboarding/materialize/preview')).toBe(true)
    expect(isAllowedRpcPath('POST', '/onboarding/materialize/apply')).toBe(true)
    expect(isAllowedRpcPath('GET', '/onboarding/materialize/apply')).toBe(false)
  })

  it('两件新工具算慢工具', () => {
    expect(SLOW_TOOLS).toContain(TOOL_SETUP_PREVIEW)
    expect(SLOW_TOOLS).toContain(TOOL_SETUP_APPLY)
  })
})
