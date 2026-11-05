/**
 * 压测时塞进工人进程的一只「听诊器」(`node --import ./dev/load-diag-preload.mjs src/main.ts`)。
 *
 * 只给 dev/load-call.ts 用:它**不改工人的一行代码**,改前改后两组数就是同一只听诊器量的。
 * 每秒往 stdout 打一行 `[load-diag] {...}`:
 *   - `lag_max_ms` / `lag_p99_ms`:这一秒里事件循环最长卡了多久(perf_hooks 的直方图);
 *   - `cpu_ms`:这一秒工人自己真正吃到的 CPU(用户态 + 内核态);
 *   - `majflt`:这一秒的换页(从 swap / 压缩区读回来的那种 —— 内存被挤出去的直接证据);
 *   - `ivcsw`:这一秒被别人抢走 CPU 的次数(非自愿上下文切换 —— CPU 被挤的直接证据);
 *   - `gap_ms`:两次打点之间的墙钟间隔,理应是 1000;远大于 1000 就说明**整个进程**都没被调度。
 *   - `vad_runs`:这一秒 Silero VAD 真跑了几次推理(2026-09-25,卡 fix/evening-gaps:「挂断之后工人还在不在跑 VAD」
 *     要一个不经工人自己日志的数 —— 在 onnxruntime 的 `InferenceSession.run` 上数,工人一行不改)。
 *     数不到(装法不一样、找不到 onnxruntime)这一格就缺席,不编 0。
 *
 * 不读、不写任何文件;不连网。
 */
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 10 })
histogram.enable()

/**
 * VAD 推理计数。Silero 插件是 ESM,`import { InferenceSession } from "onnxruntime-node"` 拿到的是
 * onnxruntime-node 的 CJS 出口(同一个模块实例),所以在这里从插件的位置 require 一次、改原型上的 `run`,
 * 插件里那一份也就跟着数了。任何一步不成都不影响工人:只是没有这一格。
 */
let vadRuns = 0
let vadCounting = false
try {
  const here = createRequire(import.meta.url)
  const sileroEntry = here.resolve('@livekit/agents-plugin-silero')
  const ort = createRequire(sileroEntry)('onnxruntime-node')
  const proto = ort?.InferenceSession?.prototype
  if (proto !== undefined && typeof proto.run === 'function') {
    const original = proto.run
    proto.run = function countedRun(...args) {
      vadRuns += 1
      return original.apply(this, args)
    }
    vadCounting = true
  }
}
catch { /* 数不到就不数 */ }

let lastUsage = process.resourceUsage()
let lastAt = Date.now()

const timer = setInterval(() => {
  const now = Date.now()
  const usage = process.resourceUsage()
  const line = {
    at: now,
    gap_ms: now - lastAt,
    lag_max_ms: Math.round(histogram.max / 1e6),
    lag_p99_ms: Math.round(histogram.percentile(99) / 1e6),
    cpu_ms: Math.round((usage.userCPUTime - lastUsage.userCPUTime + usage.systemCPUTime - lastUsage.systemCPUTime) / 1000),
    majflt: usage.majorPageFault - lastUsage.majorPageFault,
    ivcsw: usage.involuntaryContextSwitches - lastUsage.involuntaryContextSwitches,
    rss_mb: Math.round(process.memoryUsage.rss() / 1048576),
    ...(vadCounting ? { vad_runs: vadRuns } : {}),
  }
  vadRuns = 0
  histogram.reset()
  lastUsage = usage
  lastAt = now
  process.stdout.write(`[load-diag] ${JSON.stringify(line)}\n`)
}, 1000)
timer.unref()
