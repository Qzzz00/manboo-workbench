/**
 * 通话纪要在工人这一侧(2026-09-23,Ben 第四通真机:`call_records` 0 行、
 * 话筒接的那通没有任何人上报)。
 *
 * 钉四条:**双方的话按时间顺序进同一本**、**该报的才报**(手机自己会报的那通工人不报)、
 * **一句话没说的短通话不报**(看板上不留一件没发生的事)、**带 call_id**(8791 按它去重)。
 * 外加那一行「他说(ASR):」的分寸。
 */
import { describe, expect, it } from 'vitest'
import {
  HEARD_LOG_MAX,
  MIN_SILENT_CALL_MS,
  createCallRecorder,
  heardLogLine,
  type CallRecordPayload,
} from '../src/callRecord.ts'

function recorder(options: { ok?: boolean } = {}) {
  const sent: CallRecordPayload[] = []
  const logs: string[] = []
  let clock = 0
  const it = createCallRecorder({
    report: async (payload) => { sent.push(payload); return options.ok ?? true },
    now: () => clock,
    log: line => logs.push(line),
  })
  return {
    it,
    sent,
    logs,
    tick: (ms: number) => { clock += ms },
  }
}

describe('通话纪要:攒与上报', () => {
  it('他说的和她说的按时间顺序进同一本', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-1', report: true })
    t.it.add('butler', '我打给你是因为有一件事等你确认:给落地页换一张头图。')
    t.it.add('me', '批准。')
    t.it.add('butler', '好,已经挪到「完成」。')
    t.tick(65_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.transcript.map(line => line.who)).toEqual(['butler', 'me', 'butler'])
    expect(t.sent[0]!.transcript[1]!.text).toBe('批准。')
    expect(t.sent[0]!.durationSeconds).toBe(65)
    // call_id 要原样带上:8791 按它去重(同一通只落一条)。
    expect(t.sent[0]!.call_id).toBe('call-1')
  })

  it('手机自己会上报的那一通,工人不报 —— 不然看板上会多一张一模一样的卡', async () => {
    const t = recorder()
    t.it.start({ report: false })
    t.it.add('me', '帮我记一下周五交报销')
    t.it.add('butler', '记下了。')
    t.tick(30_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent).toHaveLength(0)
  })

  it('一句话都没说、又短得不像一通电话 → 不落纪要', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-2', report: true })
    t.tick(MIN_SILENT_CALL_MS - 1)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent).toHaveLength(0)
    expect(t.logs.join('\n')).toContain('不落记录')
  })

  it('一句话没说但真接着好几秒 → 照报(那通电话真的发生过)', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-3', report: true })
    t.tick(MIN_SILENT_CALL_MS + 1000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.transcript).toHaveLength(0)
  })

  it('不在通话里的字幕不进任何一本(房里没人时她也会说话)', async () => {
    const t = recorder()
    t.it.add('butler', '收到一个文件。')
    expect(t.it.active).toBe(false)
    t.it.start({ callId: 'call-4', report: true })
    t.it.add('me', '喂')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.transcript).toEqual([{ who: 'me', text: '喂' }])
  })

  it('重复 start 不重开一通;挂断两次只上报一次', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-5', report: true })
    t.it.add('me', '第一句')
    t.it.start({ callId: 'call-6', report: true })
    t.tick(20_000)
    t.it.finish()
    t.it.finish()
    await Promise.resolve()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.call_id).toBe('call-5')
  })

  it('交不上去只记一行,不抛 —— 纪要是一条记录,不是通话本身', async () => {
    const t = recorder({ ok: false })
    t.it.start({ callId: 'call-7', report: true })
    t.it.add('me', '喂')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(t.logs.join('\n')).toContain('没落下')
  })
})

describe('「他说(ASR):」那一行', () => {
  it('前缀是固定的那一句,内容只抄前 120 字', () => {
    const long = '啊'.repeat(300)
    const line = heardLogLine(long) as string
    expect(line.startsWith('[channel-worker] 他说(ASR):')).toBe(true)
    expect(line.length).toBe('[channel-worker] 他说(ASR):'.length + HEARD_LOG_MAX)
  })

  it('空话不打空行', () => {
    expect(heardLogLine('   ')).toBeUndefined()
    expect(heardLogLine('')).toBeUndefined()
  })
})
