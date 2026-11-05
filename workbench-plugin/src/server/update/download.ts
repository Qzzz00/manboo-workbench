/**
 * 下一件产物并核对 sha256(2026-09-18)。
 *
 * 三条:
 *
 * 1. **断点续传**。第一趟用 `curl -C -`(接着上次下到的地方)。通道层工人那个包
 *    三百多兆,在国内的网上一趟下完是运气不是常态 —— 断了再点一次「立即更新」要能接上,
 *    而不是从零再来。落脚点在 `~/.dsh/updates/<版本>/` 而不是临时目录,正是为了这个。
 * 2. **已经下好过就不再下**。进来先看一眼本地那份的 sha256 对不对,对就直接用。
 *    这让整条 apply 天然幂等:失败重试只补没下完的那几样。
 * 3. **校验不过就删掉重下一次,再不过就认输**。续传最容易出的错就是"接在一段坏字节后面",
 *    所以第二趟是**从零下**(不带 `-C -`)。两趟都不过就抛人话 —— 不留一个校验不过的包
 *    在那儿等着下次被当成"已经下好了"。
 */
import type { SetupIo } from '../setup/io.ts'
import { tailLines } from '../setup/io.ts'
import type { UpdateAsset } from './types.ts'

/** 一次下载的结果。`reused` = 本地那份本来就对,这一趟一个字节都没走网。 */
export interface DownloadOutcome {
  path: string
  reused: boolean
}

export class UpdateDownloadError extends Error {}

export interface DownloadDeps {
  io: SetupIo
  log: (line: string) => void
  /** 一趟下载给多久。工人包三百多兆,给足。 */
  timeoutMs: number
  /**
   * 下着的时候,每隔一会儿报一次「这个文件现在多大了」(2026-09-18)。
   *
   * 为什么是 stat 半成品文件、而不是解析 curl 的进度条:`io.exec` 只按**行**回调,
   * 而 curl 的进度条是用 `\r` 原地刷的 —— 一整趟下载在它那儿可能一行都不换。
   * 文件多大是**磁盘上的事实**,比解析一段会变的输出可靠得多。
   */
  onProgress?: (bytesOnDisk: number) => void
  /** 多久 stat 一次。缺省 500ms;测试传 0 = 不起定时器。 */
  progressPollMs?: number
}

/** 下载进度多久看一次。半秒:界面本来就一秒一问,再密也传不出去。 */
const DEFAULT_PROGRESS_POLL_MS = 500

/** 算一个文件的 sha256。算不出来(文件不在、shasum 没跑成)回 undefined —— 不猜。 */
export async function sha256Of(io: SetupIo, path: string): Promise<string | undefined> {
  const info = await io.stat(path)
  if (info === undefined || !info.isFile) return undefined
  const result = await io.exec(['shasum', '-a', '256', path])
  if (!result.ok) return undefined
  const got = (result.out.trim().split(/\s+/)[0] ?? '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(got) ? got : undefined
}

async function curl(deps: DownloadDeps, asset: UpdateAsset, dest: string, resume: boolean): Promise<{ ok: boolean, code: number }> {
  const cmd = [
    'curl', '-fL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20',
    ...(resume ? ['-C', '-'] : []),
    '-o', dest, asset.url,
  ]
  deps.log(`$ ${cmd.join(' ')}`)
  const stop = watchSize(deps, dest)
  try {
    const result = await deps.io.exec(cmd, { timeoutMs: deps.timeoutMs, onLine: line => deps.log(line) })
    return { ok: result.ok, code: result.code }
  }
  finally { stop() }
}

/** 下着的时候盯着那个半成品文件有多大。回一个"别盯了"。 */
function watchSize(deps: DownloadDeps, dest: string): () => void {
  const pollMs = deps.progressPollMs ?? DEFAULT_PROGRESS_POLL_MS
  const report = deps.onProgress
  if (report === undefined || pollMs <= 0) return () => {}
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void deps.io.stat(dest)
      // 文件还没建出来(curl 刚起)很正常,那就是 0 —— 不是错误,也不该打日志。
      .then(info => { report(info?.size ?? 0) })
      .catch(() => {})
      .finally(() => { busy = false })
  }, pollMs)
  timer.unref?.()
  return () => { clearInterval(timer) }
}

/**
 * 下一件产物到 `dest`,下完核对 sha256。
 *
 * 失败一律抛 `UpdateDownloadError`,message 是给 Ben 看的人话。
 */
export async function downloadAsset(deps: DownloadDeps, asset: UpdateAsset, dest: string, title: string): Promise<DownloadOutcome> {
  // ① 本地那份本来就对:直接用(整条 apply 的幂等就靠这一条)。
  if (await sha256Of(deps.io, dest) === asset.sha256) {
    deps.log(`已经下好过,校验也对得上,不重下:${dest}`)
    // 报一次满格:上一趟断在半路、这一趟直接命中的时候,进度条不该停在上次那个数上。
    deps.onProgress?.(asset.size)
    return { path: dest, reused: true }
  }

  // ② 第一趟:断点续传。
  const first = await curl(deps, asset, dest, true)
  let got = first.ok ? await sha256Of(deps.io, dest) : undefined
  if (got === asset.sha256) return { path: dest, reused: false }

  // ③ 续传接在坏字节后面是最常见的一种错法,所以第二趟从零下。
  if (first.ok) deps.log(`${title}:下下来的字节跟清单里的 sha256 对不上(${got ?? '算不出来'}),多半是上次断在半路。删掉重下一趟。`)
  else deps.log(`${title}:第一趟没下成(curl 退出码 ${first.code}),重下一趟。`)
  await deps.io.rmrf(dest)
  const second = await curl(deps, asset, dest, false)
  if (!second.ok) {
    await deps.io.rmrf(dest)
    throw new UpdateDownloadError(`「${title}」没下下来(curl 退出码 ${second.code})。多半是这会儿没网。连上网之后点「重试」,已经下好的那几样不会重下。`)
  }
  got = await sha256Of(deps.io, dest)
  if (got !== asset.sha256) {
    // 对不上的包一律不留 —— 留着下次会被第 ① 条当成"已经下好了"。
    await deps.io.rmrf(dest)
    throw new UpdateDownloadError(`「${title}」下下来了,但跟清单里锁着的校验和对不上(算出来是 ${got ?? '算不出来'},要的是 ${asset.sha256})。这个包不能装。点「重试」会重新下一份。`)
  }
  return { path: dest, reused: false }
}

/** 把一段命令输出的尾巴塞进作业里(与登录台同一个口径:尾 20 行)。 */
export function tailOf(text: string): readonly string[] {
  return tailLines(text)
}
