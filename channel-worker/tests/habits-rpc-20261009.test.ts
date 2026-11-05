/**
 * 「它学到了什么」(2026-10-09):手机设置里那一页出了局域网也要看得见、撤得掉(维护者 9/29 起只带手机)。
 * 只开看习惯、撤一条、读进化日志三条;学一遍、进化循环的写路不进房间。
 */
import { describe, expect, it } from 'vitest'
import { isAllowedRpcPath } from '../src/rpc.ts'

describe('它学到了什么那几条路在房间白名单里', () => {
  it('★看、撤一条、进化日志', () => {
    expect(isAllowedRpcPath('GET', '/habits')).toBe(true)
    expect(isAllowedRpcPath('POST', '/habits/revoke')).toBe(true)
    expect(isAllowedRpcPath('GET', '/evolve/log')).toBe(true)
  })

  it('★撤错了恢复、「新学到一条」点知道了(2026-10-10)', () => {
    expect(isAllowedRpcPath('POST', '/habits/restore')).toBe(true)
    expect(isAllowedRpcPath('POST', '/habits/seen')).toBe(true)
    expect(isAllowedRpcPath('GET', '/habits/restore')).toBe(false)
    expect(isAllowedRpcPath('GET', '/habits/seen')).toBe(false)
  })

  it('★别的不放:撤只认 POST,进化循环的写路不进房间', () => {
    expect(isAllowedRpcPath('GET', '/habits/revoke')).toBe(false)
    expect(isAllowedRpcPath('POST', '/habits')).toBe(false)
    for (const path of ['/evolve/scan', '/evolve/accept', '/evolve/revert', '/evolve/wire']) {
      expect(isAllowedRpcPath('POST', path)).toBe(false)
    }
  })
})
