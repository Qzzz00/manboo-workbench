/**
 * 引导 ①′「你先用哪套布局」在**通话模式**里也能说、也能记(2026-09-21 布局模板)。
 *
 * 这一步的骨架全在工作台那边(server/onboardingStages.ts 的 TEMPLATE),工人这边只要三件事:
 *   ① 简报里的新阶段照样解析得出来(stage / seed / goals / keys),提示词里两个选项都念到;
 *   ② `record_answer` 交上去的值不被糟改 —— 模型写 `"ops"`(带引号)也要还原成 `ops`;
 *   ③ **运营模板下那一段「你可以真去看他的仓库」整段不出现** —— 工作台把三个 `read_*` 键
 *      摘掉了,工人的判据正是"keys 里有没有 read_scan_roots"。两句话打架的系统提示比没提示更糟。
 */
import { describe, expect, it } from 'vitest'
import {
  TOOL_RECORD_ANSWER, TOOL_SCAN_PROJECTS,
  buildOnboardingInstructions, coerceAnswerValue, parseOnboardingBrief,
  type OnboardingBrief,
} from '../src/onboarding.ts'

/** ①′ 布局那一段的简报(形状照工作台 GET /onboarding/brief 真的回的那一份)。 */
function templateBrief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'template',
    label: '①′ 布局(做产品 / 自媒体运营)',
    done: false,
    speak_seed: true,
    seed: '你说的这件事,更像是做产品研发,还是做自媒体运营?我按这个给你把工作台摆好。',
    goals: [
      'product(做产品研发)还是 ops(自媒体运营)',
      '**两个都念出来,不推荐**',
      '拿不准就默认 product,并说一句「以后在设置里随时能换」',
    ],
    keys: [{ name: 'template', kind: 'template', desc: 'product = 做产品研发 / ops = 自媒体运营', required: true }],
    // 2026-09-23 起布局排在分岔之后:走到这一段时分岔已经答过。
    answered: { opening: ['nickname'], branch: ['mode'] },
    nickname: '本',
    mode: 'existing',
    ...over,
  }
}

describe('①′ 布局:简报解析', () => {
  it('新阶段照样解析得出来,kind 认得 template', () => {
    const parsed = parseOnboardingBrief({
      stage: 'template',
      label: '①′ 布局(做产品 / 自媒体运营)',
      done: false,
      speak_seed: true,
      seed: '你先用哪个?',
      goals: ['product 还是 ops'],
      keys: [{ name: 'template', kind: 'template', desc: 'product / ops', required: true }],
      answered: {},
    })
    expect(parsed?.stage).toBe('template')
    expect(parsed?.keys[0]).toMatchObject({ name: 'template', kind: 'template', required: true })
  })
})

describe('①′ 布局:系统提示', () => {
  it('种子句照说,两个选项都在', () => {
    const text = buildOnboardingInstructions({ brief: templateBrief() })
    expect(text).toContain('①′ 布局')
    expect(text).toContain('做产品研发')
    expect(text).toContain('做自媒体运营')
    expect(text).toContain('【这一段开口就说这句】')
  })

  it('记这一项用的是 record_answer,stage 填 template', () => {
    const text = buildOnboardingInstructions({ brief: templateBrief() })
    expect(text).toContain(`调 ${TOOL_RECORD_ANSWER}`)
    expect(text).toContain('stage 填 "template"')
    expect(text).toContain('template *(必答)')
  })

  it('这一段一个字都不提扫仓库', () => {
    const text = buildOnboardingInstructions({ brief: templateBrief() })
    expect(text).not.toContain(TOOL_SCAN_PROJECTS)
    expect(text).not.toContain('你可以真去看他的仓库')
  })
})

