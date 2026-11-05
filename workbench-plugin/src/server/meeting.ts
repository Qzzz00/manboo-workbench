/**
 * 会议模式的服务端(2026-09-21)。Ben 原话:
 * 「手机上还有『会议模式』,开完会直接打通这套系统帮忙办事、梳理」。
 *
 * 一场会议走四步,每一步都在 `status` 上看得见:
 *
 * ```
 *  recording ──「结束」──▶ transcribing ──▶ summarizing ──▶ done
 *   手机在录        分段都上来了    火山转写       事务官梳理
 *                                    │              │
 *                                    └──── failed ◀──┘   原始录音一个都不删
 * ```
 *
 * ## 边界(任务书第 5 条,逐条在代码里的位置)
 *
 * 1. **录音文件不出这台电脑与手机**。分段从手机直接 POST 到 8791,落在
 *    `<工作目录>/会议/<日期-标题>/录音/`,**没有任何一条把它往外发的路**。
 *    这也正是**没有**用火山「录音文件识别」的原因,见下面那一节。
 * 2. **转写只经火山**。走的是本机 8792 的 `/api/asr`(它内部连火山的大模型流式识别 WS),
 *    这个文件里没有第二个识别供应商,一个都没有。
 * 3. **纪要里不编发言人**:没有说话人分离,所以一个「谁说的」都不标(meetingText.ts 守着)。
 * 4. **失败保留原始录音不删**:这里**没有任何一条能删掉会议文件的路**。文件里只有一处 `unlink`,
 *    删的是 afconvert 自己刚建的那个临时 wav(在系统临时目录里),源码扫描用例盯着这一条
 *    ——不是"界面上不放按钮",是**能力不存在**(同 inbox.ts 的纪律)。
 *
 * ## 为什么不用火山的「录音文件识别」(这条最可能被推翻,写清楚)
 *
 * 火山有两条现成的批量转写接口,两条都**只收一个可下载的 URL**:
 *   - 标准版 `POST /api/v3/auc/bigmodel/submit`,body 里 `audio.url` 必填;
 *   - 极速版 `POST /api/v1/auc/submit`,文档原话是「需提供可下载的音频文件地址」。
 * 也就是说要用它们,就得先把这场会的录音传到一个公网能下载的地方 —— 那与第 1 条边界
 * 直接冲突。所以这一版**按段喂流式那条**(8792 `/api/asr`,一段 ≤25 秒,按静音切,见 meetingText.ts 的 ASR_PIECE_MAX_SECONDS)。
 * 代价、限制与费用口径写在 `docs/交接-0921-会议模式.md` 第二节。
 * 哪天 Ben 说「录音可以上传到我们自己的服务器」,换成录音文件识别是一处改动:
 * 把 {@link MeetingServiceDeps.transcribe} 换掉,别处一行都不用动。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { lowPriorityCommand } from './lowPriority.ts'
import type { MeetingOutcomeView, MeetingStatus, MeetingTimelineMark, MeetingTodoView, MeetingView, MeetingsView } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import {
  ASR_SAMPLE_RATE,
  MEETINGS_DIR_NAME,
  NOTES_FILE_NAME,
  TRANSCRIPT_FILE_NAME,
  buildMeetingPrompt,
  encodeWav,
  meetingDirName,
  parseMeetingReply,
  renderImportedTranscriptMd,
  meetingDecisionsOf,
  renderNotesMd,
  renderTranscriptMd,
  safeMeetingTitle,
  segmentFileName,
  segmentMimeOfPath,
  splitPcmForAsr,
  timelineOf,
  transcriptBodyOf,
  type MeetingTodoDraft,
  type TranscriptLine,
} from './meetingText.ts'
import type { TasksService } from './tasks.ts'
import {
  MEETING_ORGANIZER_ASK,
  PREP_FILE_NAME,
  answerPrep,
  buildCardPrompt,
  cardStatusOf,
  draftMeetingPlan,
  fillFromRecords,
  nextPrepAsk,
  parseCardReply,
  prepViewOf,
  renderPrepMd,
  upsertPeople,
  type MeetingFact,
  type MeetingPeopleFile,
  type StoredMeetingPrep,
  type StoredPerson,
} from './meetingPrep.ts'
import type { MeetingPrepQuestionId } from '../protocol.ts'
import { MEETING_DEMO_CASES, MEETING_DEMO_FROM, type MeetingDemoCase } from './meetingDemoCases.ts'

/**
 * 做预案卡每天最多问几次模型(2026-10-10,花钱,**待拍板**)。一次约 3~5 千字进、1 千字出(V4 Flash,约 ¥0.005 一次),
 * 一天封顶约 ¥0.05。到了就不再问,画像照存,说清楚明天再做。
 */
export const MEETING_CARD_DAILY_CALLS = 10

/** 录音落在会议目录下面这个子目录里。和两份 markdown 分开,访达里一眼看得出哪个是证据。 */
export const RECORDINGS_DIR_NAME = '录音'

/** `/state.meetings.recent` 里最多几场。再往前的在硬盘上(会议目录一直都在),不在这份快照里。 */
export const MEETING_RECENT_MAX = 5

/** 一段录音最大多少字节。10 分钟的 m4a 大约 3~5MB;50MB 足够一段 10 分钟的 wav 兜底路。 */
export const MEETING_SEGMENT_MAX_BYTES = 50 * 1024 * 1024

/**
 * 导入一段转写最多多少字。
 *
 * 一小时的会转出来大约两三万字,这个数留了四倍余量;再大就不是「一场会的转写」了,
 * 而且它要整段进一次模型调用(V4 Flash 的上下文吃得下这个量)。到了上限当场拒,不截断 ——
 * 截一半出来的纪要看不出是截过的。
 */
export const MEETING_IMPORT_MAX_CHARS = 120_000

export interface StoredMeetingTodo extends MeetingTodoDraft {
  task_id?: string
}

/**
 * 一段录音。`lines` 是这一段**每一片都转成了**之后的结果(时间相对这一段开头)、`pcm_ms` 是它解出来的真实时长:
 * 「重新来」据此跳过已经转好的段,不再送识别(不重复花钱,也不会转出两份不一样的字)。
 * 有一片没转成就整段不记,重来时整段再送。
 */
export interface StoredMeetingSegment {
  seq: number
  file: string
  ms?: number
  lines?: TranscriptLine[]
  pcm_ms?: number
}

export interface StoredMeeting {
  id: string
  title: string
  date: string
  started_at: string
  ended_at?: string
  status: MeetingStatus
  dir: string
  segments: StoredMeetingSegment[]
  /** 手机给这场会编的号(2026-10-09):手机先录着、连上了才补开,重发 start 时据此认回同一场。 */
  client_key?: string
  /**
   * 从现成的转写**导入**出来的那一场(2026-10-13)。
   *
   * 这一场没有录音、也没有分段:转写在导入那一刻就落成 `转写.md`,整理只剩「问一次模型」那一步。
   * 「重新整理」时从盘上把 `转写.md` 读回来(索引里不存那一大段字),所以这一格只是个记号。
   */
  imported_text?: true
  /**
   * 演示用那几场(2026-10-13,`seedDemo`)。只做一个记号:界面上说一句「演示用」,
   * 别的一行代码都不为它分岔 —— 它走的就是真会那几条路。
   */
  demo?: true
  transcribed?: number
  seconds?: number
  /** 转写里的时间戳摆成的一条线(会中那一段;`timelineOf`)。转写没有时间戳就缺席。 */
  timeline?: readonly MeetingTimelineMark[]
  summary?: string
  todos: StoredMeetingTodo[]
  unsure: string[]
  error?: string
  /** 会前画像与预案卡(2026-10-10)。会前登记的那一场才有。 */
  prep?: StoredMeetingPrep
  /** 会后她回的「要定的定下来没有」。 */
  outcome?: MeetingOutcomeView
}

export interface MeetingsFile {
  version: 1
  meetings: StoredMeeting[]
  /** 今天做预案卡问了几次模型(按本地日期)。 */
  card_calls?: { day: string, n: number }
}

