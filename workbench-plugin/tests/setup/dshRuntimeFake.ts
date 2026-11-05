/**
 * 假 `npm ci` 的替身(2026-09-23 安装器锁运行时依赖)。
 *
 * 装运行时那步装完要核对「关键包的版本 = 锁文件里的」。测试里 npm 是假的,不会真在
 * `node_modules` 里放东西 —— 所以假 exec 碰到 `npm ci` 时调这个,照锁文件把那几个关键包的
 * package.json 与 npm 装完才写的隐藏锁文件摆出来,效果就等于"装成功了"。
 *
 * `overrides` 用来造漂移:比如 `{ '@deepseek-ai/cordis-plugin-hmr': '1.0.19' }`
 * 就是 09-23 从零重装那次真机上的样子。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_RUNTIME_GUARD_PACKAGES, lockedRuntimeVersion } from '../../src/server/setup/dshRuntimeLock.ts'

export function seedLockedRuntime(runtimeDir: string, overrides: Record<string, string> = {}): void {
  for (const name of DSH_RUNTIME_GUARD_PACKAGES) {
    const dir = join(runtimeDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: overrides[name] ?? lockedRuntimeVersion(name) }))
  }
  writeFileSync(join(runtimeDir, 'node_modules', '.package-lock.json'), '{}')
}

/** 假 exec 里用:这条命令是不是在某个目录里跑的 `npm ci`。 */
export function isNpmCi(cmd: readonly string[]): boolean {
  return cmd[0] === 'npm' && cmd[1] === 'ci'
}
