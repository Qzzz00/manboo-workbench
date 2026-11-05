/**
 * 引导模式(2026-09-18):简报解析、值的还原、交答案之后说给模型的那句话、系统提示怎么拼,
 * 以及房间里那条「我在做引导」的消息。**全是纯函数**,不起房间、不连工作台。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  answerResultText,
  buildOnboardingInstructions,
  coerceAnswerValue,
  createOnboardingTools,
  leadsOnDesktop,
  parseOnboardingBrief,
  TOOL_RECORD_ANSWER,
  type OnboardingBrief,
} from '../src/onboarding.ts'
import { handleRpcRequest, parseRpcRequest, type RpcOnboardingPort, type RpcWorkbenchPort } from '../src/rpc.ts'

const OPENING = '你好,很高兴认识你,我是你的专属事务官。……首先,你希望我怎么称呼你?'

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'opening',
    label: '① 开场',
    done: false,
    seed: OPENING,
    speak_seed: true,
    goals: ['用户希望被怎么称呼'],
    keys: [{ name: 'nickname', kind: 'string', desc: '称呼(以后就这么叫)', required: true }],
    answered: {},
    ...over,
  }
}

describe('parseOnboardingBrief', () => {
  it('形状对就照收,缺 stage 就当没拿到(不猜一个阶段出来问人)', () => {
    const parsed = parseOnboardingBrief({
      stage: 'branch', label: '② 分岔', done: false, speak_seed: true, seed: '你现在……',
      goals: ['A 还是 B'], keys: [{ name: 'mode', kind: 'mode', desc: 'existing / fresh', required: true }],
      answered: { opening: ['nickname'] }, nickname: 'Ben', skill: '# 引导',
    })
    expect(parsed?.stage).toBe('branch')
    expect(parsed?.keys[0]).toEqual({ name: 'mode', kind: 'mode', desc: 'existing / fresh', required: true })
    expect(parsed?.nickname).toBe('Ben')

    expect(parseOnboardingBrief({ label: '没有 stage' })).toBeUndefined()
    expect(parseOnboardingBrief(null)).toBeUndefined()
    expect(parseOnboardingBrief('文字')).toBeUndefined()
  })

  it('坏掉的 keys 项跳过,不让一条脏数据把整份简报废掉', () => {
    const parsed = parseOnboardingBrief({
      stage: 'habits', speak_seed: false,
      keys: [{ name: 'rhythm', kind: 'string' }, { desc: '没名字' }, null],
    })
    expect(parsed?.keys).toEqual([{ name: 'rhythm', kind: 'string', desc: '', required: false }])
    expect(parsed?.speak_seed).toBe(false)
  })
})

describe('coerceAnswerValue', () => {
  it('文字类一律当文字:称呼答「5」不能变成数字', () => {
    expect(coerceAnswerValue('string', '5')).toBe('5')
    expect(coerceAnswerValue('string', ' Ben ')).toBe('Ben')
    expect(coerceAnswerValue('string', '「小满」')).toBe('小满')
    expect(coerceAnswerValue('time', '18:30')).toBe('18:30')
    expect(coerceAnswerValue('mode', 'fresh')).toBe('fresh')
  })

  it('是非、三档、旋钮:模型怎么写都还原得回去', () => {
    expect(coerceAnswerValue('bool', 'true')).toBe(true)
    expect(coerceAnswerValue('bool', '可以')).toBe(true)
    expect(coerceAnswerValue('bool', '不可以')).toBe(false)
    expect(coerceAnswerValue('tri', '要问')).toBe('ask')
    expect(coerceAnswerValue('tri', 'false')).toBe(false)
    expect(coerceAnswerValue('knob', '4')).toBe(4)
    expect(coerceAnswerValue('knob', '很直接')).toBe('很直接')
  })

  it('对象与数组走 JSON;解不开就原样交上去,让阶段机回一句人话', () => {
    expect(coerceAnswerValue('idea', '{"name":"晨读机","one_liner":"x"}')).toEqual({ name: '晨读机', one_liner: 'x' })
    expect(coerceAnswerValue('strings', '["一","二"]')).toEqual(['一', '二'])
    expect(coerceAnswerValue('project', '不是 JSON')).toBe('不是 JSON')
  })
})

describe('coerceAnswerValue:常用应用(apps)', () => {
  it('JSON 数组原样收;一串「Claude、微信」按分隔符切开', () => {
    expect(coerceAnswerValue('apps', '["Claude","微信"]')).toEqual(['Claude', '微信'])
    expect(coerceAnswerValue('apps', 'Claude、微信,Kimi')).toEqual(['Claude', '微信', 'Kimi'])
  })

  it('只说一个也成数组;空格不切(「Claude Code」是一个名字)', () => {
    expect(coerceAnswerValue('apps', '微信')).toEqual(['微信'])
    expect(coerceAnswerValue('apps', 'Claude Code、微信')).toEqual(['Claude Code', '微信'])
  })
})

describe('parseOnboardingBrief:扫到装了哪几家', () => {
  it('照收 installed_apps;缺 label 退回 key;整格缺席就没有这一格', () => {
    const parsed = parseOnboardingBrief({
      stage: 'habits', speak_seed: false, keys: [],
      installed_apps: [{ key: 'claude', label: 'Claude' }, { key: 'kimi' }, { label: '没 key' }],
    })
    expect(parsed?.installed_apps).toEqual([{ key: 'claude', label: 'Claude' }, { key: 'kimi', label: 'kimi' }])
    expect(parseOnboardingBrief({ stage: 'habits', speak_seed: false, keys: [] })?.installed_apps).toBeUndefined()
  })
})

describe('answerResultText', () => {
  it('推进了:告诉模型下一段是什么、紧接着问哪一句', () => {
    const result = answerResultText({ status: 200, body: { ok: true, advanced: true, done: false, next: { label: '② 分岔', seed: '你现在是已经有在做的事,还是想从一个新点子开始?' } } })
    expect(result).toMatchObject({ ok: true, advanced: true })
    expect(result.text).toContain('② 分岔')
    expect(result.text).toContain('你现在是已经有在做的事')
  })

  it('没推进:接着弄清剩下的;做完了:一句话收,不念复述清单与文件路径(2026-09-24 晚,引导落地)', () => {
    expect(answerResultText({ status: 200, body: { ok: true, advanced: false } }).text).toContain('还没完')
    const done = answerResultText({ status: 200, body: { ok: true, advanced: true, done: true } }).text
    expect(done).toContain('都记好了')
    expect(done).toContain('不念文件路径')
  })

  it('400 / 409:原话转达,并明说不许假装记下了', () => {
    const bad = answerResultText({ status: 400, body: { error: '「① 开场」只能写 nickname,没有 butler_name' } })
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain('只能写 nickname')
    expect(bad.text).toContain('别假装记下了')
  })
})

describe('buildOnboardingInstructions', () => {
  it('技能全文、当前阶段、要弄清的、值的形状、工具名都在;开场白一字不改', () => {
    const text = buildOnboardingInstructions({ brief: brief({ skill: '# 引导\n三条铁律' }), butlerName: '小满', style: '话少,先结论后理由。' })
    expect(text).toContain('小满')
    expect(text).toContain('话少,先结论后理由。')
    expect(text).toContain('① 开场')
    expect(text).toContain(OPENING)
    expect(text).toContain('用户希望被怎么称呼')
    expect(text).toContain(TOOL_RECORD_ANSWER)
    expect(text).toContain('nickname *(必答)')
    expect(text).toContain('三条铁律')
  })

  it('种子句已经出过声:提示里明说别重复(挂断再进来不重念开场白)', () => {
    const text = buildOnboardingInstructions({ brief: brief({ speak_seed: false }) })
    expect(text).toContain('已经问出去了')
  })

  it('④ 习惯这一段带「扫到装了哪几家」:照着念,没扫到的别编', () => {
    const text = buildOnboardingInstructions({
      brief: brief({
        stage: 'habits',
        label: '④ 习惯偏好',
        keys: [{ name: 'apps', kind: 'apps', desc: '常用应用', required: false }],
        installed_apps: [{ key: 'claude', label: 'Claude' }, { key: 'kimi', label: 'Kimi' }, { key: 'wechat', label: '微信' }],
      }),
    })
    expect(text).toContain('Claude、Kimi、微信')
    expect(text).toContain('别编')
  })

  it('没扫过就一个字都不提(不猜他装了什么)', () => {
    const text = buildOnboardingInstructions({ brief: brief({ stage: 'habits', label: '④ 习惯偏好' }) })
    expect(text).not.toContain('扫到装了')
  })

  it('答过的列出来并叮嘱不要再问;读不到技能就如实说一句,不编一份', () => {
    const text = buildOnboardingInstructions({
      brief: brief({ answered: { opening: ['nickname'] }, skill_note: '读不到引导技能(.dsh/skills/引导/SKILL.md)' }),
    })
    expect(text).toContain('不要再问一遍')
    expect(text).toContain('opening(nickname)')
    expect(text).toContain('读不到引导技能')
  })
})

describe('record_answer 工具', () => {
  function workbenchStub(reply: { status: number, body: unknown }) {
    const calls: unknown[] = []
    const workbench = {
      onboardingAnswer: async (input: unknown) => { calls.push(input); return reply },
    } as unknown as Parameters<typeof createOnboardingTools>[0]['workbench']
    return { workbench, calls }
  }

  it('按当前阶段那个 key 的形状还原值,再交给阶段机', async () => {
    const { workbench, calls } = workbenchStub({ status: 200, body: { ok: true, advanced: true, next: { label: '② 分岔', seed: '……' } } })
    const onAnswered = vi.fn()
    const tools = createOnboardingTools({ workbench, brief: () => brief({ keys: [{ name: 'candor', kind: 'knob', desc: '直言度', required: true }] }), onAnswered })
    const text = await tools[TOOL_RECORD_ANSWER].execute({ stage: 'persona', key: 'candor', value: '4' }, {} as never)
    expect(calls[0]).toEqual({ stage: 'persona', key: 'candor', value: 4 })
    expect(String(text)).toContain('② 分岔')
    expect(onAnswered).toHaveBeenCalledWith({ ok: true, advanced: true })
  })

  it('2026-09-23:交答案时带上「她问了什么、他答了什么」(heard),工作台据此判断是不是问出口了、他点没点头', async () => {
    const { workbench, calls } = workbenchStub({ status: 200, body: { ok: true, advanced: false } })
    const heard = { asked: '为了找到它,我得看一眼你放代码的那个目录,只看名字,可以吗?', reply: '可以' }
    const tools = createOnboardingTools({ workbench, brief: () => brief({ keys: [{ name: 'read_scan_roots', kind: 'bool', desc: '读目录', required: false }] }), heard: () => heard })
    await tools[TOOL_RECORD_ANSWER].execute({ stage: 'projects', key: 'read_scan_roots', value: 'true' }, {} as never)
    expect(calls[0]).toEqual({ stage: 'projects', key: 'read_scan_roots', value: true, heard })
    // 没接 heard(老接线)或他还没开口:不带这一项。
    const bare = workbenchStub({ status: 200, body: { ok: true, advanced: false } })
    const plain = createOnboardingTools({ workbench: bare.workbench, brief: () => brief(), heard: () => undefined })
    await plain[TOOL_RECORD_ANSWER].execute({ stage: 'opening', key: 'nickname', value: 'Ben' }, {} as never)
    expect(bare.calls[0]).toEqual({ stage: 'opening', key: 'nickname', value: 'Ben' })
  })

  it('工作台连不上:回一句能说出口的话,不抛', async () => {
    const workbench = { onboardingAnswer: async () => { throw new Error('boom') } } as unknown as Parameters<typeof createOnboardingTools>[0]['workbench']
    const tools = createOnboardingTools({ workbench, brief: () => brief() })
    const text = await tools[TOOL_RECORD_ANSWER].execute({ stage: 'opening', key: 'nickname', value: 'Ben' }, {} as never)
    expect(String(text)).toContain('连不上')
  })
})

describe('房间里那条「我在做引导」', () => {
  const workbench = {} as RpcWorkbenchPort

  it('parse:认 start / resume / say / stop;别的动作回一句人话;say 必须带话', () => {
    const started = parseRpcRequest(JSON.stringify({ id: '1', type: 'onboarding', action: 'start' }))
    expect(started).toEqual({ ok: true, request: { id: '1', type: 'onboarding', action: 'start' } })
    const said = parseRpcRequest(JSON.stringify({ id: '2', type: 'onboarding', action: 'say', text: ' 叫我 Ben ' }))
    expect(said).toEqual({ ok: true, request: { id: '2', type: 'onboarding', action: 'say', text: '叫我 Ben' } })
    expect(parseRpcRequest(JSON.stringify({ id: '3', type: 'onboarding', action: '飞起来' }))).toMatchObject({ ok: false, id: '3' })
    expect(parseRpcRequest(JSON.stringify({ id: '4', type: 'onboarding', action: 'say' }))).toMatchObject({ ok: false, id: '4' })
  })

  it('handle:接上了回 stage;没接话模型时如实说一句,不假装接上了', async () => {
    const port: RpcOnboardingPort = {
      begin: async (resume) => ({ ok: true, stage: resume ? 'habits' : 'opening' }),
      say: async () => ({ ok: true }),
      stop: async () => {},
    }
    const begun = await handleRpcRequest({ id: 'a', type: 'onboarding', action: 'resume' }, { deviceId: 'dev', workbench, onboarding: port })
    expect(begun).toEqual({ id: 'a', type: 'onboarding', ok: true, stage: 'habits' })

    const none = await handleRpcRequest({ id: 'b', type: 'onboarding', action: 'start' }, { deviceId: 'dev', workbench })
    expect(none).toMatchObject({ id: 'b', type: 'onboarding', ok: false })
    expect(String((none as { error?: string }).error)).toContain('接不了引导')
  })

  it('handle:港口抛异常也要回一条,别让手机等到超时', async () => {
    const port: RpcOnboardingPort = {
      begin: async () => { throw new Error('工作台连不上') },
      say: async () => ({ ok: true }),
      stop: async () => {},
    }
    const result = await handleRpcRequest({ id: 'c', type: 'onboarding', action: 'start' }, { deviceId: 'dev', workbench, onboarding: port })
    expect(result).toEqual({ id: 'c', type: 'onboarding', ok: false, error: '工作台连不上' })
  })
})

describe('房间里那条「打个招呼」(2026-09-18)', () => {
  const workbench = {} as RpcWorkbenchPort

  it('parse:只认 start;别的动作回一句人话', () => {
    expect(parseRpcRequest(JSON.stringify({ id: '1', type: 'call', action: 'start' })))
      .toEqual({ ok: true, request: { id: '1', type: 'call', action: 'start' } })
    expect(parseRpcRequest(JSON.stringify({ id: '2', type: 'call', action: '唱首歌' }))).toMatchObject({ ok: false, id: '2' })
  })

  /** 主动来电那两条在 tests/call-out.test.ts 里单独钉;这里只为把 RpcCallPort 填齐。 */
  const noAnswer = async () => ({ ok: false, error: '这份测试不管来电' })

  it('handle:普通通话才有招呼;没有接话模型时如实说一句', async () => {
    const greet = vi.fn(async () => ({ ok: true }))
    const said = await handleRpcRequest({ id: 'a', type: 'call', action: 'start' }, { deviceId: 'dev', workbench, call: { greet, answer: noAnswer, later: noAnswer } })
    expect(said).toEqual({ id: 'a', type: 'call', ok: true })
    expect(greet).toHaveBeenCalledOnce()

    const none = await handleRpcRequest({ id: 'b', type: 'call', action: 'start' }, { deviceId: 'dev', workbench })
    expect(none).toMatchObject({ id: 'b', type: 'call', ok: false })
    expect(String((none as { error?: string }).error)).toContain('接不了话')
  })

  /**
   * ★ 提机即拨出(2026-09-23,Ben 定:「拿起电话就打过去」)。
   *
   * 派待机时拿起听筒发的就是这一条 `start`。招呼必须**从那只听筒里**出来:
   * 座机形态下房里同时有手机和听筒,不带身份就会退回 pickSpeaker 的「现任不换」,
   * 她对着搁在外壳里的手机说话,而他正举着听筒 —— 那正是 9/22 晚真机上那个毛病的反面。
   */
  it('★ 听筒拨出去那条 start 把「谁拨的」一并交给工人(钉接话对象用)', async () => {
    const greet = vi.fn(async () => ({ ok: true }))
    await handleRpcRequest(
      { id: 'd', type: 'call', action: 'start' },
      { deviceId: 'dev', workbench, call: { greet, answer: noAnswer, later: noAnswer }, identity: 'phone-pi', kind: 'handset' },
    )
    expect(greet).toHaveBeenCalledWith({ identity: 'phone-pi', kind: 'handset' })
  })

  it('老手机发的 start 不带身份:退回老行为(pickSpeaker 那三条),不编一个出来', async () => {
    const greet = vi.fn(async () => ({ ok: true }))
    await handleRpcRequest({ id: 'e', type: 'call', action: 'start' }, { deviceId: 'dev', workbench, call: { greet, answer: noAnswer, later: noAnswer } })
    expect(greet).toHaveBeenCalledWith(undefined)
  })

  it('引导那条**从不**捎带招呼:两条消息是互斥的两件事', async () => {
    const greet = vi.fn(async () => ({ ok: true }))
    const port: RpcOnboardingPort = {
      begin: async () => ({ ok: true, stage: 'opening' }),
      say: async () => ({ ok: true }),
      stop: async () => {},
    }
    await handleRpcRequest({ id: 'c', type: 'onboarding', action: 'start' }, { deviceId: 'dev', workbench, onboarding: port, call: { greet, answer: noAnswer, later: noAnswer } })
    expect(greet).not.toHaveBeenCalled()
  })
})

describe('引导归谁管(leader)', () => {
  const workbench = {} as RpcWorkbenchPort

  it('brief 带 leader;没有这一格就是「归手机」(老工作台)', () => {
    expect(parseOnboardingBrief({ stage: 'opening', leader: 'desktop' })?.leader).toBe('desktop')
    expect(parseOnboardingBrief({ stage: 'opening' })?.leader).toBeUndefined()
    expect(leadsOnDesktop({ leader: 'desktop' })).toBe(true)
    expect(leadsOnDesktop({ leader: 'phone' })).toBe(false)
    expect(leadsOnDesktop({})).toBe(false)
  })

  it('handle:归电脑管时 ok 仍是 true,但把 leader 原样带回手机', async () => {
    const port: RpcOnboardingPort = {
      begin: async () => ({ ok: true, stage: 'branch', leader: 'desktop' }),
      say: async () => ({ ok: true }),
      stop: async () => {},
    }
    const result = await handleRpcRequest({ id: 'd', type: 'onboarding', action: 'start' }, { deviceId: 'dev', workbench, onboarding: port })
    expect(result).toEqual({ id: 'd', type: 'onboarding', ok: true, stage: 'branch', leader: 'desktop' })
  })
})
