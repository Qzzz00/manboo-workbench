/**
 * 爆款拆解 ③ 的 I/O 编排(2026-09-22):下视频 → 本机转写 → 抽帧 → 交模型出内容框架。
 *
 * 纯文本那一半在 `xhsBreakdownText.ts`(SRT、提示词、产物版式,**C6 的时间戳在那里**)。
 * 这个文件只管四件带 I/O 的事,每一件都能被替换成桩:下载、跑 ffmpeg、跑 whisper.cpp、调模型。
 *
 * ## ★ 视频怎么下(预研留的那个问题,这一版给的答案)
 *
 * 预研实验二实测:**yt-dlp 匿名下不了** —— 因为它连笔记页都打不开(300031 那道闸)。
 * 这一版走的是另一条:**页面已经由他自己的登录态打开过了**,视频直链
 * (`note.video.media.stream[].masterUrl`)就在那一页的数据里,②已经采下来了。
 * 这里**只用一个普通 HTTP GET 去拿那个直链**,带 `Referer`,**不带任何 cookie**。
 *
 * 为什么不喂 cookie 给 yt-dlp:喂 cookie 就必须把 cookie 写进一个文件,
 * 那**直接破掉红线第 5 条**(一个凭据都不取)。我们自己下,登录态一步都没离开 Chrome 档案。
 *
 * ⚠️ **还没在真链接上验证过**:预研没能确认 `sns-video-bd.xhscdn.com` 这类 CDN 直链
 * 到底要不要带登录态。所以 {@link downloadVideo} 的失败分支写的是**如实说**
 * ——「直链拿不到(HTTP 403),说明这个 CDN 也要登录态,这条路这一版走不通」——
 * 而不是偷偷退回去找别的办法。Ben 登录后给一条链接就能验出来,交接第五节写了怎么验。
 *
 * ## whisper.cpp 与 ffmpeg 怎么来(用户不走命令行)
 *
 * 记忆「用户环节不走命令行」:Ben 验收也按普通用户算。所以:
 * - **ffmpeg**:这台机器上 `brew` 装过(`/opt/homebrew/bin/ffmpeg`,8.1.2)。
 *   找不到时**如实说**,并说清楚工作台会在哪儿找它 —— 不弹一句 `brew install`。
 * - **whisper.cpp**:这一版**不自带二进制**(打包是另一张卡的事,交接第七节写了)。
 *   找不到 `whisper-cli` 就整块如实缺席。
 * - **模型**:`~/.dsh/workbench/models/ggml-<档>.bin`,不在就下,**下的时候报进度**
 *   (`base` 约 147 MB,`small` 约 488 MB;第一次要等,这件事必须在界面上说清楚,
 *   不能让他对着一个转圈干等)。
 *
 * ## 繁 → 简(2026-09-21 加的一步)
 *
 * whisper.cpp 转中文时**出来是繁体还是简体是它自己挑的**,命令行参数按不住
 * (真跑全表在 `zhSimplify.ts` 文件头与 `docs/交接-0922-转写简繁.md`)。
 * 所以转写的参数一个字都没改,出来之后量一遍:**整份**繁体字过 10% 那条线才转,
 * 不到线一个字都不动(夹在里面的繁体专名是内容本身)。转了记一行,转没转都写在逐字稿头上。
 * **会议模式那一条不受影响** —— 它走火山 8792 `/api/asr`,真跑出来就是简体(同一段音频对比过)。
 *
 * ## 图文笔记
 *
 * 没有视频就没有转写,所以这一支只有一步:标题 + 短文案 + 标签 → 模型 → 内容框架。
 * C6 那个「每段带时间戳」在这里落成**「图 N」**(`xhsBreakdownText.imageStamps`):
 * 作用一样 —— 他能照着回去看原帖第几张图。
 *
 * ⚠️ **模型没有看见图本身。** 任务书写的是「图文笔记走图片直接交视觉模型(能用就用,不能用写清)」,
 * 这一版是**不能用**:我们现在这条模型通道(`modelService` → 中转)只收文字,
 * 把图片喂进去要换一条能收图的通道,那是另一张卡。
 * 所以提示词里逐字写着「你没看见图,凡是要看图才说得出来的一个字都别写」,
 * 产物头上也逐字写着同一句 —— **不假装模型看过图**。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { lowPriorityCommand } from './lowPriority.ts'
import {
  BREAKDOWN_FILE_NAME, TRANSCRIPT_FILE_NAME, type CollectedNote,
} from './xhsNoteText.ts'
import {
  allowedStamps, buildFrameworkPrompt, frameTimes, imageStamps, parseFrameworkReply, parseSrt,
  renderBreakdownMd, renderTranscriptMd, type TranscriptCue,
} from './xhsBreakdownText.ts'
import { simplifyCues, simplifyLogLine } from './zhSimplify.ts'

/** 模型放哪。任务书写死。 */
export function modelsDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/models`
}

/** 转写用哪一档。`base` 快、`small` 准一点;默认 `base`(预研实验七在 M3 上 ≈3.8x 实时)。 */
export type AsrModel = 'base' | 'small'

/** 模型从哪下。whisper.cpp 官方在 Hugging Face 上的那一份。 */
export const MODEL_URLS: Readonly<Record<AsrModel, string>> = {
  base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
}

/** 大概多大(给界面上那句「第一次要等」用的,**不是校验值**)。 */
export const MODEL_SIZE_HINT: Readonly<Record<AsrModel, string>> = { base: '约 147 MB', small: '约 488 MB' }

export const NO_FFMPEG = '这台机器上找不到 ffmpeg —— 视频转音频、抽帧都要它,这一条拆不了。'
export const NO_WHISPER = '这台机器上找不到 whisper.cpp 的 whisper-cli —— 本机转写要它,这一条拆不了。'
export const NO_VIDEO = '这条笔记里没有视频(图文笔记走的是另一条:把图与文案交给模型)。'

/** 跑一个外部命令,把 stdout 收回来。失败抛人话。 */
export type RunCmd = (file: string, args: readonly string[], timeoutMs?: number) => Promise<string>

export const runCmd: RunCmd = async (file, args, timeoutMs = 20 * 60 * 1000) =>
  await new Promise<string>((resolve, reject) => {
    // ffmpeg 抽帧、whisper 本机转写都是重活:降一档跑,别和电话抢 CPU(2026-09-25,见 lowPriority.ts)。
    const command = lowPriorityCommand(file, args)
    const child = spawn(command.file, command.args)
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${file} 跑了太久,停了`)) }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${file} 回了 ${code}${err.trim() === '' ? '' : `:${err.trim().split('\n').slice(-3).join(' ')}`}`))
    })
  })

/** 这台机器上有没有这个命令。`which` 找不到就回 undefined,**不猜一个路径**。 */
export async function findTool(name: string, run: RunCmd = runCmd): Promise<string | undefined> {
  // 常见落点先看一眼(launchd 起的进程 PATH 很短,`which` 常常找不到 brew 的东西)。
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) {
    try { if ((await stat(candidate)).isFile()) return candidate }
    catch { /* 不在就看下一个 */ }
  }
  try {
    const out = (await run('/usr/bin/which', [name], 5_000)).trim().split('\n')[0] ?? ''
    return out === '' ? undefined : out
  }
  catch { return undefined }
}

export interface BreakdownTools {
  ffmpeg?: string
  whisper?: string
  /** 模型文件在不在。 */
  modelFile?: string
}

/** 这一块能不能用,一句人话。**缺什么说什么**,不说「不可用」。 */
export function toolsNote(tools: BreakdownTools, model: AsrModel): string {
  const missing: string[] = []
  if (tools.ffmpeg === undefined) missing.push('ffmpeg(视频转音频、抽帧)')
  if (tools.whisper === undefined) missing.push('whisper.cpp 的 whisper-cli(本机转写)')
  if (missing.length > 0) {
    return `爆款拆解还差:${missing.join('、')}。这一版工作台还不会自己下它们(下一张卡的事),`
      + '所以这一条现在拆不了 —— 采集那两项不受影响。'
  }
  if (tools.modelFile === undefined) {
    return `转写模型(${model},${MODEL_SIZE_HINT[model]})还没下。第一次拆解会先下它,网慢的话要等一会儿 —— 界面上会报进度。`
  }
  return '爆款拆解可以用:视频转音频、转写、抽帧全在你这台电脑上跑,素材一个字节都不上传。'
}

export interface BreakdownDeps {
  home: string
  run?: RunCmd
  /** 下一个文件(模型 / 视频)。抽出来是为了用例不走网。 */
  fetchTo?: (url: string, dest: string, headers: Record<string, string>, onProgress?: (bytes: number) => void) => Promise<void>
  chat?: (prompt: string) => Promise<string>
  model?: AsrModel
  /**
   * 「这台机器上有没有这个命令」。缺省走 {@link findTool}(它会去看 brew 的那几个落点)。
   *
   * 抽成参数是因为用例必须能演"这台机器上**没有** ffmpeg" —— 而开发机上它是装着的,
   * 直接调 `findTool` 会让「缺 ffmpeg 就停下」那条用例在这台机器上永远测不到想测的分支
   * (它会一路跑下去,最后死在别的地方,看起来还是绿的/红得莫名其妙)。
   */
  find?: (name: string) => Promise<string | undefined>
  /** 进度播报(界面上那句「正在…」)。 */
  onStep?: (line: string) => void
  now?: () => number
}

/** 用 curl 下(与 update/download.ts 同一条路数:断点续传、进度看磁盘上那个半成品有多大)。 */
export async function curlTo(
  url: string,
  dest: string,
  headers: Record<string, string>,
  onProgress?: (bytes: number) => void,
  run: RunCmd = runCmd,
): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true })
  const args = ['-fL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '-C', '-']
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  args.push('-o', dest, url)
  let timer: NodeJS.Timeout | undefined
  if (onProgress !== undefined) {
    timer = setInterval(() => {
      void stat(dest).then(info => { onProgress(info.size) }).catch(() => { /* 还没开始写 */ })
    }, 500)
  }
  try { await run('/usr/bin/curl', args, 30 * 60 * 1000) }
  finally { if (timer !== undefined) clearInterval(timer) }
}

export interface BreakdownResult {
  ok: boolean
  message: string
  file?: string
}

/**
 * 拆一条。**每一步失败都如实说、当场停**,不换一条路再试。
 *
 * @param dir ②采集时那条笔记的文件夹(`<工作目录>/采集/<日期-标题>/`)。产物落在同一个文件夹里。
 */
export async function runBreakdown(
  note: CollectedNote,
  dir: string,
  url: string,
  deps: BreakdownDeps,
): Promise<BreakdownResult> {
  const run = deps.run ?? runCmd
  const fetchTo = deps.fetchTo ?? ((u, d, h, p) => curlTo(u, d, h, p, run))
  const model: AsrModel = deps.model ?? 'base'
  const step = deps.onStep ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const at = new Date(now()).toISOString()

  const chat = deps.chat
  if (chat === undefined) return { ok: false, message: '模型服务还没接上,出不了内容框架。' }

  // ── 图文笔记:没有视频,没有转写。位置换成「图 N」,其余一条路走到底 ──
  if (note.video === undefined) {
    if (note.images.length === 0) return { ok: false, message: NO_VIDEO }
    step('这是图文笔记:没有语音可转,直接把标题、短文案、标签交给模型')
    const stamps = imageStamps(note.images.length)
    let reply: string
    try {
      reply = await chat(buildFrameworkPrompt({
        ...(note.title === undefined ? {} : { title: note.title }),
        ...(note.desc === undefined ? {} : { desc: note.desc }),
        tags: note.tags, cues: [], frames: [], images: note.images.length,
      }))
    }
    catch (error) { return { ok: false, message: `模型没回话:${error instanceof Error ? error.message : '不知道为什么'}` } }

    const picked = parseFrameworkReply(reply, stamps)
    if (picked.length === 0) {
      return { ok: false, message: '模型回的内容一条都对不上这条笔记的图序号 —— 对不上的我不写进产物。' }
    }
    const target = join(dir, BREAKDOWN_FILE_NAME)
    await writeFile(target, renderBreakdownMd(picked, [], {
      at, url,
      ...(note.title === undefined ? {} : { title: note.title }),
      asr_model: '(图文笔记,没有转写)',
      frames: note.images.length,
      images_only: true,
    }), 'utf8')
    return { ok: true, message: `拆好了(图文笔记),落在 ${target}`, file: target }
  }

  const find = deps.find ?? (async (name: string) => await findTool(name, run))
  const ffmpegPath = await find('ffmpeg')
  const whisperPath = await find('whisper-cli')
  if (ffmpegPath === undefined) return { ok: false, message: NO_FFMPEG }
  if (whisperPath === undefined) return { ok: false, message: NO_WHISPER }

  // ── 模型:不在就下,下的时候报进度 ──
  const modelFile = join(modelsDir(deps.home), `ggml-${model}.bin`)
  let haveModel = false
  try { haveModel = (await stat(modelFile)).size > 1_000_000 }
  catch { haveModel = false }
  if (!haveModel) {
    step(`第一次用:要先下转写模型(${model},${MODEL_SIZE_HINT[model]})。网慢的话要等一会儿。`)
    try {
      await fetchTo(MODEL_URLS[model], modelFile, {}, bytes => {
        step(`转写模型下到 ${(bytes / 1024 / 1024).toFixed(0)} MB…`)
      })
    }
    catch (error) {
      return { ok: false, message: `转写模型没下下来:${error instanceof Error ? error.message : '不知道为什么'}` }
    }
  }

  // ── 下视频 ──
  const videoFile = join(dir, '原视频.mp4')
  step('下原视频(用你自己那条页面上给的直链,不带任何 cookie)')
  try {
    await fetchTo(note.video.url, videoFile, {
      Referer: url,
      'User-Agent': 'Mozilla/5.0',
    })
  }
  catch (error) {
    const said = error instanceof Error ? error.message : '不知道为什么'
    return {
      ok: false,
      message: `视频直链下不下来(${said})。如果是 403,说明那个 CDN 也认登录态,`
        + '这一条这一版就走不通 —— 我不会拿 cookie 去换,那是我们明说过不做的事。',
    }
  }

  // ── 转音频 ──
  const wavFile = join(dir, '音轨.wav')
  step('把音轨扒出来(16 kHz 单声道)')
  try { await run(ffmpegPath, ['-y', '-v', 'error', '-i', videoFile, '-ar', '16000', '-ac', '1', wavFile]) }
  catch (error) { return { ok: false, message: `音轨扒不出来:${error instanceof Error ? error.message : '不知道为什么'}` } }

  // ── 转写 ──
  step('本机转写(whisper.cpp,走 Metal;音频一个字节都不上传)')
  const srtBase = join(dir, '字幕')
  try {
    await run(whisperPath, [
      '-m', modelFile, '-f', wavFile, '-l', 'zh', '-osrt', '-of', srtBase, '-ml', '40', '-np',
    ])
  }
  catch (error) { return { ok: false, message: `转写没跑成:${error instanceof Error ? error.message : '不知道为什么'}` } }

  let cues: TranscriptCue[] = []
  try { cues = parseSrt(await readFile(`${srtBase}.srt`, 'utf8')) }
  catch { cues = [] }
  // ★ 转写为空就不拼提示词、不调模型 —— 那样出来的"内容框架"是纯编的。
  if (cues.length === 0) {
    return { ok: false, message: '转写出来一句话都没有(可能这条视频没有人声)。没有逐字稿就没有时间戳,我不给一份编的框架。' }
  }

  // ── 繁 → 简(2026-09-21)──
  // whisper.cpp 转中文时字形是它自己挑的,参数按不住(试过的全表在 zhSimplify.ts 文件头)。
  // 所以在这里量一下:**整份**繁体字过线才转,不到线一个字都不动(夹着的繁体专名是内容本身)。
  // 转了记一行,不转不吵 —— 转没转都写在逐字稿头上。
  const simplified = simplifyCues(cues)
  if (simplified.converted) step(simplifyLogLine(simplified.measure))
  cues = simplified.cues

  const durationSec = note.video.ms !== undefined ? note.video.ms / 1000 : (cues.at(-1)?.end ?? 0)
  await writeFile(
    join(dir, TRANSCRIPT_FILE_NAME),
    renderTranscriptMd(cues, {
      at,
      url,
      model: `ggml-${model}`,
      simplify: { converted: simplified.converted, measure: simplified.measure },
    }),
    'utf8',
  )

  // ── 抽帧 ──
  const times = frameTimes(durationSec)
  step(`抽 ${times.length} 帧画面`)
  const framesDir = join(dir, '关键帧')
  await mkdir(framesDir, { recursive: true })
  let frames = 0
  for (const [index, second] of times.entries()) {
    try {
      await run(ffmpegPath, [
        '-y', '-v', 'error', '-ss', String(second), '-i', videoFile,
        '-frames:v', '1', join(framesDir, `${String(index + 1).padStart(2, '0')}-${second}s.jpg`),
      ], 60_000)
      frames++
    }
    catch { /* 某一帧抽不出来不该毁掉整条;少几帧如实记在产物头上 */ }
  }

  // ── 交模型 ──
  step('交给事务官那家模型,出内容框架')
  let reply: string
  try {
    reply = await chat(buildFrameworkPrompt({
      ...(note.title === undefined ? {} : { title: note.title }),
      ...(note.desc === undefined ? {} : { desc: note.desc }),
      tags: note.tags, cues, frames: times,
    }))
  }
  catch (error) { return { ok: false, message: `模型没回话:${error instanceof Error ? error.message : '不知道为什么'}` } }

  const items = parseFrameworkReply(reply, allowedStamps(cues))
  if (items.length === 0) {
    return {
      ok: false,
      message: '模型回的内容一条都对不上逐字稿里的时间点 —— 对不上的我不写进产物。'
        + `逐字稿已经落在 ${join(dir, TRANSCRIPT_FILE_NAME)},可以先看那份。`,
    }
  }

  const out = join(dir, BREAKDOWN_FILE_NAME)
  await writeFile(out, renderBreakdownMd(items, cues, {
    at, url,
    ...(note.title === undefined ? {} : { title: note.title }),
    asr_model: `ggml-${model}`,
    duration: durationSec,
    frames,
  }), 'utf8')

  // 中间产物里最大的那个音轨删掉(视频与帧留着 —— 他要回去核对原片)。
  await rm(wavFile, { force: true })
  return { ok: true, message: `拆好了,落在 ${out}`, file: out }
}
