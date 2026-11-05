// @vitest-environment node
/**
 * 会议模式纯的那一半里**不碰纪要结构**的几样:目录名闸门、时间戳、切段、`转写.md`。
 *
 * 2026-10-13 起提示词、读模型回的那几段、`纪要.md` 搬去
 * `server-meeting-notes-rules-20261013.test.ts`(按《会议纪要生成规则》逐条对照)。
 */
import { describe, expect, it } from 'vitest'
import {
  ASR_PIECE_MAX_SECONDS,
  meetingDirName,
  meetingStamp,
  renderImportedTranscriptMd,
  renderTranscriptMd,
  safeMeetingTitle,
  segmentMimeOfPath,
  splitPcmForAsr,
  timelineOf,
  transcriptBodyOf,
  MEETING_TIMELINE_MAX,
  MEETING_TIMELINE_TEXT_MAX,
} from '../src/server/meetingText.ts'

/** 造一段 16k/16bit/mono 的 PCM:`spans` 是 [秒数, 振幅] 的清单。 */
function pcmOf(spans: readonly (readonly [number, number])[], rate = 16_000): Buffer {
  const total = spans.reduce((n, [seconds]) => n + Math.round(seconds * rate), 0)
  const buf = Buffer.alloc(total * 2)
  let at = 0
  for (const [seconds, amp] of spans) {
    const samples = Math.round(seconds * rate)
    for (let i = 0; i < samples; i++) {
      // 交替正负,免得整段是常数直流——RMS 才有意义。
      buf.writeInt16LE(i % 2 === 0 ? amp : -amp, (at + i) * 2)
    }
    at += samples
  }
  return buf
}

describe('目录名与标题闸门(不拿模型/用户给的字符串直接在他盘上建目录)', () => {
  it('空白、非字符串、只有点 → 退回「会议」,绝不建一个空名字的目录', () => {
    expect(safeMeetingTitle('   ')).toBe('会议')
    expect(safeMeetingTitle(undefined)).toBe('会议')
    expect(safeMeetingTitle(42)).toBe('会议')
    expect(safeMeetingTitle('...')).toBe('会议')
  })

  it('路径分隔符与 .. 一律换掉,前导点去掉', () => {
    expect(safeMeetingTitle('../../etc/passwd')).toBe('etc_passwd')
    expect(safeMeetingTitle('产品\\周会')).toBe('产品_周会')
    expect(safeMeetingTitle('.隐藏的会')).toBe('隐藏的会')
  })

  it('超长截到 60 字', () => {
    expect(safeMeetingTitle('会'.repeat(200))).toBe('会'.repeat(60))
  })

  it('目录名 = 日期-标题', () => {
    expect(meetingDirName('2026-09-21', '产品周会')).toBe('2026-09-21-产品周会')
    expect(meetingDirName('2026-09-21', ' ')).toBe('2026-09-21-会议')
  })
})

describe('时间戳', () => {
  it('毫秒 → hh:mm:ss,一小时以内也带小时位(整份转写对齐好读)', () => {
    expect(meetingStamp(0)).toBe('00:00:00')
    expect(meetingStamp(1_000)).toBe('00:00:01')
    expect(meetingStamp(200_000)).toBe('00:03:20')
    expect(meetingStamp(3_661_000)).toBe('01:01:01')
  })

  it('负数与 NaN 当 0(不显示 -00:00:01 这种东西)', () => {
    expect(meetingStamp(-5)).toBe('00:00:00')
    expect(meetingStamp(Number.NaN)).toBe('00:00:00')
  })
})

describe('切段送 ASR(8792 /api/asr 一段最多 60 秒,所以必须切)', () => {
  it('短过一段上限的整段不切', () => {
    const pieces = splitPcmForAsr(pcmOf([[10, 3000]]), 16_000)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]?.startMs).toBe(0)
    expect(pieces[0]?.endMs).toBe(10_000)
  })

  it('每一段都不超过上限,且首尾相接不丢一个采样', () => {
    const pcm = pcmOf([[200, 3000]])
    const pieces = splitPcmForAsr(pcm, 16_000)
    expect(pieces.length).toBeGreaterThan(3)
    let bytes = 0
    let at = 0
    for (const piece of pieces) {
      expect(piece.endMs - piece.startMs).toBeLessThanOrEqual(ASR_PIECE_MAX_SECONDS * 1000 + 1)
      expect(piece.startMs).toBe(at)
      at = piece.endMs
      bytes += piece.pcm.length
    }
    expect(bytes).toBe(pcm.length)
    expect(at).toBe(200_000)
  })

  it('切在静音处:一段响-静-响的音频,切点落在那段静音里,不把一句话劈成两半', () => {
    // 20 秒说话 + 2 秒静音 + 20 秒说话。缺省目标 20 秒、搜索窗 4 秒,刚好能看见那段静音。
    const pcm = pcmOf([[20, 4000], [2, 5], [20, 4000]])
    const pieces = splitPcmForAsr(pcm, 16_000)
    expect(pieces.length).toBeGreaterThanOrEqual(2)
    const cut = pieces[0]?.endMs ?? 0
    expect(cut).toBeGreaterThanOrEqual(20_000)
    expect(cut).toBeLessThanOrEqual(22_000)
  })

  it('空 PCM → 一段都不出(不送一段空的去火山白烧钱)', () => {
    expect(splitPcmForAsr(Buffer.alloc(0), 16_000)).toEqual([])
  })
})

