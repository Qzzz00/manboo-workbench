/**
 * **打断那条路换成认中文的判法**(2026-10-03,卡「嗯 / 对 / 好 真的不打断她」,决策记录 ④甲)。
 *
 * 10-02 交的是判据(`isBackchannelOnly` / `isRealInterruption`)与回归包,只用在
 * 「不对着一声嗯再应一声」;打断那条路本身**一个字没动**,框架自带那道闸
 * `turnHandling.interruption.minWords` 对中文没用(数的是按空白切的词)。
 *
 * 这一包钉三件:
 *   ① **对照源头**:框架那把 `splitWords` 确实把中文一整句数成一个词
 *      (直接 import `@livekit/agents` 的那一把,不抄一份正则);
 *   ② 判法:应声不停、真打断当场停、字太少先等、她没在说话时的「好」照旧进回合;
 *   ③ **词表只有一处出处**:扫 `src/` 的源码,缺省那份只在 backchannel.ts 里。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tokenize } from '@livekit/agents'
import { describe, expect, it } from 'vitest'
import { ACK_WORDS, ackWordsWith, isBackchannelOnly, makeIsBackchannelOnly } from '../src/backchannel.ts'
import {
  BARGE_IN_DEADLINE_MS,
  BARGE_IN_MIN_CHARS,
  BargeIn,
  countSpokenChars,
  judgeBargeIn,
  WORD_GATE_SHUT,
} from '../src/bargeIn.ts'
import { ackWordsOf, channelWorkerConfigOf } from '../src/config.ts'
import { ANSWER_WORDS } from '../src/turnRoute.ts'

const SRC_DIR = join(import.meta.dirname, '..', 'src')

// ———————————————————— ① 对照源头:框架那把尺子 ————————————————————

describe('框架那道词数闸对中文为什么没用(读源头比对)', () => {
  /** 框架 `interruptByAudioActivity` / `onEndOfTurn` 数的就是这一把(agent_activity.js 两处)。 */
  const splitWords = tokenize.basic.splitWords

  it('中文一整句只算一个词 —— 所以 minWords:2 会把每一次真打断都挡掉', () => {
    expect(splitWords('我想让你帮我查一件事', true)).toHaveLength(1)
    expect(splitWords('等一下', true)).toHaveLength(1)
    // 一声「嗯」也是一个词:两者在这把尺子下**分不开**。
    expect(splitWords('嗯', true)).toHaveLength(1)
  })

  it('我们这把按字数数:十个字就是十个,一声「嗯」是一个', () => {
    expect(countSpokenChars('我想让你帮我查一件事')).toBe(10)
    expect(countSpokenChars('等一下')).toBe(3)
    expect(countSpokenChars('嗯')).toBe(1)
  })

  it('西文一串算一个词(和框架同口径),标点与空白不算', () => {
    expect(countSpokenChars('ok')).toBe(1)
    expect(countSpokenChars('okay thanks')).toBe(2)
    // 中西混排:Codex 一个,「这个」两个。
    expect(countSpokenChars('Codex 这个')).toBe(3)
    expect(countSpokenChars('。，、 …')).toBe(0)
    expect(countSpokenChars('')).toBe(0)
  })

  it('闸关上那个数一定大于框架能数出来的词数(中文十字的一句不会被挡)', () => {
    const long = '不是 Codex,是 Claude,改成明天下午再派,顺便把那张卡的标题也改一下'
    expect(splitWords(long, true).length).toBeLessThan(WORD_GATE_SHUT)
    expect(Number.isSafeInteger(WORD_GATE_SHUT)).toBe(true)
  })
})

// ———————————————————— ② 判法 ————————————————————

describe('判法 · 应声不算打断', () => {
  for (const said of ['嗯', '对', '好的', '嗯哼', '行', '嗯嗯', '好吧']) {
    it(`「${said}」→ 不停`, () => {
      expect(judgeBargeIn(said, { isFinal: true })).toBe('ack')
      expect(judgeBargeIn(said, { isFinal: false })).toBe('ack')
    })
  }
})

describe('判法 · 真打断要停', () => {
  for (const said of ['等一下', '不对', '不对不对', '呃其实我想说的是另一件事', '停一下', '先别说了']) {
    it(`「${said}」→ 停`, () => {
      expect(judgeBargeIn(said, { isFinal: false })).toBe('stop')
    })
  }

  it(`中间结果字还不够 ${BARGE_IN_MIN_CHARS} 个先等着,够了当场停`, () => {
    expect(judgeBargeIn('等', { isFinal: false })).toBe('wait')
    expect(judgeBargeIn('等一', { isFinal: false })).toBe('stop')
  })

  it('说定了的那一句只要不是应声就停,一个字也算(「停」)', () => {
    expect(judgeBargeIn('停', { isFinal: true })).toBe('stop')
  })

  it('没识别出字来的时候先等着(不停、也不当应声)', () => {
    expect(judgeBargeIn('', { isFinal: false })).toBe('wait')
    expect(judgeBargeIn('   ', { isFinal: true })).toBe('wait')
  })
})

