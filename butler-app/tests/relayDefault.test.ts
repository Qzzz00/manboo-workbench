/**
 * 手机包的缺省中转地址构建时注入(2026-10-21,局域网 M7):开源构建是空,我们的包读内部仓的构建档。
 * 卡 M4 拿 `DEFAULT_RELAY_URL === ''` 判「这份手机包没接中转」、藏登录入口。
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAY_URL } from '../src/account/accountStore'
// @ts-expect-error 构建脚本是 .mjs,没有类型声明
import { RELEASE_PROFILE_FILE, relayUrlForBuild } from '../scripts/build-relay.mjs'

function profile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'phone-relay-')), 'release-endpoints.env')
  writeFileSync(file, text)
  return file
}

describe('手机包的缺省中转', () => {
  it('用例里跑的是开源缺省:空', () => {
    expect(DEFAULT_RELAY_URL).toBe('')
  })

  it('构建档有就用它;环境变量压过它,设成空也算;都没有是空', () => {
    const file = profile('# x\nWORKBENCH_BUILD_RELAY_URL="https://relay.example/"\n')
    expect(relayUrlForBuild({}, file)).toBe('https://relay.example')
    expect(relayUrlForBuild({ WORKBENCH_BUILD_RELAY_URL: '' }, file)).toBe('')
    expect(relayUrlForBuild({ WORKBENCH_BUILD_RELAY_URL: 'https://self.example' }, file)).toBe('https://self.example')
    expect(relayUrlForBuild({}, join(tmpdir(), 'no-such-profile.env'))).toBe('')
  })

  it('写错的地址让构建停下', () => {
    expect(() => relayUrlForBuild({ WORKBENCH_BUILD_RELAY_URL: 'api.example.com' })).toThrow(/http/)
  })

  it.skipIf(!existsSync(RELEASE_PROFILE_FILE))('内部仓的构建档写的是线上那台(与电脑端同一份)', () => {
    expect(relayUrlForBuild({})).toBe('https://api.aibooo.cn')
  })
})
