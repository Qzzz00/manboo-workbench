// @vitest-environment node
/**
 * 连接器接给事务官那一项,**真 dsh 必须认**(2026-09-27 12:05,统筹撞出的事故)。
 *
 * 卡 OC2 往 `cordis.patch.yml` 写的那一项 `Authorization: !!js \`Bearer …\`` 没加引号 —— YAML 里反引号不能起头,
 * 真 dsh 读补丁层当场抛错,**整个工作台服务起不来**(维护者这台 12:02 重装插件后 8791 等了 90 秒没起来)。
 * 而且它写成了顶层 `- id:`(那是「改一项已有的」),加一项新的要走 `- insert:`。
 * 这一份拿**装着的真 dsh** `--dump-config` 验:补丁层带上这一项,进程要正常退出、不抱怨、合成结果里真有它。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { patchDsh } from '../src/server/connector/mcpConfig.ts'
import { profilePackageJson, renderProfilePatch } from '../src/server/setup/install.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { READY, RUNTIME, dumpConfig } from './setup/realDshRuntime.ts'

const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-connector-')
const boxes: string[] = []
afterEach(() => {
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function machine(patch: string) {
  const home = mkdtempSync(BOX_PREFIX)
  boxes.push(home)
  const paths = setupPaths({ home })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  symlinkSync(RUNTIME, paths.runtimeDir)
  mkdirSync(paths.profileDir, { recursive: true })
  writeFileSync(paths.profilePackageJson, profilePackageJson())
  writeFileSync(paths.profilePatchYml, patch)
  return { paths, dump: () => dumpConfig(paths.dshHome, paths.runtimeDir) }
}

describe.skipIf(!READY)('连接器那一项,真 dsh 认', () => {
  it('★补丁层加上连接器那一项:真 dsh 照常合出配置、不抱怨,合成结果里有 mcp-open-connector', () => {
    const base = renderProfilePatch(undefined)
    const patched = patchDsh(base, { port: 8796, recorded: undefined } as never)
    expect(patched.ok).toBe(true)
    const box = machine(patched.text)
    const { config, warnings } = box.dump()
    expect(warnings).not.toContain('failed to parse')
    expect(warnings).not.toContain('entry "mcp-open-connector" not found')
    expect(config).toContain('mcp-open-connector')
    expect(config).toContain('http://127.0.0.1:8796/mcp')
  })

  it('★老机器上写坏的那一项(不带引号的反引号)会被认成我们的并换掉', () => {
    const base = renderProfilePatch(undefined)
    const broken = `${base}- id: mcp-open-connector\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: open-connector\n    transport: streamable-http\n    url: http://127.0.0.1:8796/mcp\n    headers:\n      Authorization: !!js \`Bearer \${process.env.OPEN_CONNECTOR_TOKEN}\`\n`
    const fixed = patchDsh(broken, { port: 8796, recorded: undefined } as never)
    expect(fixed.changed).toBe(true)
    expect(fixed.text).not.toContain('!!js `Bearer')
    const { warnings } = machine(fixed.text).dump()
    expect(warnings).not.toContain('failed to parse')
  })
})
