/**
 * 真的 0.1.7 运行时在哪、怎么让它把整棵 profile 合出来(装机形态测试共用;2026-09-26 从
 * `install-shape-model-patch.test.ts` 抽出来)。
 *
 * ## 为什么要有这一份
 *
 * 有一类错**只有真 dsh 认一遍才看得见**:profile patch 是「按 id 覆盖」,id 写错一个字,
 * 上游 `applyEntryPatches` 只 `warn("patch: entry %C not found")` 然后整行跳过 ——
 * 进程照样起、界面一切正常。cookie 寿命那一行(`client-connection` → `connection`)
 * 就这么从 0.1.2 活到 0.1.7 都没人发现。静态地拿 id 去对上游 checkout 的 yml 是一道守门
 * (`client-upstream-seats.test.ts`),但它对的是**源码仓库**里的组合;这一份对的是
 * **装在机器上的那份运行时**真怎么合 —— 两道各守一头。
 *
 * ## 运行时在哪
 *
 * 0.1.7 的运行时不进 git(514MB)。按顺序找第一份版本 = `LOCKED_DSH_VERSION` 的:
 *   1. `WB_DSH_RUNTIME`(指一份别的);
 *   2. `~/.dsh/runtime-next`(灰度时它在这儿;U1b 那份测试原来只认这一处);
 *   3. `~/.dsh/runtime`(生产切换之后 `runtime-next` 已经换名成它,原来那一处就空了 ——
 *      2026-09-26 02:57 这台机器就是这样,只认 `runtime-next` 的写法从此整份跳过而没人知道)。
 * 都不是就 `READY = false`,用它的测试整份跳过并说清原因 —— 拿假 dsh 验等于什么都没验。
 *
 * ## 纪律
 *
 * - **只读着用**:测试里把 `runtime` 做成符号链接指向这份真运行时,不拷、不写;
 *   `DSH_HOME` 一律是 mkdtemp 出来的,生产一个字节不碰。
 * - `--dump-config` 只把合成结果打到 stdout 就退出,**不 listen、不 mount**(跑前跑后 lsof 核过)。
 *   但按决策记录 09-26「灰度里任何 dsh 命令都要带 `WORKBENCH_PORT`」的纪律仍然带上一个非 8791 的值:
 *   哪天上游把 `--dump-config` 改成先起服务再 dump,也不会把生产那个 8791 遮住。
 * - `launchctl` 一次都不跑。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCKED_DSH_VERSION } from '../../src/server/setup/paths.ts'

function dshVersionAt(runtimeDir: string): string | undefined {
  try {
    const text = readFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    return (JSON.parse(text) as { version?: string }).version
  }
  catch { return undefined }
}

const CANDIDATES: readonly string[] = [
  process.env.WB_DSH_RUNTIME,
  join(homedir(), '.dsh', 'runtime-next'),
  join(homedir(), '.dsh', 'runtime'),
].filter((dir): dir is string => dir !== undefined && dir !== '')

/** 第一份版本对得上的运行时;一份都对不上时退回第一个候选(只为让跳过说明有个名字)。 */
export const RUNTIME: string = CANDIDATES.find(dir => dshVersionAt(dir) === LOCKED_DSH_VERSION) ?? CANDIDATES[0]!
/** 那份运行时里装的 dsh 版本(读不到就是 undefined)。 */
export const INSTALLED = dshVersionAt(RUNTIME)
/** 只有真的 0.1.7 才验得了「补丁层这一代」。版本不对就跳过,别假装验过。 */
export const READY = INSTALLED === LOCKED_DSH_VERSION
export const WHY_SKIPPED = `${CANDIDATES.join(' / ')} 里没有 ${LOCKED_DSH_VERSION}`
  + `(读到的是 ${CANDIDATES.map(dir => dshVersionAt(dir) ?? '没有').join(' / ')})`

/** 跑 dsh 用的 node:优先自有那一条(与 dsh-start 同一条),没有就用跑测试这条。 */
const OWN_NODE = join(homedir(), '.dsh', 'node', 'bin', 'node')
export const NODE = existsSync(OWN_NODE) ? OWN_NODE : process.execPath

/** 灰度纪律里那个「非 8791」。`--dump-config` 不监听,这只是保险。 */
const HARMLESS_WORKBENCH_PORT = '8799'

export interface DumpedConfig {
  /** stdout:合出来的整棵 profile(YAML 文本)。 */
  readonly config: string
  /** stderr:dsh 自己对补丁的抱怨(`patch: entry "…" not found` 之类)。 */
  readonly warnings: string
}

/**
 * 起真的 dsh 把整棵 profile 合出来。**不 listen、不 mount、不碰生产**。
 * `runtimeDir` 通常传 scratch 机器里那个指向真运行时的符号链接(与 dsh-start 起服务时同一个 cwd)。
 */
export function dumpConfig(dshHome: string, runtimeDir: string = RUNTIME): DumpedConfig {
  const run = spawnSync(
    NODE,
    [join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--dump-config'],
    {
      cwd: runtimeDir,
      env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', WORKBENCH_PORT: HARMLESS_WORKBENCH_PORT },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  if (run.status !== 0) throw new Error(`dsh --dump-config 退了 ${String(run.status)}:${run.stderr}`)
  return { config: run.stdout, warnings: run.stderr }
}

/**
 * 一份 YAML 组合(合成结果,或上游 / 我们的 patch 文件)里 `- id: <id>` 那一行之后、
 * 下一个 `- id:` 之前的正文。不引 yaml 依赖:只要认出「这一行的 config / disabled 写了什么」。
 * 对 group 行它只到第一个子项为止 —— 我们碰的几行都不是 group。
 */
export function dumpedRow(text: string, id: string): string | undefined {
  const heads = [...text.matchAll(/^[ \t]*- id: (\S+)[ \t]*$/gm)]
  const i = heads.findIndex(head => head[1] === id)
  if (i < 0) return undefined
  const head = heads[i]!
  const start = head.index + head[0].length
  const end = heads[i + 1]?.index ?? text.length
  return text.slice(start, end)
}

/** 一段行正文里 `config:` 之下的键名(只看一层)。 */
export function configKeysOf(rowBody: string): string[] {
  const at = rowBody.indexOf('config:')
  if (at < 0) return []
  return [...rowBody.slice(at + 'config:'.length).matchAll(/^[ \t]+([A-Za-z_][\w-]*):/gm)].map(m => m[1]!)
}
