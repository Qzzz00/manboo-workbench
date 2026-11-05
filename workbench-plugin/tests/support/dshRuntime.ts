/**
 * 装机形态测试要用的「那份真的 DSH 运行时在哪」(2026-09-26,卡 AK 从
 * `install-shape-model-patch.test.ts` 抽出来)。
 *
 * ## 为什么要抽出来
 *
 * U1b 写那份测试时,0.1.7 还装在 `~/.dsh/runtime-next`(灰度产物,生产还跑着 0.1.2)。
 * 生产切过去之后 `runtime-next` 被**改名成了 `runtime`** —— 那个常量就再也指不到东西,
 * 于是整份测试**静悄悄地跳过**:它守的那条断点(真 DSH 认不认我们写的补丁)从此没人守。
 * 一份"永远跳过的守门"比没有守门更糟,因为它看起来是绿的。
 *
 * 所以按顺序找,找到**版本对的那一份**才算数:
 * 1. `WB_DSH_RUNTIME`(手工指一份别的);
 * 2. `~/.dsh/runtime-next`(升级途中、还没切生产的机器);
 * 3. `~/.dsh/runtime`(切过生产的机器 —— 今天这台)。
 *
 * ## 纪律
 *
 * **只读着用**:测试拿它是为了 `node .../bin.js --dump-config`,`DSH_HOME` 一律指向
 * mkdtemp 出来的沙箱,那份运行时目录一个字节都不写(装机形态测试里是 symlink 过去的)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCKED_DSH_VERSION } from '../../src/server/setup/paths.ts'

/** 一份运行时里装着的 dsh 版本;读不到回 undefined。 */
export function runtimeDshVersion(runtimeDir: string): string | undefined {
  try {
    const text = readFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    return (JSON.parse(text) as { version?: string }).version
  }
  catch { return undefined }
}

export interface DshRuntimePick {
  /** 选中的那一份(没有版本对的就是最后一个候选,只为报告里说得清)。 */
  dir: string
  /** 它里面装着的版本。 */
  version: string | undefined
  /** 版本正好是我们锁着的那一版 —— 只有这时才验得了「真 DSH 认不认」。 */
  ready: boolean
  /** 跳过时说给人听的那一句(里面有路径,进 console 不进界面)。 */
  why: string
}

/** 按上面那三条顺序挑一份真运行时。 */
export function pickDshRuntime(): DshRuntimePick {
  const candidates = process.env.WB_DSH_RUNTIME !== undefined
    ? [process.env.WB_DSH_RUNTIME]
    : [join(homedir(), '.dsh', 'runtime-next'), join(homedir(), '.dsh', 'runtime')]
  const tried: string[] = []
  for (const dir of candidates) {
    if (!existsSync(dir)) { tried.push(`${dir}(不在)`); continue }
    const version = runtimeDshVersion(dir)
    if (version === LOCKED_DSH_VERSION) return { dir, version, ready: true, why: '' }
    tried.push(`${dir}(${version ?? '读不到版本'})`)
  }
  const last = candidates[candidates.length - 1] as string
  return {
    dir: last,
    version: runtimeDshVersion(last),
    ready: false,
    why: `没找到装着 ${LOCKED_DSH_VERSION} 的运行时:${tried.join('、')}`,
  }
}

/** 跑 dsh 用的 node:优先自有那一条(与 `dsh-start` 同一条),没有就用跑测试这条。 */
export function dshNode(): string {
  const own = join(homedir(), '.dsh', 'node', 'bin', 'node')
  return existsSync(own) ? own : process.execPath
}
