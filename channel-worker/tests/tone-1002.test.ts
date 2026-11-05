/**
 * 语气跟着话走 —— **契约那一处**(2026-10-02,卡「声音与形象跟着话走」)。
 *
 * 钉三件事:
 *   ① 短列表就是那几个、别名收敛得住、取值跨进程不变(id 是英文,标签是中文);
 *   ② 句首那个标签**念之前一定剥掉**(送合成的那一份、字幕那一份都不许留);
 *   ③ 认不得的标签退回中性,**而且那几个字照样念出来** —— 宁可多念一句,不许吞掉她的话。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TONES,
  TONE_LABELS,
  TONE_NOTE_MAX,
  normalizeTone,
  parseToneTag,
  stripToneTags,
  toneTagOf,
} from '../src/tts/tone.ts'
import { speakableSpeech, speakableText } from '../src/tts/speakable.ts'

describe('语气短列表', () => {
  it('不超过十个,id 全是英文小写,每个都有中文标签', () => {
    expect(TONES.length).toBeGreaterThanOrEqual(5)
    expect(TONES.length).toBeLessThanOrEqual(10)
    for (const tone of TONES) {
      expect(tone).toMatch(/^[a-z]+$/)
      expect(TONE_LABELS[tone]).toMatch(/^[一-龥]{2,3}$/)
    }
    // 标签不许重样 —— 两个 id 共用一个中文标签,模型写哪个都对不上。
    expect(new Set(Object.values(TONE_LABELS)).size).toBe(TONES.length)
  })

  it('中文标签、英文 id、常见别名都收敛到同一个 id;认不得的回 undefined', () => {
    expect(normalizeTone('关心')).toBe('care')
    expect(normalizeTone('care')).toBe('care')
    expect(normalizeTone('体贴')).toBe('care')
    expect(normalizeTone('中性')).toBe('calm')
    expect(normalizeTone('neutral')).toBe('calm')
    expect(normalizeTone('开心')).toBe('happy')
    expect(normalizeTone('抱歉')).toBe('sorry')
    expect(normalizeTone('急')).toBe('urgent')
    expect(normalizeTone('小声')).toBe('soft')
    expect(normalizeTone('  高兴 ')).toBe('happy')
    expect(normalizeTone('兴高采烈')).toBeUndefined()
    expect(normalizeTone('')).toBeUndefined()
    expect(normalizeTone(undefined)).toBeUndefined()
  })

  it('toneTagOf 拼出来的标签,parseToneTag 认得回去', () => {
    for (const tone of TONES) {
      const tagged = `${toneTagOf(tone)}好的。`
      const parsed = parseToneTag(tagged)
      expect(parsed.tone).toBe(tone)
      expect(parsed.text).toBe('好的。')
    }
  })
})

describe('句首那个标签', () => {
  it('认得出语气、把标签剥干净', () => {
    expect(parseToneTag('[关心]你还好吗?')).toEqual({ tone: 'care', text: '你还好吗?' })
    expect(parseToneTag('【关心】你还好吗?')).toEqual({ tone: 'care', text: '你还好吗?' })
    expect(parseToneTag('  [歉意]  这件事我没办成。')).toEqual({ tone: 'sorry', text: '这件事我没办成。' })
  })

  it('可选那一句自然语言指令:竖线或冒号隔开,超过二十字就不要', () => {
    expect(parseToneTag('[关心|说慢一点]你还好吗?')).toEqual({ tone: 'care', note: '说慢一点', text: '你还好吗?' })
    expect(parseToneTag('[关心:说慢一点]好。')).toEqual({ tone: 'care', note: '说慢一点', text: '好。' })
    expect(parseToneTag('[关心：说慢一点]好。')).toEqual({ tone: 'care', note: '说慢一点', text: '好。' })
    const long = '一'.repeat(TONE_NOTE_MAX + 1)
    const parsed = parseToneTag(`[关心|${long}]好。`)
    expect(parsed.tone).toBe('care')
    expect(parsed.note).toBeUndefined()
    expect(parsed.text).toBe('好。')
  })

  it('认不得的标签:语气缺席,**那几个字照样留着**(不许吞掉她的话)', () => {
    expect(parseToneTag('[兴高采烈]好。')).toEqual({ text: '[兴高采烈]好。' })
    expect(parseToneTag('[1]好。')).toEqual({ text: '[1]好。' })
  })

  it('只认句首那一个;中间那些由 stripToneTags 扫掉', () => {
    expect(parseToneTag('好的。[关心]你还好吗?').tone).toBeUndefined()
    expect(stripToneTags('好的。[关心]你还好吗?')).toBe('好的。你还好吗?')
    expect(stripToneTags('[关心|慢一点]你还好吗?')).toBe('你还好吗?')
    // 认不得的照样留着 —— 和 parseToneTag 同一条规矩。
    expect(stripToneTags('[兴高采烈]好。')).toBe('[兴高采烈]好。')
  })
})

describe('送去合成的那一份', () => {
  it('speakableSpeech 把语气摘出来,剥掉标签,其余清洗一个字没变', () => {
    const piece = speakableSpeech('[关心]那我先给你摆成做产品研发那一套 —— 写代码、带 Agent。')
    expect(piece.tone).toBe('care')
    expect(piece.text).toBe('那我先给你摆成做产品研发那一套，写代码、带 Agent。')
  })

  it('**标签绝不会被念出来**:方括号本来会被清洗吃掉、只剩两个字', () => {
    // 这一条是这张卡的根:speakable 的 DROPPED 会把 [ ] 去掉、把「关心」留下念出来。
    expect(speakableText('[关心]你还好吗?')).toBe('你还好吗?')
    expect(speakableText('[关心|说慢一点]你还好吗?')).toBe('你还好吗?')
    expect(speakableSpeech('[关心]你还好吗?').text).not.toContain('关心')
  })

  it('没有标签时与从前逐字相同(老用例那几句)', () => {
    expect(speakableText('明白了,是 Ben,B e n,我这就把名字改过来。')).toBe('明白了,是 Ben,Ben,我这就把名字改过来。')
    expect(speakableText('好,那就按「工作台」找。')).toBe('好,那就按工作台找。')
    expect(speakableSpeech('——好。')).toEqual({ text: '好。' })
  })
})

describe('接线:三头消费的都是这一处契约', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('工人那一侧:合成前过 speakableSpeech,字幕那一份过 stripToneTags', () => {
    const tts = read('../src/tts/butlerTts.ts')
    expect(tts).toContain('speakableSpeech(this.inputText.trim())')
    expect(tts).toContain('stripToneTags(')
  })

  it('工人把 tone 发给 8792(两条路都发)', () => {
    const tts = read('../src/tts/butlerTts.ts')
    // 流式那条与老路那条各一次。
    expect(tts.match(/tone: this\.#tone/g)?.length).toBe(2)
  })

  it('字幕协议上带着 tone,手机那一侧的解析器认它', () => {
    expect(read('../src/rpc.ts')).toContain('tone?: string')
    const phone = read('../../butler-app/src/channel/channelProtocol.ts')
    expect(phone).toContain('tone?: string')
    expect(phone).toContain("...(nonEmptyString(msg.tone) ? { tone: msg.tone.trim() } : {})")
  })

  it('人设里有「每句开头给一个语气标签」那一句,而且列的就是这份短列表', () => {
    const channel = read('../../workbench-plugin/src/server/channel.ts')
    expect(channel).toContain('【语气】')
    for (const tone of TONES) expect(channel).toContain(TONE_LABELS[tone])
  })
})
