import { describe, expect, it } from 'vitest'
import { LOGIN_TARGETS, pollRefreshToken } from '../src/server/webLogin.ts'

describe('LOGIN_TARGETS', () => {
  it('只有 Kimi 走登录', () => {
    expect(Object.keys(LOGIN_TARGETS)).toEqual(['kimi_web'])
  })

  it('★存的是长期凭据 refresh_token，不是只活 15 分钟的 access token', () => {
    const target = LOGIN_TARGETS.kimi_web

    expect(target.url).toMatch(/^https:\/\/www\.kimi\.com\//)
    // 抓 access_token 就是"重登后几分钟又失效"的成因，别改回去。
    expect(target.tokenKey).toBe('refresh_token')
  })

  it('Claude 不在登录名单里——它走 statusLine，之前那个登录按钮是条死路', () => {
    expect(Object.keys(LOGIN_TARGETS)).not.toContain('claude_web')
  })
})


describe('pollRefreshToken:登录窗口不能被我们自己刷掉(真机 2026-09-07)', () => {
  const target = LOGIN_TARGETS.kimi_web
  const sleep = async () => {}

  function fakeCdp(origin: string, tokens: (string | null)[]) {
    const calls: string[] = []
    const queue = [...tokens]
    const call = async (method: string, params: unknown) => {
      calls.push(method + (method === 'Page.navigate' ? ':' + String((params as { url: string }).url) : ''))
      if (method === 'Runtime.evaluate') {
        const expr = String((params as { expression: string }).expression)
        if (expr === 'location.origin') return { result: { value: origin } }
        return { result: { value: queue.shift() ?? '' } }
      }
      return {}
    }
    return { call, calls }
  }

  it('页面已经在 kimi.com 上:一次 Page.navigate 都不发,只轮询 localStorage 直到拿到 refresh_token', async () => {
    const { call, calls } = fakeCdp('https://www.kimi.com', [null, null, 'rt-1'])
    await expect(pollRefreshToken(call, target, sleep)).resolves.toBe('rt-1')
    expect(calls.filter(c => c.startsWith('Page.navigate'))).toEqual([])
    expect(calls.filter(c => c === 'Runtime.evaluate').length).toBe(4)
  })

  it('页面停在别处(about:blank)才导航一次到目标页', async () => {
    const { call, calls } = fakeCdp('null', ['rt-2'])
    await expect(pollRefreshToken(call, target, sleep)).resolves.toBe('rt-2')
    expect(calls.filter(c => c.startsWith('Page.navigate'))).toEqual([`Page.navigate:${target.url}`])
  })

  it('外层超时后循环退出,返回 undefined,不再碰页面', async () => {
    const { call, calls } = fakeCdp('https://www.kimi.com', [null, null, null, null])
    let ticks = 0
    const cancelled = () => ticks++ >= 2
    await expect(pollRefreshToken(call, target, sleep, cancelled)).resolves.toBeUndefined()
    expect(calls.filter(c => c.startsWith('Page.navigate'))).toEqual([])
    expect(calls.length).toBeLessThan(5)
  })
})