// ———————————————————— ② 判法接在闸上:那台状态机 ————————————————————

function harness(overrides: Partial<{ minChars: number, deadlineMs: number, isAck: (text: string) => boolean }> = {}) {
  let clock = 10_000
  const stopped: string[] = []
  const timers: { fn: () => void, ms: number, at: number, dead: boolean }[] = []
  const gate = new BargeIn({
    stop: why => stopped.push(why),
    now: () => clock,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, at: clock, dead: false }
      timers.push(entry)
      return () => { entry.dead = true }
    },
    ...overrides,
  })
  /** 把时钟推到最近那个还活着的计时器到点并触发它。回触发了没有。 */
  const tick = (): boolean => {
    const next = timers.filter(one => !one.dead).at(-1)
    if (next === undefined) return false
    next.dead = true
    clock = next.at + next.ms
    next.fn()
    return true
  }
  return {
    gate,
    stopped,
    tick,
    armedMs: () => timers.at(-1)?.ms,
    advance: (ms: number) => { clock += ms },
  }
}

describe('接上闸之后 · 她手上有话的时候', () => {
  it('一声「嗯」不停她 —— 这一句也不进回合', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.gate.heard('嗯', true)).toBe('ack')
    expect(h.stopped).toEqual([])
  })

  it('「等一下」当场停 —— **同一拍里停,不挂计时器**(业界尺子 ≤300ms)', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.gate.heard('等一下', false)).toBe('stop')
    expect(h.stopped).toHaveLength(1)
  })

  it('先一声「嗯」、接着又说下去 → 还是停', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.gate.heard('嗯', false)).toBe('ack')
    expect(h.stopped).toEqual([])
    expect(h.gate.heard('嗯…那个,先别派了', false)).toBe('stop')
    expect(h.stopped).toHaveLength(1)
  })

  it('一段话只停一次(第二条中间结果不再掐一遍)', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    h.gate.heard('不对不对', false)
    h.gate.heard('不对不对,我说的是上一条', true)
    expect(h.stopped).toHaveLength(1)
    expect(h.gate.stopped).toBe(true)
  })

  it(`一个字都没识别出来、连着说了 ${BARGE_IN_DEADLINE_MS}ms → 照样停(ASR 哑了也掐得住)`, () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.armedMs()).toBe(BARGE_IN_DEADLINE_MS)
    expect(h.tick()).toBe(true)
    expect(h.stopped).toHaveLength(1)
  })

  it('她一停口,那道兜底的计时器当场撤掉', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    h.gate.userSpeaking(false)
    expect(h.tick()).toBe(false)
    expect(h.stopped).toEqual([])
  })

  /**
   * **她还在想(thinking)、一个字还没出声的那几秒也算「手上有话」**。
   * 框架那两道门认的是 `_currentSpeech`,它在发言排进队那一刻就挂上了(act 路中位 8.2 秒)。
   * 只认「在出声」的话,他在那几秒里说的一整句会被框架整段丢掉 —— 一个回音都没有。
   * 所以 agent.ts 把 `speaking` 与 `thinking` 两种状态都接成 `agentHasFloor(true)`。
   */
  it('她还在想、还没出声的那几秒:他说一整句照样掐得住(不会被整段丢掉)', () => {
    const h = harness()
    h.gate.agentHasFloor(true) // agent.ts 里 thinking 也走这一下
    h.gate.userSpeaking(true)
    expect(h.gate.heard('帮我查一下明天的日程', true)).toBe('stop')
    expect(h.stopped).toHaveLength(1)
  })

  /**
   * 业界那把尺子(真打断 ≤300ms 停)在真机上只有这一个数可量:**他开口到我们掐**那几毫秒。
   * 这里钉的是「日志里真有这个数」—— 真机那一半(ASR 中间结果到底要几百毫秒)这张卡量不到。
   */
  it('掐的那一下记下**他开口到停**隔了多少毫秒(真机上就靠这一行量 ≤300ms)', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    h.advance(280)
    h.gate.heard('等一下', false)
    expect(h.stopped[0]).toContain('他开口 280ms 之后')
    expect(h.stopped[0]).toContain('等一下')
  })

  it('她手上的话没了,兜底也不再掐(没有东西可掐)', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    h.gate.agentHasFloor(false)
    expect(h.tick()).toBe(false)
    expect(h.stopped).toEqual([])
  })
})

