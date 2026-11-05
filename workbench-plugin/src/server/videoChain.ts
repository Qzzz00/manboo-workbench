/**
 * **一件事两步接力:先让豆包出参考图,再拿这张图进可灵生成视频**(2026-10-12,卡「演示 · 出图进可灵」;周三 10-14 演示)。
 *
 * 维护者 10-12 校正过的流程:她拿起座机说「帮我做一个 XXX 的视频」→
 * ① 「生成参考图」派给豆包办公(窗口型)→ ② 盯着豆包,图出来了就把原图落进她工作目录里这件事的文件夹 →
 * ③ 图和按 XXX 写的提示词交给可灵桌面版 → ④ **进入生成就算完成**,电话里 / 手机上说一句。
 *
 * ## 这一层管什么
 *
 * 只管「接力」:哪一步走到哪了、上一步的产物(那张图的路径)交给下一步、最后怎么收卡。
 * 每一步怎么做都是现成的:第一步就是普通派活(`dispatchRun`,送字、盯窗、读回话一样不少);
 * 取图在 `doubaoImage.ts`(它自己的本机缓存);第二步在 `klingStep.ts`。
 *
 * 第一步派出去之后,`dispatchRun` 照常盯那扇窗;它读到豆包说完时,**不把卡挪去「等你确认」**
 * (`owns` 那一格:这件事还有下一步),回话照样记在卡上。真正收卡的是这里。
 *
 * ## 通用到哪一步(交接里写了没通用的部分)
 *
 * 记录里存的是「这一件走到哪一步 + 上一步的产物」,不是写死的两段代码 —— 但今天只有一种接力
 * (出图 → 可灵)。把「每一步是什么」做成能配的一张表,等第二种接力出现再做(YAGNI)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskStatus, TaskView } from '../protocol.ts'
import { TOPIC_ASSET_SUBDIR, TOPIC_DIR } from '../templates.ts'
import type { CachedImage } from './doubaoImage.ts'
// 并进提示词之前再过一遍补细节那道门(2026-10-13 晚,卡 P):与 8791 那一道**同一个纯函数**。
import { looksLikeAppendDetail } from './followUp.ts'
import { SETTLED_TASK_STATUS } from './jobKey.ts'
import type { KlingOutcome } from './klingStep.ts'

// ───────────────────────────── 认话 ─────────────────────────────

export interface VideoPlan {
  /** XXXXX:她要的那条视频是关于什么的(原话里摘出来,不改写)。 */
  subject: string
  /** 送给豆包的那一句(出一张参考图)。 */
  imageAsk: string
  /** 写进可灵的提示词。 */
  videoPrompt: string
}

/** 豆包那一句。只要一张图、适合作视频首帧 —— 多张时取哪张就成了猜。 */
export function imageAskOf(subject: string): string {
  return `请帮我生成一张图片:${subject}。画面完整、主体清晰,适合作为视频的第一帧,横版 16:9,不要文字和水印。只要一张。`
}

/**
 * ★ **可灵那一句以首帧为准,只写变化**(2026-10-13 傍晚,卡 J)。
 *
 * 10-12 那一版是「${subject}。镜头缓慢推进,主体自然地动起来,…」—— 前半句把画面又重述了一遍。
 * 维护者 10-13 核过:**贴进首帧格的参考图没被当首帧**(片子的第一帧与那张图不是同一画面),
 * 而他那边的智能分镜早就关着;第三方教程一致的建议是图生视频的提示词**只写动作与运镜、
 * 不重述画面、开头用运镜词**。提示词里再写一遍主体,等于让它按文字另画一遍。
 *
 * 所以这一句**一个主体字都不带**:先点明以这张图为第一帧、外观不变,再只说镜头与动作怎么变。
 * 第一步给豆包那句(`imageAskOf`)照旧带着主体 —— 那一句要的就是按主体出图。
 */
export const VIDEO_PROMPT_FIRST_FRAME = '以这张图为第一帧,构图、主体外观和光线保持不变。'

/** 运镜与动作那一截(她补的细节插在它之前)。 */
export const VIDEO_PROMPT_MOTION = '镜头缓慢推进,画面里的主体自然动起来,不换场景,不切镜头。'

/** 可灵那一句。模板写的(不调模型)。 */
export function videoPromptOf(): string {
  return `${VIDEO_PROMPT_FIRST_FRAME}${VIDEO_PROMPT_MOTION}`
}

/** 第二组是**「视频」后面那一截**(2026-10-13:「…的视频在屋檐上面」丢了「在屋檐上面」)。 */
const VIDEO_ASK = /(?:帮我|给我|替我|麻烦你?|请你?)?(?:做|生成|弄|搞|出|拍|制作)(?:一下)?(?:一)?(?:个|条|支|段|部)?(.+?)的?(?:短)?视频(.*)$/
/**
 * ★ **口吃 / 重复的引子**(2026-10-13 真机:「给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频」——
 * 她打断后两段被拼成一句送进来)。主体从**最后一个**「做 / 生成 + 量词」之后算:贪婪的 `^.*` 取的就是它。
 *
 * **要带量词才算引子**:主题里本来就有的动词不能剥(「小朋友做饭」里的「做」后面是「饭」,不是「一个」)。
 */
const REPEAT_LEAD = /^.*(?:帮我|给我|替我|麻烦你?|请你?)?(?:做|生成|弄|搞|出|拍|制作)(?:一下)?(?:一)?(?:个|条|支|段|部)\s*/
/** 主体开头 / 结尾的标点与空白(拼接来的那一句开头是个「。」)。 */
const EDGE_MARKS = /^[\s\p{P}]+|[\s。.!！?？,，、;；:：]+$/gu
/** 「视频」后面那一截是语气词 / 客套 —— 不是主体的一部分。 */
const TAIL_FILLER = /^(?:吧|啊|呀|呢|哦|噢|嘛|谢谢|谢了|好吗|可以吗|行吗|就行|就好|麻烦你|麻烦了)+$/u
/** 后半句接着说场景(「在屋檐上面」)—— 直接续在主体后面;别的那几种用逗号隔开。 */
const TAIL_SCENE = /^(?:在|到|从|往|向|朝|于|里|上|下)/u