describe('转写.md', () => {
  it('每条带时间戳,空文本那条不写进去(火山没听清的段落不占一行)', () => {
    const md = renderTranscriptMd({
      title: '产品周会',
      date: '2026-09-21',
      startedAt: '2026-09-21T10:00:00.000Z',
      seconds: 200,
      lines: [
        { startMs: 0, text: '我们先过一下上周的事。' },
        { startMs: 12_000, text: '' },
        { startMs: 200_000, text: '那就这么定。' },
      ],
    })
    expect(md).toContain('# 产品周会')
    expect(md).toContain('[00:00:00] 我们先过一下上周的事。')
    expect(md).toContain('[00:03:20] 那就这么定。')
    expect(md).not.toContain('[00:00:12]')
  })

  it('一条都没有时如实说一句,不留一份空文件让人以为转写成功了', () => {
    const md = renderTranscriptMd({ title: '会议', date: '2026-09-21', startedAt: '2026-09-21T10:00:00.000Z', seconds: 3, lines: [] })
    expect(md).toContain('一个字都没转出来')
  })
})

describe('导入进来的那一份转写(2026-10-13)', () => {
  it('文件头说清它不是这台机器识别的,正文原样落盘;来源没给就不写那一行', () => {
    const md = renderImportedTranscriptMd({
      title: '十一月选题会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z',
      text: '[00:00:00] 行,人齐了。\n[00:00:09] 先说背景。',
      from: '会议样例.md',
    })
    expect(md).toContain('导入的现成文字')
    expect(md).toContain('会议样例.md')
    expect(md).toContain('[00:00:09] 先说背景。')
    expect(renderImportedTranscriptMd({ title: '会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z', text: '一句话' })).not.toContain('来源')
  })

  it('读正文时文件头不算(头上有日期 —— 拿它当「她说过的日子」会蒙对)', () => {
    const md = renderImportedTranscriptMd({ title: '会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z', text: '正文第一句' })
    expect(transcriptBodyOf(md)).toBe('正文第一句')
    // 没有分隔线的一份原样回(别人手写的转写不一定有文件头)
    expect(transcriptBodyOf('就一句话')).toBe('就一句话')
  })
})

describe('一个本机录音文件该当成什么 mime 收', () => {
  it('常见的几种认得出来,认不出的回 undefined(落成 .bin,解码交给 ffmpeg 嗅,不猜)', () => {
    expect(segmentMimeOfPath('/x/上周的会.m4a')).toBe('audio/mp4')
    expect(segmentMimeOfPath('/x/a.WAV')).toBe('audio/wav')
    expect(segmentMimeOfPath('/x/a.mp3')).toBe('audio/mpeg')
    expect(segmentMimeOfPath('/x/没有扩展名')).toBeUndefined()
    expect(segmentMimeOfPath('/x/a.txt')).toBeUndefined()
  })
})

describe('会中那条时间线(2026-10-13):只认转写里本来就有的时间戳', () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, at) => `[00:${String(at).padStart(2, '0')}:00] 第 ${at} 句`).join('\n')

  it('一行一刻:时间戳原样,话截到上限、后面带省略号', () => {
    const long = '这一句很长'.repeat(20)
    const marks = timelineOf(`[00:01:02] 开头那一句\n[01:02:03] ${long}`)
    expect(marks).toHaveLength(2)
    expect(marks[0]).toEqual({ at: '00:01:02', text: '开头那一句' })
    expect(marks[1]?.at).toBe('01:02:03')
    expect(marks[1]?.text).toHaveLength(MEETING_TIMELINE_TEXT_MAX + 1)
    expect(marks[1]?.text.endsWith('…')).toBe(true)
  })

  it('长会匀着取:最多那么多刻,头一刻与末一刻都留着', () => {
    const marks = timelineOf(lines(60))
    expect(marks).toHaveLength(MEETING_TIMELINE_MAX)
    expect(marks[0]?.text).toBe('第 0 句')
    expect(marks[marks.length - 1]?.text).toBe('第 59 句')
    // 匀着:相邻两刻的间隔一样(差一句以内)
    const nth = (text: string): number => Number(/\d+/.exec(text)?.[0] ?? '-1')
    const gaps = marks.slice(1).map((one, at) => nth(one.text) - nth(marks[at]!.text))
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
  })

  it('一个时间戳都没有(她粘的是一段没时间的纯文字)→ 空的,**不按字数估一个时间**', () => {
    expect(timelineOf('行,人齐了。\n先说背景。')).toEqual([])
    // 有时间戳但那一行没话的不算一刻
    expect(timelineOf('[00:00:00]\n[00:00:05] 有话')).toEqual([{ at: '00:00:05', text: '有话' }])
  })
})