describe('接上闸之后 · 她手上没话的时候', () => {
  it('这时候的「好」是**他的答复**,照旧进回合(不当应声吞掉)', () => {
    const h = harness()
    h.gate.userSpeaking(true)
    expect(h.gate.heard('好', true)).toBe('turn')
    expect(h.stopped).toEqual([])
  })

  it('这时候的整句话也照旧进回合、不掐(她手上没话,掐谁)', () => {
    const h = harness()
    h.gate.userSpeaking(true)
    expect(h.gate.heard('帮我查一下明天的日程', true)).toBe('turn')
    expect(h.stopped).toEqual([])
  })

  it('他先开口、她后接手 → 不挂兜底计时器(他这一段早就在识别了)', () => {
    const h = harness()
    h.gate.userSpeaking(true)
    h.gate.agentHasFloor(true)
    expect(h.tick()).toBe(false)
  })
})

// ———————————————————— ③ 词表只有一处出处 ————————————————————

describe('词表只有一处出处', () => {
  it('**打断那一头(bargeIn.ts)自己一个应声词都不写** —— 判法只能靠 import', () => {
    const source = readFileSync(join(SRC_DIR, 'bargeIn.ts'), 'utf8')
    const copied = ACK_WORDS.filter(word => source.includes(`'${word}'`))
    expect(copied, `bargeIn.ts 里抄了 ${copied.join('、')}`).toEqual([])
    expect(source).toContain("from './backchannel.ts'")
  })

  it('缺省那张表只在 backchannel.ts 里(别处没有第二份整表)', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter(name => typeof name === 'string' && name.endsWith('.ts'))
    // 挑几个只会出现在词表里的(不挑「好」「对」——那两个字满篇注释里都有)。
    for (const word of ['嗯哼', '对对', '对啊', '好好']) {
      expect(ACK_WORDS).toContain(word)
      const holders = files.filter(name => readFileSync(join(SRC_DIR, name), 'utf8').includes(`'${word}'`))
      expect(holders, `「${word}」出现在 ${holders.join('、')}`).toEqual(['backchannel.ts'])
    }
  })

  /**
   * **兄弟路,故意不合**:turnRoute.ts 的 `ANSWER_WORDS` / `GREETING_WORDS` 与这张表有一半重叠,
   * 但判的是**另一件事** —— 「这一回合带不带全套工具」。两张表合成一张会同时判错两头:
   * 「不对」在那边是一句应答(不用工具),在这边是**真打断**(必须停)。
   * 这一条用例就是把那个分界钉死,免得哪天有人图省事把两张表并了。
   */
  it('turnRoute 那两张表是另一件事(「不对」在那边算应答,在这边算真打断)', () => {
    expect(ANSWER_WORDS).toContain('不对')
    expect(ACK_WORDS).not.toContain('不对')
    expect(judgeBargeIn('不对', { isFinal: true })).toBe('stop')
    // 反过来:「嗯哼」是应声,而那张应答表里没有它(它连一句答复都算不上)。
    expect(ANSWER_WORDS).not.toContain('嗯哼')
  })

  it('打断那一头判应声用的就是同一把(换掉词表,判法跟着换)', () => {
    const onlyYes = makeIsBackchannelOnly(['好'])
    expect(judgeBargeIn('嗯', { isFinal: true, isAck: onlyYes })).toBe('stop')
    expect(judgeBargeIn('好', { isFinal: true, isAck: onlyYes })).toBe('ack')
    // 缺省那把就是 isBackchannelOnly 本人。
    expect(judgeBargeIn('嗯', { isFinal: true, isAck: isBackchannelOnly })).toBe('ack')
  })

  it('应声那一头(backchannel)与打断这一头吃的是同一份表', () => {
    for (const word of ACK_WORDS) expect(isBackchannelOnly(word)).toBe(true)
  })
})