/**
 * 「帮我做一个 XXX 的视频」→ 一份两步的计划。认不出就 `undefined`(照普通事项走,不硬套)。
 * 说了「剪」「发」「上传」的不算(那是剪映 / 发布那一类,不是生成)。
 *
 * 主体怎么取(2026-10-13 下午,场景 1 真机两句都在这儿出过错):
 *   · 口吃 / 重复的引子与开头的标点**剥掉**({@link REPEAT_LEAD});
 *   · 「视频」后面那一截**并进主体**({@link VIDEO_ASK} 第二组)—— 豆包那张参考图与可灵那句提示词
 *     都是从主体拼的,丢在这里就是两头都丢;语气词 / 客套不算。
 */
export function videoChainPlan(said: string): VideoPlan | undefined {
  const text = said.trim()
  if (/剪|发布|上传|发到|发给/.test(text)) return undefined
  const m = VIDEO_ASK.exec(text)
  if (m === null) return undefined
  const head = (m[1] ?? '').replace(REPEAT_LEAD, '').replace(EDGE_MARKS, '')
  const core = head.replace(/^(?:关于|有关|讲)/, '').replace(/[「」『』"“”]/g, '').trim()
  if (core.length < 2 || /^(?:这|那)(?:个|条)?$/.test(core)) return undefined
  const tail = (m[2] ?? '').replace(EDGE_MARKS, '').replace(/[「」『』"“”]/g, '').trim()
  const subject = [...tail].length < 2 || TAIL_FILLER.test(tail)
    ? core
    : `${core}${TAIL_SCENE.test(tail) ? '' : ','}${tail}`
  return { subject, imageAsk: imageAskOf(subject), videoPrompt: videoPromptOf() }
}

/**
 * ★ **她在电话里补的那一句并进可灵那句提示词**(2026-10-13,卡 G;傍晚卡 J 跟着改了插的位置)。
 *
 * 她说完「帮我做一个 X 的视频」之后 60 秒内补的那一句(「七八岁吧,穿小碎花连衣裙」)说的是**主体的细节**,
 * 所以插在**首帧那一句之后、运镜之前**({@link VIDEO_PROMPT_FIRST_FRAME});
 * 两句都认不出就接在末尾(可灵读的是整段)。
 * **原话不改写**:只去掉两头的标点,同一句补第二遍不接第二份。
 *
 * 主体那一句也认:**改口径之前落盘的那几份接力记录**,提示词还是以「${subject}。」开头的。
 */
export function promptWithDetail(input: { prompt: string, subject: string, said: string, nowMs?: number }): string {
  const prompt = input.prompt.trimEnd()
  const said = input.said.replace(EDGE_MARKS, '')
  if (said === '' || prompt.includes(said)) return prompt
  /*
   * ★ **不像一句描述的不并**(2026-10-13 晚,卡 P)。演示机 20:30 那一通里
   * 「帮我把待办的组件改为。」「的形式。」都并进来了 —— 可灵拿到的提示词里夹着两句切待办的话。
   * 判据与 8791 那一道同一个纯函数(`followUp.ts`),这里是第二道:
   * 真有这么一句送到这一层来,提示词也不许被它改掉(调用方照实只说「记在卡上了」)。
   */
  if (!looksLikeAppendDetail(said, input.nowMs === undefined ? undefined : { nowMs: input.nowMs })) return prompt
  for (const head of [VIDEO_PROMPT_FIRST_FRAME, `${input.subject}。`]) {
    if (prompt.startsWith(head)) return `${head}${said}。${prompt.slice(head.length)}`
  }
  return `${prompt}${said}。`
}

// ───────────────────────────── 落图 ─────────────────────────────

/**
 * 选题文件夹名:去掉路径里不能有的字,太长截短。
 * **不许以标点开头**(2026-10-13:拼接来的那一句让选题目录叫「。给我生成一个女孩子…」)。
 */
export function subjectDirName(subject: string): string {
  const clean = subject
    .replace(/[/\\:*?"<>|\n\r\t]/g, ' ')
    .replace(/^[\s\p{P}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean === '' ? '视频' : clean).slice(0, 30)
}

/** 参考图落在哪:`<工作目录>/选题/<XXX>/素材/参考图-<时刻>.<扩展名>`(选题那一套目录,`templates.ts` 的两个常量)。 */
export function referenceImagePath(root: string, subject: string, ext: string, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return join(root, TOPIC_DIR, subjectDirName(subject), TOPIC_ASSET_SUBDIR, `参考图-${stamp}.${ext}`)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// ───────────────────────────── 接力 ─────────────────────────────

export type ChainStage = 'image' | 'kling' | 'video' | 'done' | 'failed'

/**
 * 这一通按哪一档打(与 `protocol.ts` 的 `CallOutReason` 同名同义,只用得上这两个)。
 * `confirm` = 办完了等你验收;`failed` = 没办成,开场说实话、问她下一步怎么办。
 */
export type ChainCallReason = 'confirm' | 'failed'

/**
 * ★ **这一件最后怎么收**(2026-10-13,卡 D):卡上写什么、给工人念的那一句是什么、这一通打哪一档、卡挪到哪。
 *
 * 分成两句话是 10-13 真机逼出来的:卡上那句要留细节(片子在哪个文件夹、为什么没推成),
 * 而工人念的那一句**要短**(来电开场上限 42 字;`failed` 那一档只念第一个分号之前的那半句)。
 */
export interface ChainEnd {
  /** 卡上那句 note(细节留着)。 */
  card: string
  /** 给工人念的那一句(短;来电开场与通话插话都从它来)。 */
  say: string
  reason: ChainCallReason
  /** 卡挪到哪:办成了「等你确认」,没办成「阻塞 · 出错」(要她在可灵 / 手机上动一下)。 */
  status: 'confirm' | 'blocked'
}

export interface ChainRecord {
  item: string
  subject: string
  video_prompt: string
  stage: ChainStage
  /** 第一步派出去那一刻(毫秒):只认这之后才出现的图。 */
  since: number
  /** 缓存里看到的那张图(网址)与第一次看到它的时刻 —— 连着两拍还是它,才算出完了。 */
  image_url?: string
  image_seen_at?: number
  /** 上一步的产物:参考图落盘的路径。 */
  image_path?: string
  note?: string
  /** 前一条还占着可灵、这一条排上队那一刻(毫秒)。缺席 = 没排过队。 */
  queued_at?: number
  /**
   * 按下可灵那颗「生成」时的两个读数,**只为事后对账**(2026-10-13,卡 M)。
   *
   * 17:22 那条:卡上写着「已经在可灵里开始生成了」,可到 17:33 可灵页读窗里没有「创作中」、
   * 结果列里也没有它 —— 多半根本没提交成,却被判成了 `started`。判据只有一条
   * (`klingStep.KLING_STARTED_TEXT` 在读窗那几十行字里命中),所以把**命中的是哪一行**与
   * **壳用哪条路按的**存下来:下一次出这事,`video-chains.json` 一眼就看得出。
   */
  kling_how?: string
  kling_started_text?: string
  /**
   * ★ 按生成**之前**结果列里有几条做完的卡(2026-10-13 晚,卡 O)。
   * 等出片那一层拿它当底:多出一条 = 这一单做完了(可灵日志读不到时就剩这一条判据)。
   */
  kling_cards?: number
  /**
   * ★ 2026-10-13 晚(卡 Q),两格都**只为事后对账**:
   * `kling_image_wait` = 按生成之前没看出图传完(演示机那一单的片子与参考图无关,就是这么来的);
   * `kling_done_bar` = 按生成之前底部那条浮条的原文(「1/1 生成完成」)。
   */
  kling_image_wait?: string
  kling_done_bar?: string
}

/** 豆包那一步最多等多久(出一张图一般一分钟内)。 */
export const CHAIN_IMAGE_TIMEOUT_MS = 10 * 60 * 1000
/** 缓存里那张图连续这么久没换,就算出完了(豆包说完那一拍先到的话不用等)。 */
export const CHAIN_IMAGE_STABLE_MS = 6000
/**
 * 豆包说完了还没在缓存里看到图,再等这么久就如实说取不到。
 *
 * ★ **60 秒 → 3 分钟**(2026-10-14 14:11 演示机,卡 AF):新版豆包先把工具进度行当回话打出来
 * (那一单记下的回话原文是「查阅图像生成相关规则本地电脑项目按需确认技能插件」—— 进度行 + 泄进来的页签字),
 * `reply_state` 在它真开始画之前就判成 done;早上两次成功的图分别在派出后 53 / 69 秒进缓存,这一单 87 秒还没来,
 * 窗口就关了。「回完话」这个判据在新版豆包上不可靠,就别拿 60 秒去赌它;整条链的上限照旧 {@link CHAIN_IMAGE_TIMEOUT_MS}。
 */
export const CHAIN_IMAGE_AFTER_REPLY_MS = 3 * 60 * 1000
/**
 * ★ **豆包常「先回一句话、图再晚十几秒才进缓存」**(2026-10-13 17:24 真机:回话 :03,图 :15,3.4 MB)。
 * 回话里还说着「正在生成图片」时,取图那个窗口延到这么久({@link CHAIN_IMAGE_WORKING_TEXT})——
 * 它自己说还在画,这时说「没找到图」就是冤枉它。整条链的上限照旧是 {@link CHAIN_IMAGE_TIMEOUT_MS}。
 * ★ 3 → 5 分钟(2026-10-14,卡 AF):回完话那个窗口放到 3 分钟之后,这一档要比它长才有意义;链总上限 10 分钟不动。
 */
export const CHAIN_IMAGE_WORKING_MS = 5 * 60 * 1000
/**
 * 豆包回话里「我还在出图」那几个字。只认它自己打出来的状态字 ——
 * 真机那一条的尾巴是「…正在生成图片」(界面上的模式页签由 `dispatchReply.ts` 剔掉,这几个字留着)。
 *
 * ★ **新版豆包那一行要照着加**(2026-10-13 晚,卡 Q;演示机 20:55,模型页签写「豆包 2.1 Lite」):
 * 那一单回话是「调用工具生成图片本地电脑项目豆包 2.1 Lite中」——「调用工具生成图片…中」就是它的进度行,
 * 界面那几截由 `dispatchReply.ts` 剔掉之后剩「调用工具生成图片」。老词表一句都没命中,
 * 于是这一单按 60 秒窗口判了「没找到这一轮出的图」,而它其实还在出图。
 * 写成形状(「调用工具…生成图」「生成图片…中」),不逐字死抄演示机那一句。
 * ★ 2026-10-14 14:11 演示机又一种(卡 AF):「查阅图像生成相关规则…」—— 它在画之前先查规则,这一行也是「还在出图」。
 *
 * ⚠ 老版那一句「正在生成图片」**整行只有它**时已经被 `dispatchReply.A11Y_STATUS` 当状态行剔掉了(卡 F),
 * 所以老版机器上这一条实际只在它和回答挤在同一截里时才命中;新版那一行留在回话里(进度行不在状态词表里)。
 */
export const CHAIN_IMAGE_WORKING_TEXT = /正在生成图片|正在生成图像|图片生成中|正在画|正在为你生成|调用工具[^。\n]{0,8}生成图|生成图[片像][^。\n]{0,6}中|查阅[^。\n]{0,12}(图像|图片)|(图像|图片)生成相关/
export const CHAIN_PUMP_MS = 3000

/**
 * ★ **可灵那一步排着队时卡上那句**(2026-10-13,卡 M)。
 *
 * 可灵页只有一个:两条链同时贴图 / 写词 / 按生成就是互相盖,而 `waitKlingVideo` 判「哪条片子做完了」
 * 看的是**最上面那条结果卡** —— 两条同时等会把对方的片子当成自己的。所以后一条排着等。
 * **排队不是失败**:不打电话(来电只有 `confirm` / `failed` 两档,挑哪一档都是说错话)、卡不挪阻塞。
 */
export const CHAIN_KLING_QUEUED_NOTE = '前一条还在可灵里,排着,轮到了我接着往可灵里放'

/**
 * ★ **可灵自己那份日志读不到时,卡上补的那一句**(2026-10-13 晚,卡 O)。
 *
 * 演示机 20:35 那条断在「可灵做出来了、插件在等日志里的 AllTaskFinish」—— 那台的可灵版本 / 日志路径 /
 * 字段一样都没核过。现在读窗那条旁路照样走得完,但读不到日志这件事要在卡上说一句,别当没事发生。
 */
export const CHAIN_KLING_LOG_MISSING_NOTE = '可灵的日志读不到,这一单是按可灵页面上的样子判的'

export interface VideoChainDeps {
  tasks: {
    list: () => Promise<{ tasks: readonly TaskView[] }>
    update: (id: string, patch: Record<string, unknown>) => Promise<unknown>
    move: (id: string, status: TaskStatus) => Promise<unknown>
  }
  /** 第一步:普通派活(`dispatchItem`)。 */
  dispatch: (taskId: string, input: { family: string, text: string }) => Promise<{ ok: boolean, note: string }>
  /** 在豆包的本机缓存里找 `since` 之后出的那张图。 */
  findImage: (since: number) => Promise<CachedImage | undefined>
  /** 落图的根(她的工作目录);缺席 = 没配,退回 `fallbackRoot`。 */
  root: () => Promise<string | undefined>
  fallbackRoot: string
  writeFile: (path: string, body: Buffer) => Promise<void>
  /** 第二步:可灵。 */
  kling: (input: { imagePath: string, prompt: string }) => Promise<KlingOutcome>
  /**
   * ★ **出片之后**(2026-10-12 晚,维护者:「看到视频之后推到手机端上,再打个电话过来,并且可以在手机上(通话过程中)看到视频」)。
   * 三样都给了才走:等可灵出片并下下来(`klingStep.waitKlingVideo`)→ 复制进选题素材文件夹 → 推到她手机上 → 再打那一通。
   * 缺任何一样 = 老行为(进入生成就收卡、打那一通)。
   */
  fetchVideo?: (input: { since: number, cardsBefore?: number, doneBarBefore?: string }) => Promise<{ kind: 'ready', path: string, log_missing?: boolean } | { kind: 'failed', why: string, log_missing?: boolean }>
  copyFile?: (from: string, to: string) => Promise<void>
  pushToPhone?: (input: { item_id: string, path: string }) => Promise<{ ok: boolean, note: string }>
  /**
   * 收卡前排一通:在通话里就插一句,不在就是手机上一条(来电那一套自己定)。
   *
   * ★ `reason`(2026-10-13,卡 D):**按结果分档**。`confirm` 那一档的开场是定死的一句
   * 「老板,X 办完了,等你验收。」(`channel-worker/src/callOut.ts` `ringOpener`,**不看 note**)——
   * 10-13 14:06 下载没按成,回电照样说了这一句,他「给我看看」时没东西给。
   * 没办成就走 `failed`:那一档的开场念的是 note 收拾出来的那句人话(`plainFailureWhy`)+「你说下一步怎么办」。
   */
  announce?: (input: { item_id: string, title: string, note: string, reason: ChainCallReason }) => Promise<unknown>
  /**
   * ★ **「排着」这一句也给她听见,但不打电话**(2026-10-13,卡 M)。
   *
   * 来电那一套只有 `confirm`(办完了等你验收)与 `failed`(没办成,你说下一步怎么办)两档 ——
   * 排队两档都不是,随便挑一档都是说错话,而「不在通话时这一通不会消失」= 为一句进度把她手机打响。
   * 所以走现成那本**回答账**(`server/directAnswer.ts` → `/state.answers`:电脑事务官页球下那一处
   * 与手机那行字幕都在读它,两端「看过了」同步,落盘 24 小时),**不推系统通知、不响铃**。
   * 同一本账 10-13 已经在给「固定流程办掉却不建卡」的那几件留痕(`understoodTrace.ts`),协议一个字没改。
   * 缺席 = 只写卡。**绝不抛**由调用方保证。
   */
  trace?: (input: { item_id: string, title: string, text: string }) => void
  /** 接力记录落在哪(重启后接着走)。 */
  file: string
  now: () => number
  onChanged?: () => void
}

/**
 * ★ 她补的那一句**有没有真并进**可灵那句提示词(2026-10-13,卡 G)。调用方据此如实说落在哪:
 * `none` 这张卡不在接力里、`late` 提示词已经交出去了(或这条接力收场了)、
 * `not_detail` 这一句不像一句描述(卡 P,不并)、`added` 带上了。
 */
export type PromptAmend =
  | { kind: 'none' }
  | { kind: 'late', stage: ChainStage }
  /** ★ 这一句不像一句描述(2026-10-13 晚,卡 P):提示词一个字没动,调用方只说「记在卡上了」。 */
  | { kind: 'not_detail' }
  | { kind: 'added', prompt: string }

export interface VideoChain {
  load: () => Promise<void>
  /** 第一步派出去;派不出去照 `dispatch` 的那句话如实回。 */
  start: (taskId: string, plan: VideoPlan) => Promise<{ ok: boolean, note: string }>
  /**
   * ★ **她补的那一句并进这条接力的提示词**(2026-10-13,卡 G)。
   *
   * **只有豆包那一步还在走(`image`)时才改得动**:`handOff` 把 `stage` 挪成 `kling` 的下一行
   * 就把 `video_prompt` 交给可灵了,之后再改只是改一份没人读的记录 —— 那时回 `late`,
   * 由调用方如实说(豆包那一步已经派出去的那一句也不追)。
   */
  amendPrompt: (taskId: string, said: string) => Promise<PromptAmend>
  /** 这件事还有下一步(`dispatchRun` 据此不收卡)。 */
  owns: (taskId: string) => boolean
  /** 挂在 http.ts 那根节拍上;内部 3 秒一拍,没有在走的接力就一次 I/O 都不做。**绝不抛**。 */
  pump: () => Promise<void>
  view: () => readonly ChainRecord[]
}

/** 派活说「派出去了」那一句之外,告诉她这件事分两步。 */
export const CHAIN_STARTED_NOTE = (subject: string): string =>
  `分两步办:先让豆包出一张「${subject}」的参考图,图出来我拿去可灵里生成视频`

/** 接力记录留几条(内存与落盘同一个数)。 */
export const CHAIN_RECORDS_KEEP = 50

export function createVideoChain(deps: VideoChainDeps): VideoChain {
  let records: ChainRecord[] = []
  let lastPump = 0
  /** 这一刻正有人在走的那几条(一条一把锁:`pump` 这一拍跳过它们)。 */
  const running = new Set<string>()
  /** 可灵那一步的那一道闸:占着的是哪一件 + 排着的那几条(见 {@link CHAIN_KLING_QUEUED_NOTE})。 */
  let klingHolder: string | undefined
  const klingLine: { item: string, go: () => void }[] = []
  /** 落盘排成一队:两条链同时写同一个 `.tmp` 会抢(写完的那一下互相改名)。 */
  let persisting: Promise<void> = Promise.resolve()

  async function persist(): Promise<void> {
    persisting = persisting.then(async () => {
      await mkdir(dirname(deps.file), { recursive: true })
      const tmp = `${deps.file}.tmp`
      await writeFile(tmp, JSON.stringify({ chains: records.slice(-CHAIN_RECORDS_KEEP) }, null, 2))
      await rename(tmp, deps.file)
    }, async () => {})
    await persisting
  }

  /**
   * 记录里去掉「排着」那一格:轮到它了。
   * 重启后那一句话据此分得出「还排着(一下都没按)」与「真按过了」({@link VideoChain.load})。
   */
  function leaveQueue(item: string): void {
    const at = records.findIndex(one => one.item === item)
    if (at < 0) return
    const { queued_at: _left, ...rest } = records[at] as ChainRecord
    records[at] = rest
  }

  /**
   * 占可灵那一步,或者排进队里。
   *
   * **「看一眼空没空」与「排进队」必须在同一步里做完**(中间不许有 `await`):隔着一个 `await`
   * 的话,前一条正好在这当中走完 —— 它放闸时队里还没有我们,我们再排进去就永远没人叫了。
   * 回 `undefined` = 这一刻就归它;回一个承诺 = 排上了,轮到它时那个承诺兑现。
   */
  function takeKling(item: string): Promise<void> | undefined {
    if (klingHolder === undefined) {
      klingHolder = item
      return undefined
    }
    return new Promise<void>((resolve) => { klingLine.push({ item, go: resolve }) })
  }

  /** 可灵那一步交给下一条。**交接那一刻不留空档**:别让第三条插在中间。 */
  function freeKling(item: string): void {
    if (klingHolder !== item) return
    const next = klingLine.shift()
    klingHolder = next?.item
    next?.go()
  }

  function patch(item: string, next: Partial<ChainRecord>): ChainRecord | undefined {
    const at = records.findIndex(one => one.item === item)
    if (at < 0) return undefined
    records[at] = { ...records[at] as ChainRecord, ...next }
    return records[at]
  }

  async function fail(record: ChainRecord, note: string, moveBlocked: boolean): Promise<void> {
    patch(record.item, { stage: 'failed', note })
    await deps.tasks.update(record.item, { note }).catch(() => undefined)
    if (moveBlocked) {
      await deps.tasks.move(record.item, 'blocked').catch(() => undefined)
      await deps.tasks.update(record.item, { blockReason: 'error' }).catch(() => undefined)
    }
  }

  /** 第一步收尾:落图 → 卡上挂这张图、停掉盯窗 → 交给可灵 → 收卡。 */
  async function handOff(record: ChainRecord, task: TaskView, image: CachedImage): Promise<void> {
    const root = (await deps.root().catch(() => undefined)) ?? deps.fallbackRoot
    const path = referenceImagePath(root, record.subject, image.info.ext, new Date(deps.now()))
    try { await deps.writeFile(path, image.body) }
    catch (error) {
      await fail(record, `豆包的图出来了,但没存进「${dirname(path)}」(${error instanceof Error ? error.message : String(error)})—— 图在豆包里`, true)
      return
    }
    patch(record.item, { stage: 'kling', image_path: path })
    await persist()
    const dispatch = task.client_dispatch
    await deps.tasks.update(record.item, {
      // 第一步到此为止:盯窗那条巡检不再读豆包(它看 `reply_state`)。
      ...(dispatch === undefined ? {} : { clientDispatch: { ...dispatch, reply_state: 'done', reply_at: new Date(deps.now()).toISOString() } }),
      deliverables: [...(task.deliverables ?? []), { kind: 'file', ref: path }],
      note: `${gotImageNote(path)},正在放进可灵`,
    }).catch(() => undefined)
    deps.onChanged?.()

    /*
     * ★ **可灵那一步同一时刻只许一条链走**(2026-10-13,卡 M;理由见 {@link CHAIN_KLING_QUEUED_NOTE})。
     * 前一条还占着就排着等 —— 不超时失败、不打电话,卡上写明在排;轮到了接着走。
     */
    const wait = takeKling(record.item)
    if (wait !== undefined) {
      const note = `${CHAIN_KLING_QUEUED_NOTE};${gotImageNote(path)}`
      patch(record.item, { note, queued_at: deps.now() })
      await persist().catch(() => undefined)
      await deps.tasks.update(record.item, { note }).catch(() => undefined)
      try { deps.trace?.({ item_id: record.item, title: `${record.subject}的视频`, text: CHAIN_KLING_QUEUED_NOTE }) }
      catch { /* 留一行痕迹失败不该把这条链拦下来 */ }
      deps.onChanged?.()
      await wait
    }
    try { await intoKling(record, path, wait !== undefined) }
    finally { freeKling(record.item) }
  }

  /** 卡上那半句:图拿到了、落在哪。 */
  function gotImageNote(path: string): string {
    return `参考图拿到了(${path})`
  }

  /** 轮到这一条了:图和提示词交给可灵 → 进入生成(或接着等片子)→ 收卡。 */
  async function intoKling(record: ChainRecord, path: string, queued: boolean): Promise<void> {
    if (queued) {
      /*
       * 排着这几分钟里她可能把卡取消 / 收了:轮到了**先看一眼**,收场了就一下都不碰可灵
       * (与 `step` 开头那一道同一个判据)。读不到看板时照走 —— 不知道不等于收场了。
       */
      const seen = await deps.tasks.list().then(one => one.tasks.find(two => two.id === record.item)).catch(() => undefined)
      if (seen !== undefined && SETTLED_TASK_STATUS.includes(seen.status)) {
        patch(record.item, { stage: 'failed', note: '这件事收场了,接力停下' })
        await persist().catch(() => undefined)
        return
      }
      leaveQueue(record.item)
      await deps.tasks.update(record.item, { note: `${gotImageNote(path)},轮到它了,正在放进可灵` }).catch(() => undefined)
      deps.onChanged?.()
    }

    const pressedAt = deps.now()
    const outcome = await deps.kling({ imagePath: path, prompt: record.video_prompt })
      .catch((error: unknown): KlingOutcome => ({ kind: 'failed', step: 'open', why: error instanceof Error ? error.message : String(error) }))
    const where = `参考图在选题「${subjectDirName(record.subject)}」的素材文件夹里`
    if (outcome.kind === 'failed') {
      // 原因放前面:工人 `plainFailureWhy` 只念第一个分号之前那半句(10-13 真机念成了「参考图在…文件夹里」,原因被丢了)。
      await fail(record, `${outcome.why};${where}`, true)
      await persist()
      return
    }
    // 按下那一下的几个读数存进记录,只为事后对账(见 {@link ChainRecord.kling_how})。
    patch(record.item, {
      kling_how: outcome.how,
      ...(outcome.seen === undefined ? {} : { kling_started_text: outcome.seen }),
      ...(outcome.cards === undefined ? {} : { kling_cards: outcome.cards }),
      ...(outcome.imageWait === undefined ? {} : { kling_image_wait: outcome.imageWait }),
      ...(outcome.doneBar === undefined ? {} : { kling_done_bar: outcome.doneBar }),
    })
    /*
     * ★ **没看出图传完就按了生成**(2026-10-13 晚,卡 Q):写在卡上(演示机那一单的片子与参考图无关,
     * 事后要看得出来),**不进念的那一句** —— 来电开场 42 字留给最要紧的事(与 `log_missing` 同一个取舍)。
     */
    const slow = outcome.imageWait === undefined ? '' : `;${outcome.imageWait}`
    const entered = `${where},已经在可灵里开始生成了`
    let end: ChainEnd = { card: `${entered}${slow}`, say: entered, reason: 'confirm', status: 'confirm' }
    const videoAfter = deps.fetchVideo !== undefined && deps.copyFile !== undefined && deps.pushToPhone !== undefined
    if (videoAfter) {
      // 进入生成只写在卡上、不打电话:出片推过去那一通才打(几分钟里不响两回)。
      const waiting = `${entered}${slow};出片了我推到你手机上,再打给你`
      patch(record.item, { stage: 'video', note: waiting })
      await persist()
      await deps.tasks.update(record.item, { note: waiting }).catch(() => undefined)
      deps.onChanged?.()
      end = await deliverVideo(record, pressedAt, outcome.cards, outcome.doneBar)
    }
    patch(record.item, { stage: end.status === 'confirm' ? 'done' : 'failed', note: end.card })
    await persist()
    // 可灵框里原来那段字被盖掉了:原文挂在卡上(不念、不进那一通电话)。
    if (outcome.replaced !== undefined) {
      const fresh = (await deps.tasks.list().catch(() => ({ tasks: [] as TaskView[] }))).tasks.find(one => one.id === record.item)
      await deps.tasks.update(record.item, {
        deliverables: [...(fresh?.deliverables ?? []), { kind: 'reply', ref: `可灵提示词框里原来有一段字,被这次盖掉了,原文:${outcome.replaced}` }],
      }).catch(() => undefined)
    }
    /*
     * 先排那一通(带这句话),再挪卡:看板那一拍按同一个键(`<理由>:<事项 id>`)认出「排过了」,不会再排一通不带话的。
     * **没办成那一通排 `failed`,卡也只能挪「阻塞 · 出错」**(2026-10-13):看板那一拍只为
     * 「阻塞 · 出错」排 `failed`、为「等你确认」排 `confirm` —— 排了 `failed` 又把卡挪进「等你确认」,
     * 自动那一拍会接着排一通 `confirm`(「办完了,等你验收」),等于把刚说实话的那句又盖回去。
     * 标题不带书名号:来电那一句自己会加「」(10-12 真跑念成了「「…」的视频」)。
     */
    await deps.announce?.({ item_id: record.item, title: `${record.subject}的视频`, note: end.say, reason: end.reason }).catch(() => undefined)
    await deps.tasks.update(record.item, { note: end.card }).catch(() => undefined)
    await deps.tasks.move(record.item, end.status).catch(() => undefined)
    if (end.status === 'blocked') await deps.tasks.update(record.item, { blockReason: 'error' }).catch(() => undefined)
  }

  /**
   * 出片 → 下下来 → 复制进选题素材文件夹 → 挂卡上 → 推到她手机上。回「这一件最后怎么收」。
   *
   * ★ 2026-10-13:**片子没拿到手、或者没推到她手机上,就不是「办完了」** —— 回 `failed` 那一档,
   * 开场那一句才会说实话(10-13 14:06 下载没按成,回电照样说「办完了,等你验收」,他「给我看看」时没东西给)。
   */
  async function deliverVideo(record: ChainRecord, pressedAt: number, cardsBefore?: number, doneBarBefore?: string): Promise<ChainEnd> {
    const folder = `选题「${subjectDirName(record.subject)}」的素材文件夹里`
    const video = await (deps.fetchVideo as NonNullable<VideoChainDeps['fetchVideo']>)({
      since: pressedAt,
      ...(cardsBefore === undefined ? {} : { cardsBefore }),
      // ★ 按生成之前那条浮条(卡 Q):等出片那一层判「又做完一条」比的是它变没变。
      ...(doneBarBefore === undefined ? {} : { doneBarBefore }),
    })
      .catch((error: unknown) => ({ kind: 'failed' as const, why: error instanceof Error ? error.message : String(error) }))
    /*
     * ★ 可灵那份日志一次都没读到(演示机那台的版本 / 路径还没核过)→ 卡上补一句,**不进念的那一句**:
     * 她该知道这一单是按页面上的样子判的,但电话里那 42 个字要留给最要紧的事。
     */
    const why = (video as { log_missing?: boolean }).log_missing === true ? `;${CHAIN_KLING_LOG_MISSING_NOTE}` : ''
    if (video.kind === 'failed') {
      // `why` 已经是一句人话(`waitKlingVideo` 拼的),工人念的就是它 —— 卡上再补一句参考图在哪。
      return { card: `${video.why};参考图在${folder}${why}`, say: video.why, reason: 'failed', status: 'blocked' }
    }
    const root = (await deps.root().catch(() => undefined)) ?? deps.fallbackRoot
    const ext = /\.(mp4|mov|m4v)$/i.exec(video.path)?.[1]?.toLowerCase() ?? 'mp4'
    const target = referenceImagePath(root, record.subject, ext, new Date(deps.now())).replace(/参考图-(\d{8}-\d{6})\.\w+$/, `视频-$1.${ext}`)
    let kept = video.path
    try { await (deps.copyFile as NonNullable<VideoChainDeps['copyFile']>)(video.path, target); kept = target }
    catch { /* 复制不过来就用可灵下好的那一份(在「下载」文件夹) */ }
    const fresh = (await deps.tasks.list().catch(() => ({ tasks: [] as TaskView[] }))).tasks.find(one => one.id === record.item)
    await deps.tasks.update(record.item, { deliverables: [...(fresh?.deliverables ?? []), { kind: 'file', ref: kept }] }).catch(() => undefined)
    const pushed = await (deps.pushToPhone as NonNullable<VideoChainDeps['pushToPhone']>)({ item_id: record.item, path: kept })
      .catch((error: unknown) => ({ ok: false, note: error instanceof Error ? error.message : String(error) }))
    const saved = kept === target ? `存在${folder}` : '在「下载」文件夹里'
    /*
     * 念的那一句**只说最要紧的一件**:来电开场上限 42 字,而「失败」那一档只念第一个分号之前的半句。
     * 片子在哪、为什么没推成,留在卡上。
     */
    return pushed.ok
      ? { card: `视频好了,已经推到你手机上;${saved}${why}`, say: '视频好了,已经推到你手机上', reason: 'confirm', status: 'confirm' }
      : { card: `视频好了,没推到你手机上;${saved};没推成的原因:${pushed.note}${why}`, say: '视频好了,没推到你手机上', reason: 'failed', status: 'blocked' }
  }

  async function step(record: ChainRecord, task: TaskView | undefined): Promise<void> {
    if (task === undefined || SETTLED_TASK_STATUS.includes(task.status)) {
      // 她把卡取消 / 收了:接力停下,一下都不再动她的豆包和可灵。
      patch(record.item, { stage: 'failed', note: '这件事收场了,接力停下' })
      return
    }
    const now = deps.now()
    const dispatch = task.client_dispatch
    // 第一步压根没派出去 / 派活自己判了失败:卡上已经有那一句了,接力不再说第二句。
    if (task.status === 'blocked' && dispatch?.reply_state !== 'done') {
      patch(record.item, { stage: 'failed', note: '第一步没走通' })
      return
    }
    const image = await deps.findImage(record.since).catch(() => undefined)
    const replied = dispatch?.reply_state === 'done'
    if (image !== undefined) {
      if (record.image_url !== image.url) {
        patch(record.item, { image_url: image.url, image_seen_at: now })
        if (!replied) return
      }
      const seenAt = record.image_seen_at ?? now
      if (replied || now - seenAt >= CHAIN_IMAGE_STABLE_MS) await handOff(record, task, image)
      return
    }
    const replyAt = dispatch?.reply_at === undefined ? Number.NaN : Date.parse(dispatch.reply_at)
    /*
     * ★ **它自己说还在出图就接着等**(2026-10-13,卡 M):真机 17:24:03 豆包先回了一句话
     * (末尾带「正在生成图片」),图 17:24:15 才进缓存 —— 回话判 done 之后那一分钟是为
     * 「只回了文字、不打算出图」留的,不该用来卡这十几秒。读的是回话原文那一格,没有新的读窗。
     */
    const waitFor = CHAIN_IMAGE_WORKING_TEXT.test(dispatch?.reply ?? '') ? CHAIN_IMAGE_WORKING_MS : CHAIN_IMAGE_AFTER_REPLY_MS
    if (replied && !Number.isNaN(replyAt) && now - replyAt > waitFor) {
      await fail(record, '豆包回话了,但在它的本机缓存里没找到这一轮出的图 —— 图要你从豆包里拖出来', true)
      return
    }
    if (now - record.since > CHAIN_IMAGE_TIMEOUT_MS) {
      await fail(record, `等了 ${Math.round(CHAIN_IMAGE_TIMEOUT_MS / 60_000)} 分钟没等到豆包出的图 —— 要你到豆包里看一眼`, true)
    }
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(deps.file, 'utf8')) as { chains?: unknown }
        records = (Array.isArray(raw.chains) ? raw.chains.filter((one): one is ChainRecord => typeof one === 'object' && one !== null && typeof (one as ChainRecord).item === 'string') : [])
          /*
           * 可灵那一步走到一半工作台重启了:不知道按没按下去,不重按(按两次是两份额度)。
           * **还排着队的那一条说法不一样**(2026-10-13,卡 M):它一下都没按,可灵里没有它的东西 ——
           * 叫她去可灵里看一眼就是让她白跑一趟(`queued_at` 在轮到它那一下就去掉了)。
           */
          .map(one => one.stage === 'kling' || one.stage === 'video'
            ? {
                ...one,
                stage: 'failed' as const,
                note: one.queued_at === undefined
                  ? '工作台重启时可灵那一步还没走完,要你到可灵里看一眼'
                  : '工作台重启时它还排着队等可灵,一下都没按 —— 参考图在选题文件夹里,要你自己放进可灵',
              }
            : one)
      }
      catch { records = [] }
    },

    async start(taskId, plan) {
      const record: ChainRecord = { item: taskId, subject: plan.subject, video_prompt: plan.videoPrompt, stage: 'image', since: deps.now() }
      // 内存里也只留最近 CHAIN_RECORDS_KEEP 条(落盘那份早就只留这么多;2026-10-19 起两边一致)。
      records = [...records.filter(one => one.item !== taskId), record].slice(-CHAIN_RECORDS_KEEP)
      await persist().catch(() => undefined)
      const sent = await deps.dispatch(taskId, { family: 'doubao', text: plan.imageAsk })
      if (!sent.ok) {
        patch(taskId, { stage: 'failed', note: sent.note })
        await persist().catch(() => undefined)
        return sent
      }
      return { ok: true, note: `${CHAIN_STARTED_NOTE(plan.subject)}。${sent.note}` }
    },

    async amendPrompt(taskId, said) {
      const text = said.trim()
      const record = records.find(one => one.item === taskId)
      if (record === undefined || text === '') return { kind: 'none' }
      if (record.stage !== 'image') return { kind: 'late', stage: record.stage }
      // ★ 卡 P:不像一句描述的不并(与 8791 那一道同一个纯函数),回 `not_detail` 让调用方说实话。
      if (!looksLikeAppendDetail(text, { nowMs: deps.now() })) return { kind: 'not_detail' }
      const prompt = promptWithDetail({ prompt: record.video_prompt, subject: record.subject, said: text })
      if (prompt === record.video_prompt) return { kind: 'added', prompt }
      patch(taskId, { video_prompt: prompt })
      await persist().catch(() => undefined)
      return { kind: 'added', prompt }
    },

    owns(taskId) {
      return records.some(one => one.item === taskId && (one.stage === 'image' || one.stage === 'kling' || one.stage === 'video'))
    },

    /*
     * ★ **链与链不互相等**(2026-10-13,卡 M;真机 17:22–17:28)。
     *
     * 从前这里是一个 `pumping` 总闸 + 一个顺序的 `for await`:第一条走进可灵那一步(`step` 里
     * `deps.kling` 与等片子最长 20 + 2 分钟)之后,第二条的 `step` **一次都没跑到** ——
     * 豆包给它出的图早就在缓存里,10 分钟的取图窗口就那么过期了。
     *
     * 现在**每条链各起各的 `step`**,锁只锁到「这一条」(`running`):一条在可灵里等,
     * 别的照样取图、落图、派豆包。**同一条不重入**(上一拍还没回来的这一拍跳过它)。
     * 可灵那一步另有一道闸(只许一条,见 {@link CHAIN_KLING_QUEUED_NOTE})。
     */
    async pump() {
      const now = deps.now()
      if (now - lastPump < CHAIN_PUMP_MS) return
      const due = records.filter(one => one.stage === 'image' && !running.has(one.item)).map(one => one.item)
      if (due.length === 0) return
      lastPump = now
      let tasks: readonly TaskView[]
      try { tasks = (await deps.tasks.list()).tasks }
      catch { return /* 看板读不到:这一拍什么都不做(绝不抛) */ }
      for (const item of due) running.add(item)
      await Promise.all(due.map(async (item) => {
        try {
          const record = records.find(one => one.item === item)
          if (record !== undefined && record.stage === 'image') await step(record, tasks.find(one => one.id === item))
        }
        catch { /* 一件坏了不连累别的 */ }
        finally { running.delete(item) }
      }))
      await persist().catch(() => undefined)
      deps.onChanged?.()
    },

    view: () => records,
  }
}