describe('②′ 在运营模板下:不提扫仓库', () => {
  /**
   * 工作台在 `scan_repos: false` 时把三个 `read_*` 键从 ②′ 摘掉了。
   * 工人这边的表现就该是那一整段消失 —— 这条钉的是**两边的契约**,不是工人自己的分支。
   */
  const opsProjects = (): OnboardingBrief => ({
    stage: 'projects',
    label: '②′ 项目(A 授权线∥访谈线 / B 从零)',
    done: false,
    speak_seed: true,
    seed: '那我们从这个账号聊起。先用一句话说说它是做什么的、给谁看的?',
    goals: ['账号定位:这个账号是做什么的、一句话说清', '**一个仓库都不要扫**'],
    keys: [
      { name: 'project', kind: 'project', desc: '项目的一项或几项', required: false },
      { name: 'done', kind: 'bool', desc: '聊完了', required: true },
    ],
    answered: { opening: ['nickname'], branch: ['mode'], template: ['template'] },
    nickname: '本',
  })

  it('keys 里没有 read_scan_roots → 那一整段不出现', () => {
    const text = buildOnboardingInstructions({ brief: opsProjects() })
    expect(text).not.toContain(TOOL_SCAN_PROJECTS)
    expect(text).toContain('账号定位')
  })

  it('做产品那一份仍然有那一段(没把它改坏)', () => {
    const text = buildOnboardingInstructions({
      brief: {
        ...opsProjects(),
        goals: ['先把「能不能读你放仓库的那几个目录」问掉'],
        keys: [
          { name: 'read_scan_roots', kind: 'bool', desc: '读三个扫描根', required: false },
          { name: 'done', kind: 'bool', desc: '聊完了', required: true },
        ],
      },
    })
    expect(text).toContain(TOOL_SCAN_PROJECTS)
  })
})

describe('①′ 布局:值的还原', () => {
  it('带引号的照样还原成干净的 id', () => {
    expect(coerceAnswerValue('template', '"ops"')).toBe('ops')
    expect(coerceAnswerValue('template', ' product ')).toBe('product')
    expect(coerceAnswerValue('template', 'ops')).toBe('ops')
  })

  it('模型写成中文时原样交上去 —— 让阶段机回一句人话,工人不替它猜', () => {
    // 猜一个 id 交上去的后果是界面整个换成另一套布局,而他不会知道是自己那句话被听岔了。
    expect(coerceAnswerValue('template', '自媒体运营')).toBe('自媒体运营')
  })
})

/*
 * 2026-09-23 新顺序(① 称呼 → ② 分岔 → ①′ 布局 → ②′):电话那条路的系统提示跟着走。
 * 骨架在工作台(简报),工人这边只要照简报说 —— 这里钉的是两段简报在提示里的样子。
 */
describe('新顺序:分岔在布局之前', () => {
  const branchBrief = (): OnboardingBrief => ({
    stage: 'branch',
    label: '② 分岔',
    done: false,
    speak_seed: true,
    seed: '你现在是已经有在做的事,还是想从一个新点子开始?',
    goals: ['**先别问是做产品还是做运营、也别提布局** —— 下一段才问'],
    keys: [{ name: 'mode', kind: 'mode', desc: 'existing = 已经有在做的;fresh = 从一个新点子开始', required: true }],
    answered: { opening: ['nickname'] },
    nickname: '本',
  })

  it('分岔那一段:开口就是中性那一句,stage 填 branch,不提扫仓库', () => {
    const text = buildOnboardingInstructions({ brief: branchBrief() })
    expect(text).toContain('你现在是已经有在做的事,还是想从一个新点子开始?')
    expect(text).toContain('stage 填 "branch"')
    expect(text).not.toContain(TOOL_SCAN_PROJECTS)
  })

  it('布局那一段:分岔答过了,「现在到哪儿了」带着他答的那一支,说法与分岔句一致', () => {
    const text = buildOnboardingInstructions({ brief: templateBrief() })
    expect(text).toContain('· 已经有在做的')
    expect(text).toContain('branch(mode)')
    expect(text).toContain('你说的这件事')
    const fresh = buildOnboardingInstructions({ brief: templateBrief({ mode: 'fresh' }) })
    expect(fresh).toContain('· 从一个新点子开始')
  })
})
