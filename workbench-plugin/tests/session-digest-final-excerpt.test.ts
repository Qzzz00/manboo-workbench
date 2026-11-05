// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { digestCodex, turnsOf } from '../src/server/sessionDigest.ts'

const raw = readFileSync(new URL('./fixtures/codex-natural-final-digest.jsonl', import.meta.url), 'utf8')
const excerpt = (text: string) => digestCodex({ head: text, tail: text, finalReply: 'excerpt' })
const message = (text: string, phase = 'final_answer') => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }],
} })

describe('已登记原件摘要的最终答复摘录', () => {
  it('真实记录本已解析为 final，摘录不得再被人话清洗清空', () => {
    expect(turnsOf('codex-rollout', { head: raw, tail: raw }).turns.at(-1))
      .toMatchObject({ k: 'reply', final: true, text: 'QA_1C_SUGGEST_REAL' })
    expect(excerpt(raw).rounds).toHaveLength(1)
    expect(excerpt(raw).rounds[0]?.reply).toBe('QA_1C_SUGGEST_REAL')
    const ordinary = digestCodex({ head: raw, tail: raw })
    expect(ordinary.rounds[0]?.reply).toBeUndefined()
    expect(excerpt(raw).title).toBe(ordinary.title)
    expect(excerpt(raw).activity).toEqual(ordinary.activity)
  })
  it.each(['RESULT_42', 'OK', '交付文件是 `src/output.ts`。'])('保留来源原字而非匹配特定QA词：%s', text => {
    expect(excerpt(message(text)).rounds[0]?.reply).toBe(text)
  })
  it('最终答复仍有长度上限，空白不编回复', () => {
    expect(excerpt(message('答'.repeat(150))).rounds[0]?.reply).toBe('答'.repeat(119) + '…')
    expect(excerpt(message('  ')).rounds).toEqual([])
  })
  it('旁白、工具结果、思考及结束信号不能借摘录变成最终答复', () => {
    const rows = [message('PROGRESS_ONLY', 'commentary'),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'REASONING_ONLY' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL_ONLY' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'NOT_A_REPLY_EVENT' } }),
    ].join('\n')
    expect(excerpt(rows).rounds).toEqual([])
  })
})
