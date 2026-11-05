import { describe, expect, it } from 'vitest'
import { parseClaudeStatusLine } from '../src/quota/claude.ts'

/** 形状取自 Claude Code 官方 statusLine 文档的 stdin JSON schema。 */
const payload = {
  session_id: 'abc123',
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
}

describe('parseClaudeStatusLine', () => {
  it('5 小时与周窗口都换算成剩余百分比（PRD §8.2 规则 1）', () => {
    const quota = parseClaudeStatusLine(payload)

    expect(quota.kind).toBe('quota')
    expect(quota.windows).toEqual([
      { label: '5h', left_pct: 76.5, reset_at: new Date(1738425600 * 1000).toISOString() },
      { label: '周', left_pct: 58.8, reset_at: new Date(1738857600 * 1000).toISOString() },
    ])
  })

  it('只有其中一个窗口时也能出数', () => {
    const quota = parseClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 10 } } })

    expect(quota.windows).toEqual([{ label: '5h', left_pct: 90 }])
  })

  it('浮点不能留出 76.50000000000001 这种尾巴', () => {
    const quota = parseClaudeStatusLine({ rate_limits: { seven_day: { used_percentage: 0.1 } } })

    expect(quota.windows[0]?.left_pct).toBe(99.9)
  })

  it('没有 rate_limits 时抛错——旧版 Claude Code 不给这个字段，要如实标未接入', () => {
    expect(() => parseClaudeStatusLine({ session_id: 'abc' })).toThrow()
  })

  it('字段存在但不是数字时抛错，不猜也不补 0', () => {
    expect(() => parseClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: null } } })).toThrow()
  })

  it('整份 payload 里的其它字段一律不进结果——只取额度，不带走会话内容', () => {
    const quota = parseClaudeStatusLine({ ...payload, transcript_path: '/Users/example/secret.jsonl' })

    expect(JSON.stringify(quota)).not.toContain('secret')
  })
})
