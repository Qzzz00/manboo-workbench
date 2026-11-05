// @vitest-environment node
/**
 * 构建时注入中转地址(2026-10-21,局域网 M7「零服务器是缺省」):源码不带地址,构建档带。
 * 读法见 scripts/build-endpoints.mjs 文件头。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEndpointDefines, checkBuiltBundle, parseProfile, RELEASE_PROFILE_FILE, resolveBuildEndpoints,
} from '../scripts/build-endpoints.mjs'
import { BUILD_RELAY_URL, BUILD_UPDATE_MANIFEST_URL } from '../src/buildEndpoints.ts'

function profile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-build-endpoints-'))
  const file = join(dir, 'release-endpoints.env')
  writeFileSync(file, text)
  return file
}

const OURS = profile([
  '# 我们自己的那一档',
  'WORKBENCH_BUILD_RELAY_URL=https://relay.example',
  'WORKBENCH_BUILD_UPDATE_URL="https://relay.example/updates/latest.json"',
  '',
].join('\n'))

describe('构建档', () => {
  it('没有构建档、也没设环境变量 = 开源缺省:两样都空', () => {
    expect(resolveBuildEndpoints({ env: {}, profileFile: join(tmpdir(), 'no-such-profile.env') }))
      .toEqual({ relay_url: '', update_manifest_url: '', from: 'none' })
  })

  it('有构建档就用它(引号去掉)', () => {
    expect(resolveBuildEndpoints({ env: {}, profileFile: OURS })).toEqual({
      relay_url: 'https://relay.example',
      update_manifest_url: 'https://relay.example/updates/latest.json',
      from: 'profile',
    })
  })

  it('环境变量压过构建档;设成空也算 —— 内部仓里能打出开源那一份', () => {
    expect(resolveBuildEndpoints({ env: { WORKBENCH_BUILD_RELAY_URL: '' }, profileFile: OURS }))
      .toEqual({ relay_url: '', update_manifest_url: '', from: 'env' })
    expect(resolveBuildEndpoints({ env: { WORKBENCH_BUILD_RELAY_URL: 'https://self.example/' }, profileFile: OURS }))
      .toEqual({ relay_url: 'https://self.example', update_manifest_url: '', from: 'env' })
  })

  it('写错的地址让构建停下,不编进一个连不上的值', () => {
    expect(() => resolveBuildEndpoints({ env: { WORKBENCH_BUILD_RELAY_URL: 'api.example.com' } })).toThrow(/http/)
  })

  it('注释、空行、export 前缀都认', () => {
    expect(parseProfile('# x\n\nexport A_B=1\nC=\'2\'\nnot a line\n')).toEqual({ A_B: '1', C: '2' })
  })

  it('define 的值是 JSON 字面量', () => {
    expect(buildEndpointDefines({ relay_url: '', update_manifest_url: 'https://u.example/latest.json', from: 'env' })).toEqual({
      __WORKBENCH_BUILD_RELAY_URL__: '""',
      __WORKBENCH_BUILD_UPDATE_URL__: '"https://u.example/latest.json"',
    })
  })

  it('核产物:带地址的那一份两个地址都要在;不带的那一份不许有 aibooo.cn', () => {
    const ours = { relay_url: 'https://relay.example', update_manifest_url: 'https://relay.example/updates/latest.json', from: 'profile' as const }
    expect(checkBuiltBundle('const a = "https://relay.example"; const b = "https://relay.example/updates/latest.json"', ours)).toEqual([])
    expect(checkBuiltBundle('const a = "https://relay.example"', ours)).toHaveLength(1)
    expect(checkBuiltBundle('const a = "https://relay.example"', ours, ['relay'])).toEqual([])
    const open = { relay_url: '', update_manifest_url: '', from: 'none' as const }
    expect(checkBuiltBundle('const ua = "x (+https://www.aibooo.cn)"', open)).toEqual([])
    expect(checkBuiltBundle('const u = "https://api.aibooo.cn/v1"', open)).toHaveLength(1)
    expect(checkBuiltBundle('/** 例:baseURL: https://api.aibooo.cn/v1 */ const site = "www.aibooo.cn"', open)).toEqual([])
  })

  // 下面两条只在内部仓成立:开发仓里没有这一档、也没有 docs/(那边按开源缺省构建)。
  const EXPORTER = join(import.meta.dirname, '..', '..', 'docs', '拆仓', '导出开发仓.sh')

  it.skipIf(!existsSync(RELEASE_PROFILE_FILE))('我们那一档就在内部仓的 deploy/ 下,写的是线上那两个地址', () => {
    expect(resolveBuildEndpoints({ env: {}, profileFile: RELEASE_PROFILE_FILE })).toEqual({
      relay_url: 'https://api.aibooo.cn',
      update_manifest_url: 'https://api.aibooo.cn/updates/latest.json',
      from: 'profile',
    })
  })

  it.skipIf(!existsSync(EXPORTER))('导出开发仓时剥掉这一档', () => {
    const exporter = readFileSync(EXPORTER, 'utf8')
    const strip = /^STRIP=\((.*)\)$/m.exec(exporter)?.[1] ?? ''
    expect(strip.split(/\s+/)).toContain('deploy/release-endpoints.env')
  })
})

describe('用例里跑的是开源缺省', () => {
  // vitest 不注入构建档(vitest.config.ts):用例要中转就自己写进 model.json,不靠缺省。
  it('源码里读到的两样都是空', () => {
    expect(BUILD_RELAY_URL).toBe('')
    expect(BUILD_UPDATE_MANIFEST_URL).toBe('')
  })
})
