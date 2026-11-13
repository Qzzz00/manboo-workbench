/**
 * 启动时的「有没有配 AI 来源」这一问:判定、话术、3 秒倒计时,以及接线顺序。
 *
 * 用 node 环境是为了读源文件对照 —— 这个需求的核心是**时序**(检测要挡在图一之前),
 * 光测纯函数钉不住 Workbench 里那几处 early-return 的先后。
 *
 * 2026-11-13 真机返工:第一版「明确配了 / 问不到都放行」在真机上等于永远不弹
 * (本机 11-06 就存着一把 DeepSeek Key,`/credentials` 回 configured:true)。
 * 现在口径是 **只有明确 true 才放行**,首次流程没走完一律提醒。
 */
/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_STARTUP_COPY, API_KEY_STARTUP_DELAY_MS,
  apiKeyStartupWaiting, needApiKeyStartupNotice,
} from './apiKeyStartup.ts'

const workbench = readFileSync(new URL('./Workbench.tsx', import.meta.url), 'utf8')
const flow = readFileSync(new URL('./firstrun/FirstRunFlow.tsx', import.meta.url), 'utf8')
const notice = readFileSync(new URL('./ApiKeyStartupNotice.tsx', import.meta.url), 'utf8')

const stage = (over: Partial<Parameters<typeof needApiKeyStartupNotice>[0]> = {}) => ({
  loggedIn: true,
  firstRunNeeded: true as boolean | undefined,
  probeDone: true,
  aiConfigured: false as boolean | undefined,
  handled: false,
  ...over,
})

describe('启动弹窗该不该出现:只有「明确配好了」才放行', () => {
  it('还没到首次流程(旗子没问出来 / 已进过工作台):这一屏不归启动弹窗管', () => {
    expect(needApiKeyStartupNotice(stage({ firstRunNeeded: false }))).toBe(false)
    expect(needApiKeyStartupNotice(stage({ firstRunNeeded: undefined }))).toBe(false)
  })

  it('探测还没回来:不弹(先空屏,不闪图一)', () => {
    expect(needApiKeyStartupNotice(stage({ probeDone: false }))).toBe(false)
  })

  it('首次流程 + 明确没配 DeepSeek Key:弹', () => {
    expect(needApiKeyStartupNotice(stage())).toBe(true)
  })

  it('首次流程 + 探测问不到(服务没起 / 回的不是凭据结构 / 超时):照样弹', () => {
    expect(needApiKeyStartupNotice(stage({ aiConfigured: undefined }))).toBe(true)
  })

  it('真机返工:本机存着旧 Key(configured:true)但首次流程没走完,照样弹', () => {
    // 这就是维护者截图那台机器:/credentials 回 true、/model ready:true,
    // 旧版因此直接放行进图一。旗子还立着 = 配置这一趟没走完。
    expect(needApiKeyStartupNotice(stage({ aiConfigured: true }))).toBe(true)
  })

  it('登录态抖动(logged_in 翻 false)但首次流程旗子已翻真:照样弹', () => {
    expect(needApiKeyStartupNotice(stage({ loggedIn: false }))).toBe(true)
  })

  it('本次启动处理过(跳过去了 / 点了稍后再说):不重复弹', () => {
    expect(needApiKeyStartupNotice(stage({ handled: true }))).toBe(false)
  })
})

describe('探测没回来之前先空屏,不许闪一下图一', () => {
  it('首次流程 + 探测未回 + 没处理过:等', () => {
    expect(apiKeyStartupWaiting(stage({ probeDone: false }))).toBe(true)
  })

  it('探测回来了(配了 / 没配 / 问不到)都不等', () => {
    for (const aiConfigured of [true, false, undefined]) {
      expect(apiKeyStartupWaiting(stage({ aiConfigured }))).toBe(false)
    }
  })

  it('登录态抖动但旗子已翻真:照样等,不让图一抢先渲染', () => {
    expect(apiKeyStartupWaiting(stage({ probeDone: false, loggedIn: false }))).toBe(true)
  })

  it('不是首次流程 / 已处理过:不等,照原流程走', () => {
    expect(apiKeyStartupWaiting(stage({ probeDone: false, firstRunNeeded: false }))).toBe(false)
    expect(apiKeyStartupWaiting(stage({ probeDone: false, handled: true }))).toBe(false)
  })
})

describe('话术与时长', () => {
  it('提示语用维护者原话,逐字不改', () => {
    expect(API_KEY_STARTUP_COPY.title).toBe('检测到未配置大模型api key，请先配置')
  })

  it('倒计时 3 秒,倒数从 3 开始', () => {
    expect(API_KEY_STARTUP_DELAY_MS).toBe(3000)
    expect(API_KEY_STARTUP_COPY.countdown(3)).toContain('3')
    expect(API_KEY_STARTUP_COPY.countdown(1)).toContain('1')
    expect(notice).toContain('API_KEY_STARTUP_DELAY_MS')
  })

  it('话术里不出现任何具体密钥串', () => {
    expect(notice).not.toContain('sk-')
  })
})

describe('接线顺序(读源文件对照,防以后被挪回图一之后)', () => {
  it('Workbench 里:等待分支在「首次流程」分支之前', () => {
    const waiting = workbench.indexOf('apiKeyStartupWaiting(')
    const firstRunBranch = workbench.indexOf('if (firstRunNeeded === true) {')
    expect(waiting).toBeGreaterThan(-1)
    expect(firstRunBranch).toBeGreaterThan(-1)
    expect(waiting).toBeLessThan(firstRunBranch)
  })

  it('Workbench 用严格探测的结论,并且 3 秒后让首次流程直接落 config 步(图二)', () => {
    expect(workbench).toContain('fetchAiSourceConfigured')
    expect(workbench).toContain("initialStep: 'config'")
    expect(workbench).toContain('<ApiKeyStartupNotice')
  })

  it('探测只看首次流程旗子,不再叠 loggedIn 门槛(真机会抖)', () => {
    expect(workbench).toContain('if (firstRunNeeded !== true) return')
    expect(workbench).toContain('}, [firstRunNeeded, feed.baseUrl, serviceFetch])')
  })

  it('判定口径:首次流程没走完就必弹,别改回「配了 Key 就放行」', () => {
    const source = readFileSync(new URL('./apiKeyStartup.ts', import.meta.url), 'utf8')
    expect(source).toContain('return stage.firstRunNeeded === true || stage.aiConfigured !== true')
  })

  it('图二确是 FirstRunFlow 的 config 步(ModelPanel + CredentialPanel)', () => {
    expect(flow).toContain('<ModelPanel')
    expect(flow).toContain('<CredentialPanel')
    expect(flow).toContain("beforeConfig = useRef<FirstRunStep>('intro')")
  })

  it('启动弹窗不叠加整屏三步引导', () => {
    expect(workbench).toContain('apiKeyStartupHandled && !apiKeyReentry')
  })
})
