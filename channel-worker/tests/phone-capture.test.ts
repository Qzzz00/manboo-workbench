import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectCapture, instrumentSource } from '../dev/phoneCapture.ts'

describe('isolated phone evidence capture', () => {
  it('keeps request correlation while dropping credentials and arbitrary fields', () => {
    expect(projectCapture('say_request', {
      client_key: 'say-test', text: '好，去见吧。', entrance: 'phone',
      ctx: { last_say_id: 'say-prev', confirmed: { ask_id: 'ask-a', choice: '否' }, token: 'secret' },
      headers: { authorization: 'secret' }, token: 'secret',
    })).toEqual({ client_key: 'say-test', text: '好，去见吧。', entrance: 'phone',
      ctx: { last_say_id: 'say-prev', confirmed: { ask_id: 'ask-a', choice: '否' } } })
  })
  it('captures provider utterance boundaries without retaining raw frames', () => {
    expect(projectCapture('asr_frame', { result: { text: '前段。后段。', utterances: [
      { text: '前段。', definite: true, start_time: 0, end_time: 800, token: 'secret' },
      { text: '后段。', definite: false, start_time: 900, end_time: 1200 },
    ] }, headers: 'secret' })).toEqual({ text: '前段。后段。', utterances: [
      { text: '前段。', definite: true, start_time: 0, end_time: 800 },
      { text: '后段。', definite: false, start_time: 900, end_time: 1200 },
    ] })
  })
  it('instruments exact current source boundaries and fails closed on source drift', () => {
    for (const path of ['agent.ts', 'asr/volcProtocol.ts', 'asr/volcSession.ts']) {
      const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
      expect(instrumentSource(`/channel-worker/src/${path}`, source).includes('__phoneCapture')).toBe(true)
    }
    expect(() => instrumentSource('/channel-worker/src/agent.ts', 'changed source')).toThrow(/boundary/)
    expect(instrumentSource('/other/agent.ts', 'unchanged')).toBe('unchanged')
  })
})
