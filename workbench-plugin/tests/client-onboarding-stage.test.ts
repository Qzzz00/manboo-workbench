/**
 * 电脑端引导整屏的状态映射(2026-09-23,维护者从零重装验收)。
 * 钉住:态的优先级、扫描进度的两种形状与退路、出错不静默、引导场景关中心光团。
 */
import { describe, expect, it } from 'vitest'
import {
  readDialogue, scanLineOf, scanProgressOf, scanRatioOf, shortPath, SILENT_AFTER_MS, speakMsFor, stageViewOf,
  SCAN_LINE, SCAN_LIST_LINE, TROUBLE_ENDED, TROUBLE_MODEL_DOWN, TROUBLE_SILENT, type StageSignals,
} from '../src/client/firstrun/onboardingStage.ts'
import { sceneSettings } from '../src/client/particleScene.ts'
import { TUNING_DEFAULTS } from '../src/client/swarm/core.js'

const quiet: StageSignals = { speaking: false, busy: false, pending: false, waiting: false, drafting: false }

describe('球的态', () => {
  it('什么都没发生:待命', () => {
    expect(stageViewOf(quiet)).toMatchObject({ cue: 'idle', mode: 'idle', notice: 'neutral' })
    expect(stageViewOf(quiet).status).toBeUndefined()
  })
  it('输入框里有字:在听', () => {
    expect(stageViewOf({ ...quiet, drafting: true })).toMatchObject({ cue: 'listening', mode: 'listening' })
  })
  it('等模型(回合在跑 / 请求在路上 / 你说完她没回):思考态,状态行「在想…」', () => {
    for (const over of [{ busy: true }, { pending: true }, { waiting: true }]) {
      const view = stageViewOf({ ...quiet, ...over })
      expect(view).toMatchObject({ cue: 'thinking', mode: 'listening', label: '在想', status: '在想…' })
    }
  })
  it('她的字幕刚换:说话态,压过思考与打字', () => {
    expect(stageViewOf({ ...quiet, speaking: true, busy: true, drafting: true })).toMatchObject({ cue: 'speaking', mode: 'speaking' })
  })
  it('扫描:执行中 + 进度;她一边说一边扫,球照样是执行中(维护者 09-23:扫描时上面的粒子就是工作态)', () => {
    const scan = { scanning: true, done: 12, total: 40, current: '/Users/someone/Documents/GitHub/foo' }
    expect(stageViewOf({ ...quiet, scan })).toMatchObject({ cue: 'working', mode: 'working', status: `${SCAN_LINE} 已看 12/40 · …/GitHub/foo`, ratio: 0.3 })
    expect(stageViewOf({ ...quiet, scan, speaking: true })).toMatchObject({ cue: 'working', mode: 'working', ratio: 0.3 })
  })
  it('扫描没给数:只有工作态与「正在找你的项目…」,不画条', () => {
    const view = stageViewOf({ ...quiet, scan: { scanning: true } })
    expect(view).toMatchObject({ cue: 'working', status: SCAN_LINE })
    expect(view.ratio).toBeUndefined()
  })
  it('服务端给了 scanning:false:不在扫,哪怕阶段在项目', () => {
    expect(stageViewOf({ ...quiet, busy: true, stage: 'projects', scan: { scanning: false } }).cue).toBe('thinking')
  })
  it('退路:一个扫描信号都没有、阶段在项目且她在忙 → 当她在找项目', () => {
    expect(stageViewOf({ ...quiet, busy: true, stage: 'projects' })).toMatchObject({ cue: 'working', status: SCAN_LINE })
    expect(stageViewOf({ ...quiet, busy: true, stage: 'habits' }).cue).toBe('thinking')
  })
})

describe('出错不静默', () => {
  it('出错回合的人话原样上屏,球变失败色,压过一切', () => {
    const view = stageViewOf({ ...quiet, speaking: true, errorText: '我这边模型没接上' })
    expect(view).toMatchObject({ cue: 'trouble', notice: 'failed', trouble: '我这边模型没接上' })
    expect(view.status).toBeUndefined()
  })
  it('只有 failed 旗子没有那句话:用默认人话', () => {
    expect(stageViewOf({ ...quiet, failed: true }).trouble).toBe(TROUBLE_MODEL_DOWN)
  })
  it('会话没了:说一句会接上', () => {
    expect(stageViewOf({ ...quiet, ended: true }).trouble).toBe(TROUBLE_ENDED)
  })
  it('上一轮坏了、她又开口了:先不挂旧旗子,等这一轮', () => {
    expect(stageViewOf({ ...quiet, failed: true, waiting: true }).cue).toBe('thinking')
    expect(stageViewOf({ ...quiet, ended: true, pending: true }).cue).toBe('thinking')
  })
  it('说完 45 秒回合早停了还没回话:一句人话;回合还在跑就不算', () => {
    expect(stageViewOf({ ...quiet, waiting: true, waitedMs: SILENT_AFTER_MS }).trouble).toBe(TROUBLE_SILENT)
    expect(stageViewOf({ ...quiet, waiting: true, waitedMs: SILENT_AFTER_MS - 1 }).cue).toBe('thinking')
    expect(stageViewOf({ ...quiet, waiting: true, busy: true, waitedMs: SILENT_AFTER_MS * 3 }).cue).toBe('thinking')
  })
})

