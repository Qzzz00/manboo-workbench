/**
 * 工作台自己起的**重活**降一档跑(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 维护者 09-24 晚走引导那一通,这台 Mac 上同时跑着重测试,工人抢不到 CPU,她半分钟不接话。
 * 中秋起他要边打电话边派活 —— 工作台自己起的重活(会议录音转码、小红书视频抽帧与本机转写)
 * 不该和通话抢。
 *
 * 用的是 macOS 自带的 `taskpolicy -c utility`:把这个进程**连同它以后起的所有子进程**的 QoS
 * 钳在 utility 档(调度优先级 20,工人是 31)。CPU 空着时它照样跑满,CPU 紧的时候先让通话。
 * **为什么不是 `nice`**:这张卡量过,`nice -n 15` 起的进程在 `ps` 里仍是 31 档,和工人一样抢;
 * 能真的让出去的是 `taskpolicy`(交接-0925-通话抗负载与名字 那张表)。
 * **为什么不是 `-b`(后台档)**:后台档只用能效核、磁盘 I/O 也降级,平时转一段视频会慢好几倍;
 * 那一档留给通话中的护栏(channel-worker/src/loadGuard.ts)临时用,挂断就还原。
 *
 * `taskpolicy` 就地 exec(pid 不变),所以按 pid 停、看退出码、收 stdout 都和原来一样。
 * 不是 macOS、或者这台上没有 `taskpolicy`,就原样起 —— 一个字都不变。
 */
import { existsSync } from 'node:fs'

/** macOS 自带的那一个。 */
export const TASKPOLICY_BIN = '/usr/sbin/taskpolicy'

export interface LowPriorityEnv {
  platform?: string
  exists?: (path: string) => boolean
}

/** `file args…` → `taskpolicy -c utility file args…`(macOS 上);别处原样。 */
export function lowPriorityCommand(file: string, args: readonly string[], env: LowPriorityEnv = {}): { file: string, args: string[] } {
  const platform = env.platform ?? process.platform
  const exists = env.exists ?? existsSync
  if (platform !== 'darwin' || !exists(TASKPOLICY_BIN)) return { file, args: [...args] }
  return { file: TASKPOLICY_BIN, args: ['-c', 'utility', file, ...args] }
}
