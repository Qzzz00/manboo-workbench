/**
 * 英文报错说人话(2026-09-25,卡 V)。
 *
 * 09-25 晚维护者屏上那张卡写的是「Not logged in · Please run」—— 一句英文、还带半条命令行指令。
 * 维护者的规矩第 3 条:不露内部的东西(英文键名、路径、命令行);另一条:出错有人话 + 下一步。
 */
import { describe, expect, it } from 'vitest'
import { HUMAN_ERROR_ACTION_LABELS, HUMAN_ERROR_UNKNOWN, humanError, isKnownError } from '../src/humanError.ts'

describe('humanError:一段原文 → 一句人话 + 一个一键入口', () => {
  it('★那两张假卡上的原话 → 「Claude 命令行还没登录」+ 一颗「登录 Claude」', () => {
    const out = humanError({ code: 'authentication_failed', raw: 'Not logged in · Please run /login' })
    expect(out).toMatchObject({ line: 'Claude 命令行还没登录', action: 'login_claude' })
    // 原文收进「看原始」,不直接上界面。
    expect(out?.raw).toBe('Not logged in · Please run /login')
    expect(HUMAN_ERROR_ACTION_LABELS[out!.action!]).toBe('登录 Claude')
  })

  it('只有错误码也翻得出(真机 78 份里见过的两个码)', () => {
    expect(humanError({ code: 'authentication_failed' })?.line).toBe('Claude 命令行还没登录')
    expect(humanError({ code: 'rate_limit' })?.line).toBe('这家一会儿才能再用(刚才用得太快)')
  })

  it('逐条对照:额度、限流、上游忙、网络、没装、权限、太长、模型、掐断', () => {
    const cases: readonly [string, string][] = [
      ['Your credit balance is too low to access the API', '这家的额度用完了'],
      ['429 Too Many Requests', '这家一会儿才能再用(刚才用得太快)'],
      ['overloaded_error', '这家现在太忙,过一会儿再试'],
      ['connect ECONNREFUSED 127.0.0.1:8791', '连不上这家的服务'],
      ['getaddrinfo ENOTFOUND api.example.com', '网络不通(域名解析不了)'],
      ['socket timed out after 60s', '等太久了,没等到回话'],
      ['fetch failed', '连不上网'],
      ['zsh: command not found: codex', '这家的命令行没装'],
      ['EACCES: permission denied', '没有权限读这个位置'],
      ['prompt is too long: 250000 tokens', '这一轮的内容太长了'],
      ['model claude-x does not exist', '这个模型用不了'],
      ['request aborted by user', '中途停了'],
      ['invalid api key provided', '这家的密钥不对'],
    ]
    for (const [raw, line] of cases) {
      expect(humanError({ raw }), raw).toMatchObject({ line })
    }
  })

  it('★翻不出来的一律归成「出错了(看原始)」,原文收进 raw —— 不把生英文摆在他眼前', () => {
    const out = humanError({ raw: 'Unexpected Zorblatt condition in frobnicator' })
    expect(out?.line).toBe(HUMAN_ERROR_UNKNOWN)
    expect(out?.raw).toBe('Unexpected Zorblatt condition in frobnicator')
    expect(out?.action).toBeUndefined()
    expect(isKnownError({ raw: 'Unexpected Zorblatt condition in frobnicator' })).toBe(false)
  })

  it('没有错误就不造一个', () => {
    expect(humanError({})).toBeUndefined()
    expect(humanError({ code: '', raw: '   ' })).toBeUndefined()
  })

  it('原文很长时截过再存(不把一整段日志搬进 /state)', () => {
    const out = humanError({ raw: 'x'.repeat(900) })
    expect([...(out?.raw ?? '')].length).toBeLessThanOrEqual(201)
    expect(out?.raw?.endsWith('…')).toBe(true)
  })

  it('人话里不出现英文键名、路径、斜杠命令(维护者规矩第 3 条)', () => {
    const lines = [
      humanError({ code: 'authentication_failed', raw: 'Not logged in · Please run /login' })?.line,
      humanError({ raw: 'connect ECONNREFUSED 127.0.0.1:8791' })?.line,
      humanError({ raw: 'zsh: command not found: codex' })?.line,
    ]
    for (const line of lines) {
      expect(line).toBeTruthy()
      expect(line).not.toMatch(/\/login|ECONNREFUSED|command not found|[a-z]+_[a-z]+/)
    }
  })

  it('每颗按钮都有中文名(界面不许露英文键名)', () => {
    for (const label of Object.values(HUMAN_ERROR_ACTION_LABELS)) {
      expect(label).toMatch(/[一-鿿]/)
    }
  })
})