describe('读回合表', () => {
  it('她最后一句、你最后一句、在不在等', () => {
    const read = readDialogue([
      { seq: 1, role: 'assistant', text: '你好' },
      { seq: 2, role: 'user', text: '我做产品' },
    ])
    expect(read).toMatchObject({ her: { text: '你好' }, you: { text: '我做产品' }, waiting: true })
  })
  it('出错回合不算她说的话,单独拿出来;你再开口就清掉', () => {
    const turns = [
      { seq: 1, role: 'assistant', text: '你好' },
      { seq: 2, role: 'user', text: '我做产品' },
      { seq: 3, role: 'assistant', text: '模型没接上', kind: 'error' },
    ]
    expect(readDialogue(turns)).toMatchObject({ her: { text: '你好' }, waiting: false, errorText: '模型没接上' })
    expect(readDialogue([...turns, { seq: 4, role: 'user', text: '再说一遍' }])).toMatchObject({ waiting: true })
    expect(readDialogue([...turns, { seq: 4, role: 'user', text: '再说一遍' }]).errorText).toBeUndefined()
  })
})

describe('扫描进度的形状', () => {
  it('认 { scan: {...} } 与顶层 scanning;认不出回 undefined', () => {
    expect(scanProgressOf({ scan: { scanning: true, done: 3, total: 9, current: ' a ' } })).toEqual({ scanning: true, done: 3, total: 9, current: 'a' })
    expect(scanProgressOf({ scanning: false, busy: true })).toEqual({ scanning: false })
    expect(scanProgressOf({ busy: true })).toBeUndefined()
    expect(scanProgressOf(undefined)).toBeUndefined()
    expect(scanProgressOf({ scan: { scanning: true, done: -1, total: Number.NaN } })).toEqual({ scanning: true })
  })
  it('服务端真实形状(projectsService ScanProgress):list 阶段只有一句,repos 阶段有数有条', () => {
    const list = scanProgressOf({ scan: { scanning: true, phase: 'list', done: 0, started_at: '2026-09-23T10:00:00.000Z' } })
    expect(list).toEqual({ scanning: true, phase: 'list', done: 0 })
    expect(stageViewOf({ ...quiet, scan: list! })).toMatchObject({ cue: 'working', status: SCAN_LIST_LINE })
    expect(stageViewOf({ ...quiet, scan: list! }).ratio).toBeUndefined()
    const repos = scanProgressOf({ scan: { scanning: true, phase: 'repos', done: 5, total: 20, current: 'desktop-workbench' } })!
    expect(stageViewOf({ ...quiet, scan: repos })).toMatchObject({ status: `${SCAN_LINE} 已看 5/20 · desktop-workbench`, ratio: 0.25 })
    const over = scanProgressOf({ scan: { scanning: false, done: 20, total: 20, finished_at: '2026-09-23T10:00:09.000Z' } })!
    expect(stageViewOf({ ...quiet, busy: true, stage: 'projects', scan: over }).cue).toBe('thinking')
  })
  it('只有 done 没有 total:说看了几个,不画条', () => {
    expect(scanLineOf({ scanning: true, done: 5 })).toBe(`${SCAN_LINE} 已看 5 个`)
    expect(scanRatioOf({ scanning: true, done: 5 })).toBeUndefined()
  })
  it('路径:家目录写成 ~,只留最后两段', () => {
    expect(shortPath('/Users/example/Documents/GitHub/foo')).toBe('…/GitHub/foo')
    expect(shortPath('/Users/example/Code')).toBe('~/Code')
    expect(shortPath('foo')).toBe('foo')
  })
})

it('说话时长按字数,1.2–7 秒', () => {
  expect(speakMsFor('好')).toBe(1200)
  expect(speakMsFor('一'.repeat(20))).toBe(2200)
  expect(speakMsFor('一'.repeat(500))).toBe(7000)
})

describe('引导场景关中心光团', () => {
  it('onboarding:cloudSize 归零,别的一项不动;不改入参', () => {
    const settings = { ...TUNING_DEFAULTS }
    const next = sceneSettings(settings, 'onboarding')
    expect(next.cloudSize).toBe(0)
    expect({ ...next, cloudSize: settings.cloudSize }).toEqual(settings)
    expect(settings.cloudSize).toBe(TUNING_DEFAULTS.cloudSize)
  })
  it('看板场景与缺省也关光团(09-24 验收清单「所有页面不要光团」);已经是 0 时同一个引用', () => {
    const settings = { ...TUNING_DEFAULTS, cloudSize: 0.6 }
    expect(sceneSettings(settings).cloudSize).toBe(0)
    expect(sceneSettings(settings, 'workbench').cloudSize).toBe(0)
    const off = { ...TUNING_DEFAULTS, cloudSize: 0 }
    expect(sceneSettings(off)).toBe(off)
  })
})

/**
 * 「执行中」恢复核心原版的 working 形(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 * 维护者:「我当时的讲法,只是不要中间的光团……就用莫比乌斯环,但是没有光团的版本」——
 * 推翻 09-23「工作中保持球形(待命形 + onboarding-busy 转快)」那一版;中心光团照关。
 */
describe('「执行中」是核心原版的 working 形(莫比乌斯环),没有光团', () => {
  const scan = { scanning: true, phase: 'repos' as const, done: 3, total: 9 }
  it('找项目时交核心的 working 形,不再借待命形', () => {
    const view = stageViewOf({ ...quiet, scan })
    expect(view.cue).toBe('working')
    expect(view.mode).toBe('working')
  })
  it('别的态不动:在想借 listening、出错停在待命', () => {
    expect(stageViewOf({ ...quiet, busy: true }).mode).toBe('listening')
    expect(stageViewOf({ ...quiet, errorText: 'x' }).mode).toBe('idle')
  })
  it('场景只剩 workbench / onboarding 两个,都关光团、别的一项不动', () => {
    const settings = { ...TUNING_DEFAULTS, cloudSize: 0.8 }
    for (const scene of ['workbench', 'onboarding'] as const) {
      expect(sceneSettings(settings, scene)).toEqual({ ...settings, cloudSize: 0 })
    }
  })
})
