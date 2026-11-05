/**
 * **模型把工具调用写成一段文字吐了出来**(2026-09-30 Air 真机,维护者:「事务官口头说已指派,却没有实际创建任务」)。
 *
 * 通话纪要里事务官念出了这一串:`<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="wb_…"> <｜｜DSML｜｜ parameter …>`。
 * DeepSeek 偶尔不走结构化的 tool_calls,把调用按它自己的标记写进正文 —— 工人照念、工具一次没调,
 * 嘴上「都对我就派」,看板上什么都没有。修在流上:认出这段 → 不念 → 当成一次真的工具调用交给框架。
 */
import { describe, expect, it } from 'vitest'
import { parseDsmlCalls, withDsmlToolCalls } from '../src/dsmlToolCalls.ts'

const SEEN = `好,我去派。
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="wb_butler_item">
<｜｜DSML｜｜ parameter name="text" string="true">工作台有三个 bug 要修:
一、口头答应派活,实际没派出去</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="confirmed" string="false">true</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

describe('认出正文里的 DSML 工具调用', () => {
  it('★真机那一段:前面那句照说,后面整段不念,解析成一次调用(字符串原样、非字符串按 JSON)', () => {
    const got = parseDsmlCalls(SEEN)
    expect(got.spoken.trim()).toBe('好,我去派。')
    expect(got.calls).toEqual([{ name: 'wb_butler_item', args: { text: '工作台有三个 bug 要修:\n一、口头答应派活,实际没派出去', confirmed: true } }])
  })

  it('单竖线、半角竖线的写法也认', () => {
    const text = '<|DSML| invoke name="wb_x"><|DSML| parameter name="n" string="false">3</|DSML| parameter></|DSML| invoke>'
    expect(parseDsmlCalls(text).calls).toEqual([{ name: 'wb_x', args: { n: 3 } }])
  })

  it('没有 DSML 的正文原样,不出调用', () => {
    expect(parseDsmlCalls('今天深圳多云。')).toEqual({ spoken: '今天深圳多云。', calls: [] })
  })
})

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(value as T) }
  return out
}
function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({ start(c) { for (const one of chunks) c.enqueue(one); c.close() } })
}

describe('流上:不念、交给框架去调', () => {
  it('★DSML 被切成好几块流进来:念的只有前面那句,末尾多一块带 toolCalls 的', async () => {
    const pieces = [SEEN.slice(0, 8), SEEN.slice(8, 20), SEEN.slice(20, 70), SEEN.slice(70)]
    const out = await drain(withDsmlToolCalls(streamOf(pieces.map((content, i) => ({ id: `c${i}`, delta: { role: 'assistant', content } })))))
    const spoken = out.map((c) => (c as { delta?: { content?: string } }).delta?.content ?? '').join('')
    expect(spoken).not.toContain('DSML')
    expect(spoken.trim()).toBe('好,我去派。')
    const calls = out.flatMap((c) => (c as { delta?: { toolCalls?: { name: string, args: string }[] } }).delta?.toolCalls ?? [])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('wb_butler_item')
    expect(JSON.parse(calls[0]!.args)).toMatchObject({ confirmed: true })
  })

  it('纯字符串流也一样', async () => {
    const out = await drain(withDsmlToolCalls(streamOf(['我去派。', '<｜｜DSML｜｜ invoke name="wb_x"><｜｜DSML｜｜ parameter name="a" string="true">b</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>'])))
    expect(out.filter((c) => typeof c === 'string').join('')).toBe('我去派。')
    expect(out.some((c) => typeof c === 'object' && (c as { delta?: { toolCalls?: unknown[] } }).delta?.toolCalls?.length === 1)).toBe(true)
  })

  it('普通的「<」不被吞(「3<5」照念)', async () => {
    const out = await drain(withDsmlToolCalls(streamOf(['3<', '5 是对的。'])))
    expect(out.join('')).toBe('3<5 是对的。')
  })
})