export function defaultMeetingsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/meetings.json`
}

function emptyMeetingsFile(): MeetingsFile { return { version: 1, meetings: [] } }

export async function loadMeetingsFile(file: string): Promise<MeetingsFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return emptyMeetingsFile() }
  try {
    const parsed = JSON.parse(text) as Partial<MeetingsFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.meetings)) return emptyMeetingsFile()
    return { version: 1, meetings: parsed.meetings, ...(parsed.card_calls === undefined ? {} : { card_calls: parsed.card_calls }) }
  }
  // 写坏了按空表兜底,不抛(先例 notes.ts / dock.ts)。**硬盘上的会议目录一个都没少**,
  // 丢掉的只是这份索引 —— 这正是两份 markdown 要落在工作目录里、而不是塞进 json 的理由。
  catch { return emptyMeetingsFile() }
}

export async function saveMeetingsFile(file: string, data: MeetingsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

/** 一段音频 → 16k/16bit/单声道 PCM。 */
export type DecodeAudio = (path: string) => Promise<Buffer>

export interface MeetingServiceDeps {
  /** `~/.dsh/workbench/meetings.json`。 */
  file: string
  /**
   * 工作目录(= 事务官仓库 = `butler_cwd`)。**没配就回 undefined**,
   * 这时整个会议模式用不了 —— 如实说一句,不猜一个路径(pathConfig.ts 的纪律)。
   */
  workdir: () => string | undefined
  /**
   * 一段 ≤25 秒的 WAV → 文字。生产接的是 8792 的 `/api/asr`(见 index.ts),
   * **用例里打桩**。没接就不转写,如实说。
   */
  transcribe?: (wav: Buffer) => Promise<string>
  /** 问一次模型(走 modelService 那家)。没接就只有转写、没有纪要,如实说(D13)。 */
  chat?: (prompt: string) => Promise<string>
  /** 音频解码。缺省 ffmpeg → afconvert;用例里注入。 */
  decode?: DecodeAudio
  /** 看板。没接就「都建」那一步做不了,如实说。 */
  tasks?: TasksService
  now?: () => number
  /** 每次状态变了喊一声(http.ts 拿它广播 /state)。 */
  onChange?: () => void
  /**
   * 她自己的数据拼成的事实表(账号数据、复盘、选题池、看板;meetingPrep.ts 的 meetingFactsOf)。
   * `keywords` 是这场会相关的花名。没接就一条数都没有,预案卡上全写「没有这个数」。
   */
  facts?: (keywords: readonly string[]) => Promise<MeetingFact[]>
  /** 花名档案。缺省与 meetings.json 同一个目录下的 `meeting-people.json`(她电脑上,不进工作目录、不上传)。 */
  peopleFile?: string
  /** 做预案卡每天最多几次。缺省 {@link MEETING_CARD_DAILY_CALLS}。 */
  cardDailyCalls?: number
}

export interface MeetingPlanResult { ok: boolean, meeting?: MeetingView, note?: string, error?: string }

/** 花名档案的一条(给她电脑上看、删)。 */
export type MeetingPersonRecord = StoredPerson

export interface MeetingStartResult { ok: boolean, id?: string, dir?: string, error?: string }
export interface MeetingImportResult { ok: boolean, id?: string, dir?: string, error?: string }
export interface MeetingOkResult { ok: boolean, error?: string }
export interface MeetingApplyResult { ok: boolean, created: string[], error?: string }

/** 放演示用那几场之后,一场一条:放了没有、落在哪、为什么没放。 */
export interface MeetingDemoSeededCase {
  key: string
  title: string
  id?: string
  dir?: string
  /** 已经有同一天同名的一场,这一场没再放。 */
  skipped?: true
  /** 这一场此刻的实话(放好了 / 跳过了 / 哪一步没成)。 */
  note: string
}

export interface MeetingDemoSeedResult {
  ok: boolean
  error?: string
  cases: MeetingDemoSeededCase[]
}

export interface MeetingService {
  /** `/state.meetings`。 */
  view: () => Promise<MeetingsView>
  /**
   * 开一场。手机点「会议」那一下 —— 或者手机在外面先录着、连上电脑才补开(2026-10-09):
   * `client_key` 是手机给这场会编的号,同一个号再来一次回同一场;`started_at` 是手机开录那一刻,日期按它算。
   */
  start: (input: { title?: unknown, client_key?: unknown, started_at?: unknown, plan_id?: unknown }) => Promise<MeetingStartResult>
  /** 收一段录音。**先落盘再记账** —— 反过来会出现"记了一段但文件不在"。 */
  segment: (input: { id: string, seq: number, bytes: Buffer, mimeType?: string, ms?: number }) => Promise<MeetingOkResult>
  /** 「结束」。**立刻返回**,转写与梳理在后台跑(手机上可以先离开)。 */
  finish: (input: { id: string, title?: unknown }) => Promise<MeetingOkResult>
  /**
   * 拿现成材料出一份纪要(2026-10-13)。两样之一,**一次只给一样**:
   *
   * - `text`:一段现成的转写文字。不经识别,整理只剩一次模型调用(约一分钟),
   *   转写当场落成 `转写.md`、**不建「录音」子目录**(没有录音就不摆一个空文件夹)。
   * - `audio_path`:这台电脑上一个录音文件。走的是真录那条路(落进「录音」→ 识别 → 梳理),
   *   所以一小时的录音照样要等半小时。
   *
   * 产物与手机录的一场**同形**:同一份 `会议/<日期>-<标题>/`、同一批待办、同一颗「重新整理」。
   */
  import: (input: { text?: unknown, audio_path?: unknown, title?: unknown, from?: unknown, plan_id?: unknown }) => Promise<MeetingImportResult>
  /**
   * 放三场演示用的会(2026-10-13,卡「会议页不再空着」)。**走的全是真路** ——
   * 一场一场地 `plan` 登记 → `answer` 答五问(预案卡照常自己排上去)→ `import` 用现成的转写出纪要,
   * 产物与真会同形(同一份 `会议/<日期>-<标题>/`、同一批待办),只多一个「演示用」的记号。
   *
   * **立刻返回**:纪要与预案卡在后台(一场一次模型调用,共六次)。
   * 同一天同一个标题已经有一场就**跳过那一场**,重复点不会放出第二摞。
   */
  seedDemo: () => Promise<MeetingDemoSeedResult>
  /** 一场会的全貌(手机上会议页轮询它)。 */
  get: (id: string) => Promise<MeetingView | undefined>
  /** 把挑中的待办建成卡。`todoIds` 空 = 全建。 */
  apply: (id: string, todoIds: readonly string[]) => Promise<MeetingApplyResult>
  /**
   * 「重新来」(2026-10-09):转写或梳理没成的那一场再跑一遍,**只重做没成的那一截** ——
   * 已经转好的段不再送识别;转写都好了就只再问一次模型。**立刻返回**,后台跑(同 finish)。
   */
  retry: (id: string) => Promise<MeetingOkResult>
  /** 一句话登记一场待开的会(2026-10-10):那句话认得出的几问直接填,其余一问一答。 */
  plan: (input: { text: string }) => Promise<MeetingPlanResult>
  /** 答一问。`id` 不给 = 最近那场还在问的会(电话里);`question` 不给 = 此刻在问的那一问。 */
  answer: (input: { id?: string, question?: string, answer: string }) => Promise<MeetingPlanResult>
  /** 再做一次预案卡;`proceed` = 目的还没说清,她点了「先照现在的准备」。 */
  card: (input: { id: string, proceed?: boolean }) => Promise<MeetingPlanResult>
  /** 撤掉一场还没开录的会(她说「这不是会」)。**只撤登记,不碰任何文件**。 */
  drop: (id: string) => Promise<MeetingOkResult>
  /** 会后她回一句:这场要定的定下来没有。 */
  outcome: (input: { id: string, settled: unknown, said?: unknown }) => Promise<MeetingOkResult>
  /** 花名档案(她电脑上看)。 */
  people: () => Promise<MeetingPersonRecord[]>
  /** 从花名档案里删掉一个花名。 */
  forgetPerson: (alias: string) => Promise<MeetingOkResult>
  /** 后台那条跑完了没有(用例里等它;生产没人调)。 */
  idle: () => Promise<void>
}

/** ffmpeg / afconvert 都没有时那句话。两条路都说出来,他照着做得了。 */
export const MEETING_NO_DECODER = '这台机器上既没有 ffmpeg 也没有 afconvert,录音解不开('
  + '录音本身一个字节都没动,还在会议目录里)。装一个 ffmpeg(brew install ffmpeg)之后重试。'

export const MEETING_NO_WORKDIR = '还没配「工作目录」(事务官仓库),会议没地方落。'
  + '在电脑上的设置里选一个目录之后再开会——**不猜一个路径**,猜错会把录音写进别人的仓库。'

const MEETING_NO_ASR = '转写没接上(8792 没起来,或者火山识别的凭据没配)。原始录音还在,配好之后可以重来一次。'
const MEETING_NO_MODEL = '转写好了,但模型服务没接上,所以这一场没有纪要。转写.md 已经在会议目录里了。'

/** 导入那条路:两样都没给 / 都给了 / 太长 / 文件读不开 / 转写.md 没了。 */
export const MEETING_IMPORT_EMPTY = '要给一段转写文字,或者一个录音文件在这台电脑上的位置。'
export const MEETING_IMPORT_BOTH = '一次只导一样:要么一段转写文字,要么一个录音文件。'
export const MEETING_IMPORT_NO_FILE = '这个录音文件读不开(位置是不是写错了?)'
export const MEETING_IMPORT_NO_TRANSCRIPT = '这一场是导入的,可是会议目录里的 转写.md 现在读不开,所以没法重新梳理。'

/**
 * 缺省解码:先 ffmpeg,再 afconvert。
 *
 * 为什么两条:ffmpeg 什么都吃(webm/opus 只有它能解),但不是 macOS 自带的;
 * afconvert 每台 Mac 都有,可它解不了 webm。所以**手机优先录 m4a**(recorderMime 的顺序),
 * 这样 afconvert 那条兜底才真的兜得住。两条都没有就如实报 {@link MEETING_NO_DECODER}。
 */
export function createDefaultDecoder(deps: { ffmpegPath?: string, afconvertPath?: string } = {}): DecodeAudio {
  const ffmpegPath = deps.ffmpegPath ?? 'ffmpeg'
  const afconvertPath = deps.afconvertPath ?? 'afconvert'
  return async (path: string): Promise<Buffer> => {
    try {
      return await run(ffmpegPath, ['-v', 'error', '-i', path, '-ar', String(ASR_SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-'])
    }
    catch (ffmpegError) {
      const out = join(tmpdir(), `wb-meeting-${randomUUID()}.wav`)
      try {
        await run(afconvertPath, ['-f', 'WAVE', '-d', `LEI16@${ASR_SAMPLE_RATE}`, '-c', '1', path, out])
        const wav = await readFile(out)
        return pcmOfWav(wav)
      }
      catch {
        throw new Error(`${MEETING_NO_DECODER}(ffmpeg 那边说:${(ffmpegError as Error)?.message ?? '没说原因'})`)
      }
      finally {
        // 临时文件只在这儿删:它是这个函数自己刚建的,**不是用户的录音**。
        try { await unlink(out) } catch { /* 没建成就没得删 */ }
      }
    }
  }
}

function run(file: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 转码是重活:降一档跑,别和电话抢 CPU(2026-09-25,见 lowPriority.ts)。报错里仍用原来的名字。
    const command = lowPriorityCommand(file, args)
    const child = spawn(command.file, command.args)
    const chunks: Buffer[] = []
    let failed: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', () => { /* 解码器的噪音不进日志:里面可能有文件路径 */ })
    child.on('error', (err) => { failed = new Error(`${file} 起不来(${err.message})`) })
    child.on('close', (code) => {
      if (failed !== undefined) { reject(failed); return }
      if (code !== 0) { reject(new Error(`${file} 退出码 ${code ?? '?'}`)); return }
      resolve(Buffer.concat(chunks))
    })
  })
}

/** WAV → data 段。没有 RIFF 头就当它本来就是裸 PCM(同 butler-server 的 extractPcm)。 */
export function pcmOfWav(buf: Buffer): Buffer {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let at = 12
    while (at + 8 <= buf.length) {
      const id = buf.toString('ascii', at, at + 4)
      const size = buf.readUInt32LE(at + 4)
      if (id === 'data') return buf.subarray(at + 8, Math.min(at + 8 + size, buf.length))
      at += 8 + size + (size & 1)
    }
  }
  return buf
}

function todoView(todo: StoredMeetingTodo): MeetingTodoView {
  return {
    id: todo.id,
    what: todo.what,
    ...(todo.who === undefined ? {} : { who: todo.who }),
    ...(todo.due === undefined ? {} : { due: todo.due }),
    ...(todo.task_id === undefined ? {} : { task_id: todo.task_id }),
  }
}

/**
 * 这一场能不能「重新来」。`running` = 这个进程里它正在后台跑(那就不给重来,免得同一场跑两遍)。
 * 停在 transcribing / summarizing 却没人在跑 = 工作台中途重启过,也给重来。
 */
export function meetingRetryable(meeting: StoredMeeting, running: boolean): boolean {
  if (running) return false
  if (meeting.status === 'failed') return true
  if (meeting.status === 'transcribing' || meeting.status === 'summarizing') return true
  if (meeting.status === 'done') return meeting.error !== undefined || meeting.summary === undefined
  return false
}

/** 手机报的开录时刻:像话(不在将来、不早于 30 天前)才认,不像话就按电脑此刻。 */
const START_BACKDATE_MAX_MS = 30 * 24 * 60 * 60 * 1000

function startedAtOf(raw: unknown, now: number): number {
  if (typeof raw !== 'string') return now
  const at = Date.parse(raw)
  if (!Number.isFinite(at) || at > now || now - at > START_BACKDATE_MAX_MS) return now
  return at
}

export function meetingViewOf(meeting: StoredMeeting, running = false, cardRunning = false): MeetingView {
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    started_at: meeting.started_at,
    ...(meeting.ended_at === undefined ? {} : { ended_at: meeting.ended_at }),
    status: meeting.status,
    segments: meeting.segments.length,
    ...(meeting.transcribed === undefined ? {} : { transcribed: meeting.transcribed }),
    ...(meeting.seconds === undefined ? {} : { seconds: meeting.seconds }),
    ...(meeting.timeline === undefined || meeting.timeline.length === 0 ? {} : { timeline: meeting.timeline }),
    ...(meeting.demo === true ? { demo: true as const } : {}),
    ...(meeting.dir === '' ? {} : { dir: meeting.dir }),
    ...(meeting.summary === undefined ? {} : { summary: meeting.summary, decisions: meetingDecisionsOf(meeting.summary) }),
    todos: meeting.todos.map(todoView),
    unsure: meeting.unsure,
    ...(meeting.error === undefined ? {} : { error: meeting.error }),
    ...(meetingRetryable(meeting, running) ? { retryable: true as const } : {}),
    ...(meeting.prep === undefined ? {} : { prep: prepViewOf(meeting.prep, cardRunning) }),
    ...(meeting.outcome === undefined ? {} : { outcome: meeting.outcome }),
  }
}

/** 一场待开的会此刻该跟她说哪一句(登记、答完一问之后回给她)。 */
export function prepNote(view: MeetingView): string {
  const prep = view.prep
  if (prep === undefined) return ''
  if (prep.ask !== undefined) return `还差一问:${prep.ask.text}${prep.ask.choices === undefined ? '' : `(${prep.ask.choices.join(' / ')})`}`
  if (prep.card_status === 'goal') return `这场会要定什么还没说清,先别急着备材料。可以先问问组织者,我替你拟了一句:「${prep.organizer_ask ?? MEETING_ORGANIZER_ASK}」—— 发不发由你,我不会替你发。`
  if (prep.card_status === 'making') return '五问齐了,预案卡在做,做好推到手机上。'
  if (prep.card_status === 'ready') return '预案卡好了,开会前在手机上看一遍。'
  return prep.card_error ?? '预案卡没做成。'
}

const OUTCOMES = ['yes', 'partly', 'no'] as const

/**
 * 放演示用那几场时,一场最多答几问就不再问下去。
 * 五问加上「谁拍板」那一追问最多六轮,留两轮余量;**问不完就停下如实说**,不在这儿转圈。
 */
const SEED_ASK_MAX = 8

export function createMeetingService(deps: MeetingServiceDeps): MeetingService {
  const now = deps.now ?? Date.now
  const decode = deps.decode ?? createDefaultDecoder()
  // 写队列,先例见 notes.ts / scenes.ts:load→改→save 不排队会丢更新。
  let writeQueue: Promise<void> = Promise.resolve()
  // 后台那条(转写 + 梳理)。用例里 await idle() 等它。
  let background: Promise<void> = Promise.resolve()
  /** 做预案卡那一条(与转写分开排:不让一场长会的转写挡住另一场会前的卡)。 */
  let cardJobs: Promise<void> = Promise.resolve()
  /** 这个进程里正在后台跑的那几场(「重新来」看它,免得同一场跑两遍)。 */
  const running = new Set<string>()
  /** 正在做预案卡的那几场。 */
  const cardRunning = new Set<string>()
  const peopleFile = deps.peopleFile ?? join(dirname(deps.file), 'meeting-people.json')
  const cardCap = deps.cardDailyCalls ?? MEETING_CARD_DAILY_CALLS

  function runPipeline(id: string): void {
    running.add(id)
    background = background.then(() => pipeline(id)).catch(() => undefined).finally(() => { running.delete(id) })
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function mutate<T>(fn: (file: MeetingsFile) => Promise<T> | T): Promise<T> {
    return enqueue(async () => {
      const file = await loadMeetingsFile(deps.file)
      const result = await fn(file)
      await saveMeetingsFile(deps.file, file)
      deps.onChange?.()
      return result
    })
  }

  async function find(id: string): Promise<StoredMeeting | undefined> {
    const file = await loadMeetingsFile(deps.file)
    return file.meetings.find(m => m.id === id)
  }

  function meetingsRoot(): string | undefined {
    const workdir = deps.workdir()
    if (workdir === undefined || workdir.trim() === '') return undefined
    return join(workdir, MEETINGS_DIR_NAME)
  }

  const viewOf = (one: StoredMeeting): MeetingView => meetingViewOf(one, running.has(one.id), cardRunning.has(one.id))

  // 这一份是 const 而不是直接 return:导入一个录音文件那条路要接着走 start → segment → finish
  // 这三条**已经有的**路,不另写第二份收段落盘的代码(接缝只留一条)。
  const service: MeetingService = {
    async view(): Promise<MeetingsView> {
      const file = await loadMeetingsFile(deps.file)
      const root = meetingsRoot()
      const recent = file.meetings
        .filter(one => one.status !== 'planned')
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, MEETING_RECENT_MAX)
        .map(viewOf)
      // 待开的会:昨天以前的不再摆(没开成的会留在索引里,不删)。最近要开的在前。
      const yesterday = localDateStr(now() - 24 * 3600 * 1000)
      const upcoming = file.meetings
        .filter(one => one.status === 'planned' && one.date >= yesterday)
        .sort((a, b) => planOrder(a).localeCompare(planOrder(b)))
        .map(viewOf)
      return { recent, upcoming, ...(root === undefined ? {} : { dir: root }) }
    },

    async start(input): Promise<MeetingStartResult> {
      const root = meetingsRoot()
      if (root === undefined) return { ok: false, error: MEETING_NO_WORKDIR }
      const clientKey = typeof input.client_key === 'string' && input.client_key.trim() !== '' ? input.client_key.trim().slice(0, 100) : undefined
      if (clientKey !== undefined) {
        // 手机重发同一场(上一次的回包它没收到):回同一场,**不另起目录**。
        const known = (await loadMeetingsFile(deps.file)).meetings.find(m => m.client_key === clientKey)
        if (known !== undefined) return { ok: true, id: known.id, dir: known.dir }
      }
      const at = startedAtOf(input.started_at, now())
      /**
       * 会前登记过的那一场(2026-10-10):开录接到**同一个会议对象**上 —— 同一个 id、同一个目录(做预案卡时已建)、
       * 画像与要定什么都还在,会后的结果对得上会前要定的。那一场已经开录了(别的手机 / 重开)就另起一场,不叠录音。
       */
      const planId = typeof input.plan_id === 'string' ? input.plan_id : undefined
      const planned = planId === undefined ? undefined : (await loadMeetingsFile(deps.file)).meetings.find(m => m.id === planId && m.status === 'planned')
      if (planned !== undefined) {
        let dir = planned.dir
        try {
          if (dir === '') dir = await freshDir(root, planned.date, planned.title)
          await mkdir(join(dir, RECORDINGS_DIR_NAME), { recursive: true })
        }
        catch (error) { return { ok: false, error: `会议目录建不出来:${(error as Error)?.message ?? '没说原因'}` } }
        await mutate((file) => {
          const stored = file.meetings.find(m => m.id === planned.id)
          if (stored === undefined) return
          stored.status = 'recording'
          stored.dir = dir
          stored.started_at = new Date(at).toISOString()
          if (clientKey !== undefined) stored.client_key = clientKey
        })
        return { ok: true, id: planned.id, dir }
      }
      const date = localDateStr(at)
      const title = safeMeetingTitle(input.title)
      let dir: string
      try {
        dir = await freshDir(root, date, title)
        await mkdir(join(dir, RECORDINGS_DIR_NAME), { recursive: true })
      }
      catch (error) { return { ok: false, error: `会议目录建不出来:${(error as Error)?.message ?? '没说原因'}` } }
      const meeting: StoredMeeting = {
        id: randomUUID(),
        title,
        date,
        started_at: new Date(at).toISOString(),
        status: 'recording',
        dir,
        segments: [],
        todos: [],
        unsure: [],
        ...(clientKey === undefined ? {} : { client_key: clientKey }),
      }
      await mutate((file) => { file.meetings.push(meeting) })
      return { ok: true, id: meeting.id, dir }
    },

    async segment(input): Promise<MeetingOkResult> {
      if (input.bytes.length === 0) return { ok: false, error: '这一段是空的,没有收' }
      if (input.bytes.length > MEETING_SEGMENT_MAX_BYTES) {
        return { ok: false, error: `一段最多 ${Math.round(MEETING_SEGMENT_MAX_BYTES / 1024 / 1024)}MB,这段更大` }
      }
      const meeting = await find(input.id)
      if (meeting === undefined) return { ok: false, error: '没有这一场会议' }
      const name = segmentFileName(input.seq, input.mimeType)
      const path = join(meeting.dir, RECORDINGS_DIR_NAME, name)
      // **先落盘再记账**:反过来会出现「记了一段但文件不在」,而那一段是永远找不回来的。
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, input.bytes)
      }
      catch (error) { return { ok: false, error: `这一段没写进硬盘:${(error as Error)?.message ?? '没说原因'}` } }
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === input.id)
        if (stored === undefined) return
        const already = stored.segments.findIndex(s => s.seq === input.seq)
        // 重传的那一段字节可能不一样了:旧的转写缓存跟着作废(entry 里不带 lines)。
        const entry = { seq: input.seq, file: name, ...(input.ms === undefined ? {} : { ms: input.ms }) }
        // 同一段重传(手机掉线重连)就替换,不追加 —— 追加会把同一段转两遍、收两遍钱。
        if (already >= 0) stored.segments[already] = entry
        else stored.segments.push(entry)
        stored.segments.sort((a, b) => a.seq - b.seq)
      })
      return { ok: true }
    },

    async finish(input): Promise<MeetingOkResult> {
      const meeting = await find(input.id)
      if (meeting === undefined) return { ok: false, error: '没有这一场会议' }
      if (meeting.status !== 'recording') return { ok: true } // 重复点「结束」不再跑一遍
      const endedAt = new Date(now()).toISOString()
      /**
       * 「结束」时才起名是常事(开会前谁也不知道这场会该叫什么)。所以这里**顺手把目录也改名**
       * —— 不改的话纪要里写的是新名字、访达里的文件夹还叫「会议」,人会以为是两场。
       * 改不动(重名、没权限)就**原样留着**,不报错:目录叫什么不影响任何一份内容。
       */
      const renamed = await renameForTitle(meeting, input.title)
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === input.id)
        if (stored === undefined) return
        stored.ended_at = endedAt
        stored.status = 'transcribing'
        stored.transcribed = 0
        if (renamed !== undefined) { stored.title = renamed.title; stored.dir = renamed.dir }
        const ms = stored.segments.reduce((sum, s) => sum + (s.ms ?? 0), 0)
        if (ms > 0) stored.seconds = Math.round(ms / 1000)
      })
      // **立刻返回**:手机上「正在整理」,人可以先离开。后台这条自己不抛(里面全包着)。
      runPipeline(input.id)
      return { ok: true }
    },

    async import(input): Promise<MeetingImportResult> {
      const root = meetingsRoot()
      if (root === undefined) return { ok: false, error: MEETING_NO_WORKDIR }
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      const audioPath = typeof input.audio_path === 'string' ? input.audio_path.trim() : ''
      if (text === '' && audioPath === '') return { ok: false, error: MEETING_IMPORT_EMPTY }
      if (text !== '' && audioPath !== '') return { ok: false, error: MEETING_IMPORT_BOTH }
      if (audioPath !== '') return await importAudio(audioPath, input.title, input.plan_id)
      if (text.length > MEETING_IMPORT_MAX_CHARS) {
        return { ok: false, error: `这一段太长了(${text.length} 字,一次最多 ${MEETING_IMPORT_MAX_CHARS} 字)。分两场导,或者把它存成文件再说。` }
      }
      const at = new Date(now()).toISOString()
      const from = typeof input.from === 'string' ? input.from.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
      /**
       * 会前登记过的那一场(2026-10-13,与 `start` 的 `plan_id` 同一个意思):转写接到**同一个会议对象**上
       * —— 同一个 id、同一个目录(做预案卡时已经建了)、画像与「要定什么」都还在,所以这一场在手机上
       * 翻得到会前那一段。那一场已经不是「待开」了(录过 / 导过)就另起一场,**不往上叠**(同 start)。
       */
      const planId = typeof input.plan_id === 'string' ? input.plan_id.trim() : ''
      const planned = planId === '' ? undefined : (await loadMeetingsFile(deps.file)).meetings.find(m => m.id === planId && m.status === 'planned')
      if (planned !== undefined) return await importIntoPlanned(planned, { text, at, from })
      const date = localDateStr(now())
      const title = safeMeetingTitle(input.title)
      let dir: string
      try {
        dir = await freshDir(root, date, title)
        // **不建「录音」子目录**:这一场没有录音,摆一个空文件夹会让人以为录音丢了。
        await mkdir(dir, { recursive: true })
      }
      catch (error) { return { ok: false, error: `会议目录建不出来:${(error as Error)?.message ?? '没说原因'}` } }
      try {
        await writeFile(join(dir, TRANSCRIPT_FILE_NAME), renderImportedTranscriptMd({
          title, date, startedAt: at, text, ...(from === '' ? {} : { from }),
        }))
      }
      catch (error) { return { ok: false, error: `转写写不进硬盘:${(error as Error)?.message ?? '没说原因'}` } }
      const meeting: StoredMeeting = {
        id: randomUUID(),
        title,
        date,
        started_at: at,
        ended_at: at,
        // 转写这一步在导入那一刻就做完了,所以直接进「在梳理」。
        status: 'summarizing',
        dir,
        segments: [],
        todos: [],
        unsure: [],
        imported_text: true,
      }
      await mutate((file) => { file.meetings.push(meeting) })
      // **立刻返回**:界面上「约一分钟」,后台这条自己不抛(同 finish)。
      runPipeline(meeting.id)
      return { ok: true, id: meeting.id, dir }
    },

    async get(id): Promise<MeetingView | undefined> {
      const meeting = await find(id)
      return meeting === undefined ? undefined : meetingViewOf(meeting, running.has(id))
    },

    async retry(id): Promise<MeetingOkResult> {
      const meeting = await find(id)
      if (meeting === undefined) return { ok: false, error: '没有这一场会议' }
      if (meeting.status === 'recording') return { ok: false, error: '这一场还在录,结束之后才整理' }
      if (!meetingRetryable(meeting, running.has(id))) {
        return { ok: false, error: running.has(id) ? '这一场正在整理,不用重来' : '这一场已经整理好了' }
      }
      // 导入的那一场没有分段:转写早就在盘上了,重来只剩「问一次模型」。
      const allCached = meeting.imported_text === true
        || (meeting.segments.length > 0 && meeting.segments.every(s => s.lines !== undefined))
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === id)
        if (stored === undefined) return
        stored.status = allCached ? 'summarizing' : 'transcribing'
        stored.transcribed = stored.segments.filter(s => s.lines !== undefined).length
        delete stored.error
      })
      runPipeline(id)
      return { ok: true }
    },

    async apply(id, todoIds): Promise<MeetingApplyResult> {
      const tasks = deps.tasks
      if (tasks === undefined) return { ok: false, created: [], error: '看板没接上,建不了卡' }
      const meeting = await find(id)
      if (meeting === undefined) return { ok: false, created: [], error: '没有这一场会议' }
      const wanted = todoIds.length === 0 ? meeting.todos.map(t => t.id) : [...todoIds]
      const created: string[] = []
      const madeIds = new Map<string, string>()
      for (const todoId of wanted) {
        const todo = meeting.todos.find(t => t.id === todoId)
        if (todo === undefined) continue
        if (todo.task_id !== undefined) continue // 建过就不再建一张(手机上点两下「都建」不该出双份)
        const desc = [
          todo.who === undefined ? '会议纪要里没说谁做。' : `会议纪要里写的是:${todo.who}。`,
          todo.due === undefined ? '也没说期限。' : `期限按会上的原话是「${todo.due}」(**没有换算成日期**)。`,
          `来自会议「${meeting.title}」(${meeting.date}),纪要在 ${join(meeting.dir, NOTES_FILE_NAME)}。`,
        ].join('')
        const result = await tasks.create({
          title: todo.what,
          desc,
          direction: 'mine',
          // 会上大家说的,不只是他(2026-09-25):固化提议不数它。
          origin: 'meeting',
          // ★ 来源钉成 meeting:看板上看得出这张卡是从哪一场会来的(任务书第 3 条)。
          source: { kind: 'meeting', ref: meeting.id },
        })
        if (result.ok && result.id !== undefined) { created.push(result.id); madeIds.set(todoId, result.id) }
      }
      if (madeIds.size > 0) {
        await mutate((file) => {
          const stored = file.meetings.find(m => m.id === id)
          if (stored === undefined) return
          for (const todo of stored.todos) {
            const taskId = madeIds.get(todo.id)
            if (taskId !== undefined) todo.task_id = taskId
          }
        })
      }
      return { ok: true, created }
    },

    async plan(input): Promise<MeetingPlanResult> {
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (text === '') return { ok: false, error: '这场会是什么,说一句' }
      const draft = draftMeetingPlan(text, now())
      const prep = fillFromRecords(draft.prep, await loadPeople())
      const meeting: StoredMeeting = {
        id: randomUUID(),
        title: draft.title,
        date: draft.date,
        started_at: new Date(now()).toISOString(),
        status: 'planned',
        dir: '',
        segments: [],
        todos: [],
        unsure: [],
        prep,
      }
      await mutate((file) => { file.meetings.push(meeting) })
      await afterPrepChange(meeting.id)
      const view = viewOf((await find(meeting.id)) ?? meeting)
      const when = prep.when === undefined ? '' : `(${prep.when})`
      return { ok: true, meeting: view, note: `记下了这场会:「${meeting.title}」${when}。${prepNote(view)}` }
    },

    async answer(input): Promise<MeetingPlanResult> {
      const file = await loadMeetingsFile(deps.file)
      const target = input.id === undefined
        ? [...file.meetings].filter(m => m.status === 'planned' && m.prep !== undefined && nextPrepAsk(m.prep) !== undefined)
          .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
        : file.meetings.find(m => m.id === input.id)
      if (target?.prep === undefined) return { ok: false, error: input.id === undefined ? '没有在问的会' : '没有这一场会前登记' }
      const question = (input.question ?? nextPrepAsk(target.prep)?.id) as MeetingPrepQuestionId | undefined
      if (question === undefined) return { ok: false, error: '五问都答过了;要改哪一问,说是哪一问' }
      const got = answerPrep(target.prep, question, String(input.answer ?? ''))
      if (!got.ok) return { ok: false, error: got.error }
      await mutate((all) => {
        const stored = all.meetings.find(m => m.id === target.id)
        if (stored !== undefined) stored.prep = got.prep
      })
      if ((question === 'people' || question === 'decider') && got.prep.people !== undefined) {
        const archive = await loadPeople()
        upsertPeople(archive, got.prep.people.value, { id: target.id, title: target.title, date: target.date, ...(got.prep.scope === undefined ? {} : { scope: got.prep.scope.value }) }, now())
        await saveJson(peopleFile, archive)
      }
      await afterPrepChange(target.id)
      const view = viewOf((await find(target.id))!)
      return { ok: true, meeting: view, note: prepNote(view) }
    },

    async card(input): Promise<MeetingPlanResult> {
      const meeting = await find(input.id)
      if (meeting?.prep === undefined) return { ok: false, error: '没有这一场会前登记' }
      if (input.proceed === true) {
        await mutate((file) => {
          const stored = file.meetings.find(m => m.id === input.id)
          if (stored?.prep !== undefined) stored.prep = { ...stored.prep, proceed: true }
        })
      }
      const fresh = (await find(input.id))!
      const status = cardStatusOf(fresh.prep!, cardRunning.has(input.id))
      if (status === 'answers') return { ok: false, error: '五问还没答完', meeting: viewOf(fresh), note: prepNote(viewOf(fresh)) }
      if (status === 'goal') return { ok: false, error: '这场会要定什么还没说清', meeting: viewOf(fresh), note: prepNote(viewOf(fresh)) }
      if (!cardRunning.has(input.id)) runCard(input.id)
      const view = viewOf((await find(input.id))!)
      return { ok: true, meeting: view, note: prepNote(view) }
    },

    async drop(id): Promise<MeetingOkResult> {
      const meeting = await find(id)
      if (meeting === undefined) return { ok: false, error: '没有这一场会议' }
      if (meeting.status !== 'planned') return { ok: false, error: '只有还没开录的会能撤掉登记' }
      // 只撤索引里这一条;会前.md 若已落盘照旧留着(这里不删任何文件)。
      await mutate((file) => { file.meetings = file.meetings.filter(m => m.id !== id) })
      return { ok: true }
    },

    async outcome(input): Promise<MeetingOkResult> {
      const settled = OUTCOMES.find(one => one === input.settled)
      if (settled === undefined) return { ok: false, error: '定下来没有:yes / partly / no' }
      const meeting = await find(input.id)
      if (meeting === undefined) return { ok: false, error: '没有这一场会议' }
      if (meeting.status === 'planned') return { ok: false, error: '这场会还没开' }
      const said = typeof input.said === 'string' && input.said.trim() !== '' ? input.said.trim().slice(0, 200) : undefined
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === input.id)
        if (stored !== undefined) stored.outcome = { settled, ...(said === undefined ? {} : { said }), at: new Date(now()).toISOString() }
      })
      return { ok: true }
    },

    async people(): Promise<MeetingPersonRecord[]> {
      return (await loadPeople()).people
    },

    async forgetPerson(alias): Promise<MeetingOkResult> {
      const archive = await loadPeople()
      const left = archive.people.filter(p => p.alias !== alias)
      if (left.length === archive.people.length) return { ok: false, error: '档案里没有这个花名' }
      await saveJson(peopleFile, { version: 1, people: left })
      deps.onChange?.()
      return { ok: true }
    },

    seedDemo,

    async idle(): Promise<void> {
      await background
      await cardJobs
    },
  }

  /**
   * 会前登记过的那一场,把现成的转写接上去(2026-10-13)。目录照用会前那一个,画像一个字不动。
   * **绝不另起一场**:她在手机上要能从同一场里翻出会前五问、预案卡和纪要。
   */
  async function importIntoPlanned(planned: StoredMeeting, input: { text: string, at: string, from: string }): Promise<MeetingImportResult> {
    // 会前.md 还没落过的那一场(预案卡正在做)目录还是空的:这里建出来,会前.md 随后落进**同一个**。
    const got = await ensureDir(planned.id)
    if (!got.ok) return { ok: false, error: got.error }
    const dir = got.dir
    try {
      await writeFile(join(dir, TRANSCRIPT_FILE_NAME), renderImportedTranscriptMd({
        title: planned.title, date: planned.date, startedAt: input.at, text: input.text,
        ...(input.from === '' ? {} : { from: input.from }),
      }))
    }
    catch (error) { return { ok: false, error: `转写写不进硬盘:${(error as Error)?.message ?? '没说原因'}` } }
    await mutate((file) => {
      const stored = file.meetings.find(m => m.id === planned.id)
      if (stored === undefined) return
      stored.status = 'summarizing'
      // 开录那一刻照旧是**导入那一刻**(同直接导一段转写的那条路):她登记时说的几点在会前那一段里。
      stored.started_at = input.at
      stored.ended_at = input.at
      stored.imported_text = true
    })
    runPipeline(planned.id)
    return { ok: true, id: planned.id, dir }
  }

  /**
   * 放三场演示用的会。一场一场走真路:`plan` → `answer`(照它此刻问的那一问答)→ `import`。
   * **绝不抛**:哪一步没成就在那一场的 `note` 里如实说,别的两场照放。
   */
  async function seedDemo(): Promise<MeetingDemoSeedResult> {
    if (meetingsRoot() === undefined) return { ok: false, error: MEETING_NO_WORKDIR, cases: [] }
    const cases: MeetingDemoSeededCase[] = []
    for (const one of MEETING_DEMO_CASES) cases.push(await seedOneDemo(one))
    return { ok: true, cases }
  }

  async function seedOneDemo(one: MeetingDemoCase): Promise<MeetingDemoSeededCase> {
    // 标题与哪天**都由登记那句话算出来**(`draftMeetingPlan`),所以这道闸认的和 plan 认的是同一件事。
    const draft = draftMeetingPlan(one.said, now())
    const head = { key: one.key, title: draft.title }
    const already = (await loadMeetingsFile(deps.file)).meetings.find(m => m.title === draft.title && m.date === draft.date)
    if (already !== undefined) {
      return {
        ...head,
        id: already.id,
        ...(already.dir === '' ? {} : { dir: already.dir }),
        skipped: true,
        note: `${draft.date} 已经有一场「${draft.title}」,这一场没再放一遍。`,
      }
    }
    const planned = await service.plan({ text: one.said })
    const id = planned.meeting?.id
    if (id === undefined) return { ...head, note: `登记没成:${planned.error ?? '没说原因'}` }
    await mutate((file) => {
      const stored = file.meetings.find(m => m.id === id)
      if (stored !== undefined) stored.demo = true
    })
    for (let round = 0; round < SEED_ASK_MAX; round += 1) {
      const fresh = await find(id)
      const ask = fresh?.prep === undefined ? undefined : nextPrepAsk(fresh.prep)
      if (ask === undefined) break
      const reply = one.answers[ask.id]
      // 样例里没写这一问的答案:停在这儿,画像与登记照样留着(不替样例猜一个答案)。
      if (reply === undefined) return { ...head, id, note: `会前停在「${ask.text}」这一问上:样例里没写它的答案。` }
      const got = await service.answer({ id, question: ask.id, answer: reply })
      if (!got.ok) return { ...head, id, note: `答「${ask.text}」没成:${got.error ?? '没说原因'}` }
    }
    const imported = await service.import({ plan_id: id, text: one.transcript, from: MEETING_DEMO_FROM })
    if (!imported.ok) return { ...head, id, note: `会前放好了,转写没接上去:${imported.error ?? '没说原因'}` }
    return { ...head, id, ...(imported.dir === undefined ? {} : { dir: imported.dir }), note: one.blurb }
  }

  /**
   * 导入一个本机录音文件:接着走已经有的 start → segment → finish,**不另写一条收段落盘的路**。
   * 标题没给就用文件名(不叫「会议」—— 她一眼看得出这一场是哪一份录音)。
   */
  async function importAudio(path: string, rawTitle: unknown, planId: unknown): Promise<MeetingImportResult> {
    let bytes: Buffer
    try { bytes = await readFile(path) }
    catch (error) { return { ok: false, error: `${MEETING_IMPORT_NO_FILE}(${(error as Error)?.message ?? '没说原因'})` } }
    if (bytes.length === 0) return { ok: false, error: '这个录音文件是空的。' }
    if (bytes.length > MEETING_SEGMENT_MAX_BYTES) {
      return { ok: false, error: `一次最多导 ${Math.round(MEETING_SEGMENT_MAX_BYTES / 1024 / 1024)}MB 的录音,这个更大。` }
    }
    const named = typeof rawTitle === 'string' && rawTitle.trim() !== ''
      ? rawTitle
      : basename(path).replace(/\.[a-z0-9]+$/i, '')
    const started = await service.start({ title: named, ...(typeof planId === 'string' && planId !== '' ? { plan_id: planId } : {}) })
    if (!started.ok || started.id === undefined) return { ok: false, error: started.error ?? '开不了这一场' }
    const mime = segmentMimeOfPath(path)
    const saved = await service.segment({ id: started.id, seq: 1, bytes, ...(mime === undefined ? {} : { mimeType: mime }) })
    if (!saved.ok) return { ok: false, error: saved.error ?? '这一段没收下' }
    const done = await service.finish({ id: started.id })
    if (!done.ok) return { ok: false, error: done.error ?? '整理起不来' }
    return { ok: true, id: started.id, ...(started.dir === undefined ? {} : { dir: started.dir }) }
  }

  async function loadPeople(): Promise<MeetingPeopleFile> {
    try {
      const parsed = JSON.parse(await readFile(peopleFile, 'utf8')) as Partial<MeetingPeopleFile> | null
      return { version: 1, people: Array.isArray(parsed?.people) ? parsed.people : [] }
    }
    catch { return { version: 1, people: [] } }
  }

  /** 同一天同一个标题第二场:目录后面加 `-2`。**绝不往已有目录里叠录音**。 */
  async function freshDir(root: string, date: string, title: string): Promise<string> {
    let dir = join(root, meetingDirName(date, title))
    let suffix = 2
    while (await exists(dir)) { dir = join(root, `${meetingDirName(date, title)}-${suffix}`); suffix += 1 }
    return dir
  }

  /** 画像变了:五问齐了就做卡;目的说不清先拦,会前.md 写上拟好的那句。 */
  async function afterPrepChange(id: string): Promise<void> {
    const meeting = await find(id)
    if (meeting?.prep === undefined) return
    const status = cardStatusOf(meeting.prep, cardRunning.has(id))
    if (status === 'goal') await writePrepMd(id)
    if (status === 'making' && meeting.prep.card === undefined && meeting.prep.card_error === undefined && !cardRunning.has(id)) runCard(id)
  }

  /**
   * 这一场的落盘目录,没有就建一个并记下来。**整件事在写队列里一次做完**:
   * 会前.md 与导入进来的转写可能同时要这个目录(预案卡还在做的时候她就把转写导进来了),
   * 各自 `freshDir` 一次会建出两个(第二个叫 `…-2`),于是一场会的材料散在两个文件夹里。
   */
  async function ensureDir(id: string): Promise<{ ok: true, dir: string } | { ok: false, error: string }> {
    const root = meetingsRoot()
    if (root === undefined) return { ok: false, error: MEETING_NO_WORKDIR }
    return await mutate(async (file) => {
      const stored = file.meetings.find(m => m.id === id)
      if (stored === undefined) return { ok: false as const, error: '没有这一场会议' }
      if (stored.dir !== '') return { ok: true as const, dir: stored.dir }
      try {
        const dir = await freshDir(root, stored.date, stored.title)
        await mkdir(dir, { recursive: true })
        stored.dir = dir
        return { ok: true as const, dir }
      }
      catch (error) { return { ok: false as const, error: `会议目录建不出来:${(error as Error)?.message ?? '没说原因'}` } }
    })
  }

  /** 会前.md 落进这场会的目录(第一次落时建目录)。没配工作目录就不落,画像照样在索引里。 */
  async function writePrepMd(id: string): Promise<void> {
    const meeting = await find(id)
    if (meeting?.prep === undefined) return
    const got = await ensureDir(id)
    if (!got.ok) return
    try {
      await writeFile(join(got.dir, PREP_FILE_NAME), renderPrepMd({ title: meeting.title, date: meeting.date, prep: meeting.prep }))
    }
    catch { /* 会前.md 落不下不影响画像与卡(都在索引里) */ }
  }

  function runCard(id: string): void {
    cardRunning.add(id)
    deps.onChange?.()
    cardJobs = cardJobs.then(() => makeCard(id)).catch(() => undefined).finally(() => { cardRunning.delete(id); deps.onChange?.() })
  }

  /** 做一张预案卡。**绝不抛**:没做成就把原因写进 card_error,画像照存。 */
  async function makeCard(id: string): Promise<void> {
    const meeting = await find(id)
    if (meeting?.prep === undefined) return
    const setPrep = async (patch: (prep: StoredMeetingPrep) => StoredMeetingPrep): Promise<void> => {
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === id)
        if (stored?.prep !== undefined) stored.prep = patch(stored.prep)
      })
    }
    const failWith = async (error: string): Promise<void> => { await setPrep(prep => ({ ...prep, card_error: error })) }
    if (deps.chat === undefined) { await failWith('模型服务没接上,预案卡没做;画像已经存好了。'); return }
    const day = localDateStr(now())
    // 先占一次额度再问:钱是在问的那一下花的,没做成也算。
    const allowed = await mutate((file) => {
      const calls = file.card_calls?.day === day ? file.card_calls : { day, n: 0 }
      if (calls.n >= cardCap) return false
      file.card_calls = { day, n: calls.n + 1 }
      return true
    })
    if (!allowed) { await failWith(`今天做预案卡的次数到上限了(每天 ${cardCap} 次),明天再做;画像已经存好了。`); return }
    const facts = await (deps.facts?.(meeting.prep.aliases) ?? Promise.resolve([])).catch(() => [] as MeetingFact[])
    let reply: string
    try { reply = await deps.chat(buildCardPrompt({ title: meeting.title, prep: meeting.prep }, facts)) }
    catch (error) { await failWith(`预案卡没做成:${(error as Error)?.message ?? '模型没回'}`); return }
    const context = [meeting.title, meeting.prep.said, meeting.prep.goal?.value ?? '', meeting.prep.when ?? ''].join('\n')
    const parsed = parseCardReply(reply, facts, context)
    if ('error' in parsed) { await failWith(parsed.error); return }
    await setPrep((prep) => {
      const next: StoredMeetingPrep = { ...prep, card: { made_at: new Date(now()).toISOString(), questions: parsed.questions } }
      delete next.card_error
      return next
    })
    await writePrepMd(id)
  }

  /**
   * 「结束」时给的新名字 → 新标题 + 新目录。没给新名字、名字没变、或者改不动就回 undefined。
   * **绝不抛**:目录叫什么不影响任何一份内容。
   */
  async function renameForTitle(meeting: StoredMeeting, raw: unknown): Promise<{ title: string, dir: string } | undefined> {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    const title = safeMeetingTitle(raw)
    if (title === meeting.title) return undefined
    const root = meetingsRoot()
    if (root === undefined) return undefined
    const dir = join(root, meetingDirName(meeting.date, title))
    // 重名就只改标题、不动目录 —— 覆盖掉另一场会的录音是这里能犯的最坏的错。
    if (await exists(dir)) return { title, dir: meeting.dir }
    try { await rename(meeting.dir, dir) }
    catch { return { title, dir: meeting.dir } }
    return { title, dir }
  }

  /** 转写 + 梳理。**绝不抛**:失败变成 status=failed + 一句人话,录音一个都不删。 */
  async function pipeline(id: string): Promise<void> {
    let meeting = await find(id)
    if (meeting === undefined) return
    // 导入进来的那一场(2026-10-13):转写早就在盘上了,从那儿读回来,只剩「问一次模型」。
    if (meeting.imported_text === true) {
      let md: string
      try { md = await readFile(join(meeting.dir, TRANSCRIPT_FILE_NAME), 'utf8') }
      catch { await fail(id, MEETING_IMPORT_NO_TRANSCRIPT); return }
      await summarize(id, { transcriptMd: md, evidence: transcriptBodyOf(md), imported: true })
      return
    }
    if (deps.transcribe === undefined) { await fail(id, MEETING_NO_ASR); return }

    const lines: TranscriptLine[] = []
    let offsetMs = 0
    let asrFailures = 0
    let firstError: string | undefined
    let done = 0
    for (const segment of [...meeting.segments].sort((a, b) => a.seq - b.seq)) {
      // 上一遍已经整段转好了(「重新来」):直接用,不再送识别。
      if (segment.lines !== undefined) {
        for (const line of segment.lines) lines.push({ startMs: offsetMs + line.startMs, text: line.text })
        offsetMs += segment.pcm_ms ?? segment.ms ?? 0
        done += 1
        continue
      }
      const path = join(meeting.dir, RECORDINGS_DIR_NAME, segment.file)
      let pcm: Buffer
      try { pcm = segment.file.endsWith('.wav') ? pcmOfWav(await readFile(path)) : await decode(path) }
      catch (error) {
        firstError ??= (error as Error)?.message ?? '解不开这一段录音'
        asrFailures += 1
        // 这一段解不开就按它自己报的时长往后挪,后面几段的时间戳才不会全错位。
        offsetMs += segment.ms ?? 0
        continue
      }
      const own: TranscriptLine[] = []
      let segmentFailed = false
      for (const piece of splitPcmForAsr(pcm, ASR_SAMPLE_RATE)) {
        let text = ''
        try { text = await deps.transcribe(encodeWav(piece.pcm)) }
        catch (error) {
          asrFailures += 1
          segmentFailed = true
          firstError ??= (error as Error)?.message ?? '转写失败'
        }
        own.push({ startMs: piece.startMs, text })
      }
      for (const line of own) lines.push({ startMs: offsetMs + line.startMs, text: line.text })
      const segmentMs = Math.round((pcm.length / 2 / ASR_SAMPLE_RATE) * 1000)
      offsetMs += segmentMs > 0 ? segmentMs : (segment.ms ?? 0)
      done += 1
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === id)
        if (stored === undefined) return
        stored.transcribed = done
        // 每一片都转成了才记下来;有一片没成,重来时整段再送。
        const kept = stored.segments.find(s => s.seq === segment.seq && s.file === segment.file)
        if (kept !== undefined && !segmentFailed) { kept.lines = own; kept.pcm_ms = segmentMs }
      })
    }

    const seconds = Math.round(offsetMs / 1000)
    meeting = await find(id)
    if (meeting === undefined) return
    const transcriptMd = renderTranscriptMd({
      title: meeting.title, date: meeting.date, startedAt: meeting.started_at, seconds, lines,
    })
    try { await writeFile(join(meeting.dir, TRANSCRIPT_FILE_NAME), transcriptMd) }
    catch (error) { await fail(id, `转写写不进硬盘:${(error as Error)?.message ?? '没说原因'}`); return }

    const body = lines.filter(line => line.text.trim() !== '')
    if (body.length === 0) {
      await fail(id, firstError === undefined ? '这一场一个字都没转出来(原始录音还在)' : `${MEETING_NO_ASR}(${firstError})`, seconds)
      return
    }

    await summarize(id, {
      transcriptMd,
      // 「下一步」里的人名与日期拿这一份核(文件头不算证据)——只用转出来的那几句。
      evidence: body.map(line => line.text).join('\n'),
      seconds,
      ...(asrFailures > 0 ? { asrNote: `有 ${asrFailures} 段没转出来(${firstError ?? '没说原因'}),纪要是从剩下的那些里梳理的。` } : {}),
    })
  }

  /**
   * 梳理那一步:一次模型调用 → `纪要.md` → 待办。转写从哪来由上面两条路决定
   * (真录的那一场现转出来、导入的那一场从盘上读回来)。**绝不抛**。
   */
  async function summarize(id: string, input: {
    transcriptMd: string
    evidence: string
    seconds?: number
    asrNote?: string
    imported?: true
  }): Promise<void> {
    const meeting = await find(id)
    if (meeting === undefined) return
    const { seconds } = input
    /**
     * 会中那一段的时间线:**转写一落盘就有**,所以在问模型之前先存 —— 模型没接上、梳理没成的那一场,
     * 她在手机上至少还能顺着时间看这一场讲到哪儿了。
     */
    const marks = timelineOf(transcriptBodyOf(input.transcriptMd))
    if (marks.length > 0) {
      await mutate((file) => {
        const stored = file.meetings.find(m => m.id === id)
        if (stored !== undefined) stored.timeline = marks
      })
    }
    if (deps.chat === undefined) { await fail(id, MEETING_NO_MODEL, seconds, 'done'); return }
    await mutate((file) => {
      const stored = file.meetings.find(m => m.id === id)
      if (stored === undefined) return
      stored.status = 'summarizing'
      if (seconds !== undefined) stored.seconds = seconds
    })

    let reply: string
    try { reply = await deps.chat(buildMeetingPrompt(meeting.title, input.transcriptMd)) }
    catch (error) {
      await fail(id, `梳理没成:${(error as Error)?.message ?? '没说原因'}。转写.md 已经在会议目录里了。`, seconds, 'done')
      return
    }
    const parsed = parseMeetingReply(reply, input.evidence)
    const notesMd = renderNotesMd({
      title: meeting.title,
      date: meeting.date,
      startedAt: meeting.started_at,
      ...(seconds === undefined ? {} : { seconds }),
      parsed,
      ...(input.imported === true ? { imported: true as const } : {}),
    })
    try { await writeFile(join(meeting.dir, NOTES_FILE_NAME), notesMd) }
    catch (error) { await fail(id, `纪要写不进硬盘:${(error as Error)?.message ?? '没说原因'}`, seconds, 'done'); return }

    await mutate((file) => {
      const stored = file.meetings.find(m => m.id === id)
      if (stored === undefined) return
      stored.status = 'done'
      if (seconds !== undefined) stored.seconds = seconds
      stored.summary = notesMd
      stored.todos = parsed.todos.map(todo => ({ ...todo }))
      stored.unsure = parsed.unsure
      delete stored.error
      // 一条都没转失败才算干净;有失败的段落如实留一句,别让人以为这份纪要是完整的。
      if (input.asrNote !== undefined) stored.error = input.asrNote
    })
  }

  async function fail(id: string, error: string, seconds?: number, status: MeetingStatus = 'failed'): Promise<void> {
    await mutate((file) => {
      const stored = file.meetings.find(m => m.id === id)
      if (stored === undefined) return
      stored.status = status
      stored.error = error
      if (seconds !== undefined) stored.seconds = seconds
    })
  }

  return service
}

/** 待开的会怎么排:定了几点按几点,没定按哪天。 */
function planOrder(meeting: StoredMeeting): string {
  return meeting.prep?.scheduled_at ?? `${meeting.date}T99`
}

async function saveJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

async function exists(path: string): Promise<boolean> {
  try { await readdir(path); return true }
  catch { return false }
}

/**
 * 这个服务能做的事,钉成常量。
 *
 * 用意与 `TASKS_SERVICE_METHODS` / `INBOX_SERVICE_METHODS` 完全一样:
 * 将来谁想给它加一条「自动清理旧会议」的能力,必须先改这条断言,改的时候人一定看得见。
 * **这里没有任何一条能删掉录音的方法**,一条都没有。
 */
export const MEETING_SERVICE_METHODS = ['view', 'start', 'segment', 'finish', 'import', 'seedDemo', 'get', 'apply', 'retry', 'plan', 'answer', 'card', 'drop', 'outcome', 'people', 'forgetPerson', 'idle'] as const
