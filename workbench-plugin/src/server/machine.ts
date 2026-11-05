/**
 * 机器信号采样(spec §6):磁盘/内存/CPU 空闲率,给工作台顶部一条"这台机器还好吗"。
 *
 * 纪律(D13):三条命令(`df` / `top` / `sysctl`)任一失败或解析不出来,直接 `{ error }`,
 * 绝不拿上一次的数字顶替、绝不编一个"看起来合理"的值——错的数字比没有数字更害人。
 *
 * 请求驱动 + 最短间隔缓存:GET /state 每次都可能触发一次采样，但这三条命令加起来
 * 有实打实的进程开销，且机器状态一两秒内不会有意义地变化。缺省 60 秒内直接回缓存，
 * 不额外起 setInterval——采样只在有人真的来问的时候才发生。
 */
import type { WorkbenchState } from '../protocol.ts'
import { createSampleCache } from './sampleCache.ts'

export type RunCommand = (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>

/**
 * 解析 `df -k <mount>` 的输出。
 *
 * 样例(本机实测,2026-08-20):
 * ```
 * Filesystem   1024-blocks      Used Available Capacity iused    ifree %iused  Mounted on
 * /dev/disk3s5   482797652 438698808   8080660    99% 4199019 80806600    5%   /System/Volumes/Data
 * ```
 * 不能死认「第二行是数据行、第 4/5 列是 Available/Capacity」：设备名一长，`df` 会把它
 * 单独占一行，数值挪到下一行开头，列下标全部错位。改成从整段输出的**末尾**倒着找——
 * 不管设备名占几行，输出收尾的形状永远是固定的六个字段：
 * `Available Capacity% iused ifree %iused Mounted-on`，用一条锚在字符串末尾的正则整段匹配，
 * 折不折行都取得到同样的 Available/Capacity。
 */
export function parseDf(out: string): { pct: number, free_gb: number } {
  const trimmed = out.trim()
  if (trimmed === '') throw new Error('df 输出为空')

  // 折成一整行再匹配：折行只是任意位置多插了几个换行，不影响"从后往前数"这六个字段的相对顺序。
  const flat = trimmed.replace(/\n/g, ' ')
  const match = /(\d+)\s+(\d+)%\s+\d+\s+\d+\s+\d+%\s+\S+$/.exec(flat)
  if (match === null) throw new Error(`df 输出解析失败：${out}`)

  const availableKb = Number(match[1])
  const pct = Number(match[2])
  if (!Number.isFinite(availableKb) || !Number.isFinite(pct)) {
    throw new Error(`df 输出解析失败：${out}`)
  }
  return { pct, free_gb: availableKb / 1024 / 1024 }
}

/** `top -l 1 -n 0` 输出里揪出 "NN.NN% idle"。找不到就是解析失败，不猜。 */
function parseCpuIdle(out: string): number {
  const match = /([\d.]+)%\s*idle/i.exec(out)
  if (match === null) throw new Error(`top 输出解析失败：${out}`)
  const idle = Number(match[1])
  if (!Number.isFinite(idle)) throw new Error(`top 输出解析失败：${out}`)
  return idle
}

/** `sysctl -n hw.memsize` 输出是纯字节数。 */
function parseMemBytes(out: string): number {
  const bytes = Number(out.trim())
  if (!Number.isFinite(bytes)) throw new Error(`sysctl 输出解析失败：${out}`)
  return bytes
}

async function sampleOnce(run: RunCommand, now: () => number): Promise<WorkbenchState['machine']> {
  const df = await run(['df', '-k', '/System/Volumes/Data'])
  if (!df.ok) return { error: 'df 失败' }
  let disk: { pct: number, free_gb: number }
  try {
    disk = parseDf(df.stdout)
  }
  catch {
    return { error: 'df 输出解析失败' }
  }

  const top = await run(['top', '-l', '1', '-n', '0'])
  if (!top.ok) return { error: 'top 失败' }
  let cpuIdle: number
  try {
    cpuIdle = parseCpuIdle(top.stdout)
  }
  catch {
    return { error: 'top 输出解析失败' }
  }

  const sysctl = await run(['sysctl', '-n', 'hw.memsize'])
  if (!sysctl.ok) return { error: 'sysctl 失败' }
  let memBytes: number
  try {
    memBytes = parseMemBytes(sysctl.stdout)
  }
  catch {
    return { error: 'sysctl 输出解析失败' }
  }

  return {
    disk_pct: disk.pct,
    disk_free_gb: disk.free_gb,
    mem_gb: memBytes / 1024 / 1024 / 1024,
    cpu_idle_pct: cpuIdle,
    sampled_at: new Date(now() * 1000).toISOString(),
  }
}

/**
 * 造一个"采一次"函数，内置最短间隔缓存(默认 60 秒)。
 * 不管上次采到的是正常值还是 `{ error }`，缓存都原样重放——错误结果同样不该在
 * 缓存窗口内被下一次请求重新触发一轮进程开销。
 *
 * single-flight（2026-08-21 真机实测补的）：缓存只在"采完之后"才写入，冷启动时
 * 展示台按 1 秒轮询 `GET /state`，重启后第一秒内的好几个并发请求会各自发现缓存是空的、
 * 各自起一轮 `df`/`top`/`sysctl`——实测重启后首个 `/state` 超过 5 秒才响应，就是这类
 * sampler 叠起来的并发风暴。这里把"正在进行的那次采样"存成一个共享 promise，
 * 后来的并发调用者拿同一个 promise 等，而不是各自再起一轮进程。
 *
 * 过期了先回上一份、后台补采,不让碰上的那一拍 `/state` 干等(2026-10-21;三格同一份,见 sampleCache.ts)。
 */
export function createMachineSampler(
  run: RunCommand,
  now: () => number,
  minIntervalSec = 60,
): () => Promise<WorkbenchState['machine']> {
  return createSampleCache(() => sampleOnce(run, now), now, minIntervalSec)
}
