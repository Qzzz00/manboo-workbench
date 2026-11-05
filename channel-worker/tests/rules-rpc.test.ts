/**
 * 她记住的规矩(2026-09-24 晚,卡 K):手机设置里那张表出了局域网也要看得见、删得动、改得了。
 * 只开看、写一条、改、删、恢复五条;导入、反馈、自查是电脑那边的事,不进房间。
 */
import { describe, expect, it } from 'vitest'
import { isAllowedRpcPath } from '../src/rpc.ts'

describe('规矩表那几条路在房间白名单里', () => {
  it('★看、写一条、改、删、恢复', () => {
    expect(isAllowedRpcPath('GET', '/butler/rules')).toBe(true)
    for (const path of ['/butler/rules', '/butler/rules/update', '/butler/rules/remove', '/butler/rules/restore']) {
      expect(isAllowedRpcPath('POST', path)).toBe(true)
    }
  })

  it('★导入、反馈、自查、那几段字不进房间', () => {
    for (const path of ['/butler/rules/import', '/butler/rules/feedback', '/butler/rules/check']) {
      expect(isAllowedRpcPath('POST', path)).toBe(false)
    }
    expect(isAllowedRpcPath('GET', '/butler/rules/brief')).toBe(false)
  })
})