describe('词表能被运营那层改(配置)', () => {
  it('不配 = 缺省那份,一个字不差', () => {
    expect(ackWordsWith(undefined)).toEqual([...ACK_WORDS])
    expect(ackWordsOf(undefined)).toBeUndefined()
    expect(ackWordsOf('  ')).toBeUndefined()
  })

  it('`+` 开头 = 添在缺省那份后面(她不用重抄一遍)', () => {
    const parsed = ackWordsOf('+嗯呐,好嘞、哦哦')
    expect(parsed).toEqual({ mode: 'add', words: ['嗯呐', '好嘞', '哦哦'] })
    const words = ackWordsWith(parsed)
    expect(words).toEqual([...ACK_WORDS, '嗯呐', '好嘞', '哦哦'])
    expect(makeIsBackchannelOnly(words)('嗯呐')).toBe(true)
  })

  it('不带 `+` = 整张换掉', () => {
    const parsed = ackWordsOf('嗯，对')
    expect(parsed).toEqual({ mode: 'replace', words: ['嗯', '对'] })
    expect(ackWordsWith(parsed)).toEqual(['嗯', '对'])
    expect(makeIsBackchannelOnly(ackWordsWith(parsed))('好的')).toBe(false)
  })

  it('比缺省长的词也判得出(上限跟着表走,不写死 4 个字)', () => {
    const judge = makeIsBackchannelOnly(ackWordsWith(ackWordsOf('+好的好的呀')))
    expect(judge('好的好的呀')).toBe(true)
    expect(judge('好的好的呀,那你先去办')).toBe(false)
  })

  it('配置:闸的三格都能改,读不懂就当没配', () => {
    const fromEnv = channelWorkerConfigOf({
      WORKBENCH_CHANNEL_ACK_WORDS: '+嗯呐',
      WORKBENCH_CHANNEL_BARGE_IN_MIN_CHARS: '3',
      WORKBENCH_CHANNEL_BARGE_IN_DEADLINE_MS: '900',
    }, '/tmp/home')
    expect(fromEnv.bargeInZh).toBe(true)
    expect(fromEnv.ackWords).toEqual({ mode: 'add', words: ['嗯呐'] })
    expect(fromEnv.bargeInMinChars).toBe(3)
    expect(fromEnv.bargeInDeadlineMs).toBe(900)

    const bare = channelWorkerConfigOf({ WORKBENCH_CHANNEL_BARGE_IN_MIN_CHARS: '不是数' }, '/tmp/home')
    expect(bare.bargeInZh).toBe(true)
    expect(bare.ackWords).toBeUndefined()
    expect(bare.bargeInMinChars).toBeUndefined()
    expect(bare.bargeInDeadlineMs).toBeUndefined()
  })

  it('真机上能一键退回 10-02 的行为(关了这道闸)', () => {
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_BARGE_IN_ZH: 'off' }, '/tmp/home').bargeInZh).toBe(false)
  })
})

/**
 * ——— ★ 一键退回 10-02:**自定义判法也得跟着停**(2026-10-03,卡 fix/voice-route-zh;
 * 审计 `docs/审计材料/2026-10-03/voice.md` 附证 C)———
 *
 * 上面那一条只证明了「配置读得对」。真机上 `WORKBENCH_CHANNEL_BARGE_IN_ZH=off` 当时
 * 只撤掉了框架那道词数闸的「关上」值,工人这边 `new BargeIn` 与喂事件那三处都是**无条件**的:
 * 框架自带的自动打断与我们自己的判法同时在跑,一声「嗯」照旧可能被工人这边当成 `ack` 丢掉。
 * 「一键回到 10-02」那句话当时不成立。
 *
 * 接线那一层要真起一个 LiveKit 会话才跑得到,所以这几条钉的是**那几行还在不在**
 * (AGENTS.md:没有对照测试就补一条,读源头文件比对)。
 */
describe('★ 关了这道闸,工人自己的判法也跟着停(读 src/agent.ts)', () => {
  const SOURCE = readFileSync(join(SRC_DIR, 'agent.ts'), 'utf8')

  it('★ BargeIn 只在开关开着时才造', () => {
    expect(SOURCE).toContain('const bargeIn = deps.config.bargeInZh')
    expect(SOURCE).not.toContain('const bargeIn = new BargeIn(')
  })

  it('★ 喂事件那三处都带问号(没造出来就一件都不做)', () => {
    expect(SOURCE).toContain('bargeIn?.userSpeaking(')
    expect(SOURCE).toContain('bargeIn?.agentHasFloor(')
    expect(SOURCE).toContain('bargeIn?.heard(')
    expect(SOURCE).not.toMatch(/bargeIn\.(?:userSpeaking|agentHasFloor|heard)\(/)
  })

  it('★ 没造出来时这一段当 `turn`(一个字都不过滤、照旧进回合)', () => {
    expect(SOURCE).toContain("bargeIn?.heard(event.transcript, event.isFinal) ?? 'turn'")
  })
})

describe('闸上那几个数就是 BargeIn 的缺省', () => {
  it('缺省 minChars / deadline 用的是导出的那两个常量', () => {
    const h = harness()
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.armedMs()).toBe(BARGE_IN_DEADLINE_MS)
    // 缺省 2 个字:一个字先等、两个字就停。
    expect(BARGE_IN_MIN_CHARS).toBe(2)
  })

  it('配置改了就按配置走', () => {
    const h = harness({ minChars: 4, deadlineMs: 700 })
    h.gate.agentHasFloor(true)
    h.gate.userSpeaking(true)
    expect(h.armedMs()).toBe(700)
    expect(h.gate.heard('等一下', false)).toBe('wait')
    expect(h.gate.heard('等一下再说', false)).toBe('stop')
  })
})
