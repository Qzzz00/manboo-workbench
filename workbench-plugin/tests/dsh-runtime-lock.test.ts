// @vitest-environment node
/**
 * 仓库里那份 DSH 运行时锁定清单的自洽性(2026-09-23 安装器锁运行时依赖)。
 *
 * 这几条红了,多半是改了 `LOCKED_DSH_VERSION` 却没重生成
 * `src/server/setup/dsh-runtime/` 下的两份文件 —— 重生成步骤见 dshRuntimeLock.ts 文件头。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_RUNTIME_GUARD_PACKAGES, DSH_RUNTIME_LOCK, DSH_RUNTIME_PACKAGE, describeDrift, isLockedRuntimeLock,
  lockedRuntimeVersion, runtimeDrift, runtimeLockText,
} from '../src/server/setup/dshRuntimeLock.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { EXTRA_DSH_PACKAGES, LOCKED_DSH_VERSION } from '../src/server/setup/paths.ts'
import { seedLockedRuntime } from './setup/dshRuntimeFake.ts'

interface Lock { lockfileVersion: number, packages: Record<string, { version?: string, resolved?: string, integrity?: string, link?: boolean, dependencies?: Record<string, string> }> }
const lock = DSH_RUNTIME_LOCK as Lock
const pkg = DSH_RUNTIME_PACKAGE as { dependencies: Record<string, string> }

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

describe('锁定清单 · 自洽', () => {
  it('dsh 主包与三个 client 包都锁在 LOCKED_DSH_VERSION(换版本忘了重生成会红)', () => {
    expect(lockedRuntimeVersion('@deepseek-ai/dsh')).toBe(LOCKED_DSH_VERSION)
    for (const name of EXTRA_DSH_PACKAGES) {
      expect(lockedRuntimeVersion(name), name).toBe(LOCKED_DSH_VERSION)
      // 是顶层依赖:npm ci 一条命令就把它们装上,不需要再单独 npm i。
      expect(Object.keys(pkg.dependencies), name).toContain(name)
    }
  })

  it('package.json 与锁文件根上的依赖一字不差(不一致 npm ci 会直接拒装)', () => {
    expect(lock.packages['']?.dependencies).toEqual(pkg.dependencies)
    expect(lock.lockfileVersion).toBe(3)
  })

  it('每个包都带 resolved + integrity:npm ci 装出来的字节可复现', () => {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '' || entry.link === true) continue
      expect(entry.integrity, key).toMatch(/^sha512-/)
      expect(entry.resolved, key).toMatch(/^https:\/\//)
    }
  })

  /**
   * cordis 一家的版本**逐个钉死**。
   *
   * 09-23 白屏事故就是这一串漂上去造成的(cordis 4.0.2→4.0.4 等等),所以这几行不是抽查,
   * 是"这一版 DSH 配的就是这一组"的断言:换 DSH 版本时它们必须跟着改,而改的人被逼着去
   * 看一眼上游主包 `dependencies` 里写的范围,而不是让 `npm i` 替他决定。
   *
   * 2026-09-25 升 0.1.7-rc.2 时这一组整体换了(上游主包 deps:`~4.0.4` / `~1.0.5` / …),
   * 而且 `cordis-plugin-hmr` **不在 0.1.7 的依赖树里**了 —— 热重载改由 `dsh-hmr` 管。
   */
  it('cordis 一家是 0.1.7-rc.2 配的那一组', () => {
    expect(lockedRuntimeVersion('@deepseek-ai/cordis')).toBe('4.0.4')
    expect(lockedRuntimeVersion('@deepseek-ai/cordis-plugin-loader')).toBe('1.0.5')
    expect(lockedRuntimeVersion('@deepseek-ai/cordis-plugin-include')).toBe('1.0.9')
    expect(lockedRuntimeVersion('@deepseek-ai/cordis-plugin-group')).toBe('1.0.4')
    expect(lockedRuntimeVersion('@deepseek-ai/cordis-plugin-timer')).toBe('1.1.6')
    expect(lockedRuntimeVersion('@deepseek-ai/cosmokit')).toBe('1.8.5')
    expect(lockedRuntimeVersion('@deepseek-ai/schemastery')).toBe('3.18.4')
    // 热重载那一家换了名字:0.1.2 是 cordis-plugin-hmr,0.1.7 是 dsh-hmr。
    // 两条一起断言,免得哪天只换了守卫清单、没换锁文件(或反过来)。
    expect(lockedRuntimeVersion('@deepseek-ai/dsh-hmr')).toBe(LOCKED_DSH_VERSION)
    expect(lockedRuntimeVersion('@deepseek-ai/cordis-plugin-hmr')).toBeUndefined()
    expect(DSH_RUNTIME_GUARD_PACKAGES).not.toContain('@deepseek-ai/cordis-plugin-hmr')
  })

  it('守卫要核对的每个包,锁文件里都有(否则那一项等于没核)', () => {
    for (const name of DSH_RUNTIME_GUARD_PACKAGES) expect(lockedRuntimeVersion(name), name).toBeDefined()
  })

  it('写出去的锁文件文本认得回来;别的锁文件认不得', () => {
    expect(isLockedRuntimeLock(runtimeLockText())).toBe(true)
    expect(isLockedRuntimeLock('{"lockfileVersion":3,"packages":{}}')).toBe(false)
    expect(isLockedRuntimeLock('不是 JSON')).toBe(false)
    expect(isLockedRuntimeLock(undefined)).toBe(false)
  })
})

describe('版本守卫', () => {
  it('全对 → 空;漂一个、缺一个 → 逐个说清', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runtime-drift-'))
    dirs.push(dir)
    const io = nodeSetupIo()
    seedLockedRuntime(dir)
    expect(await runtimeDrift(io, dir)).toEqual([])

    // 漂一个(cordis 退回 09-20 那一版,正是 0.1.7 不能用的那个)+ 缺一个。
    seedLockedRuntime(dir, { '@deepseek-ai/cordis': '4.0.2' })
    rmSync(join(dir, 'node_modules/@deepseek-ai/cosmokit'), { recursive: true })
    const drift = await runtimeDrift(io, dir)
    expect(drift).toEqual([
      { name: '@deepseek-ai/cordis', want: '4.0.4', got: '4.0.2' },
      { name: '@deepseek-ai/cosmokit', want: '1.8.5' },
    ])
    expect(describeDrift(drift)).toBe('@deepseek-ai/cordis 应是 4.0.4,装成了 4.0.2;@deepseek-ai/cosmokit 没装上(应是 1.8.5)')
  })
})
