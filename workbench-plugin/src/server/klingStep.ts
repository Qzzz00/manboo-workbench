/**
 * **把一张图和一句提示词交给可灵桌面版、按下生成**(2026-10-12,卡「演示 · 出图进可灵」;周三 10-14 演示)。
 *
 * 只走这一条路,每一步都有它自己的出处:
 *
 * 1. **在可灵当前那个标签页里,按名字点到「视频生成」那一页**:左侧导航那条「生成」(`AXLink`)→ 顶上「视频生成」页签(`AXGroup`)。
 *    就是维护者 10-12 圈出来的那条路。**不再用可灵自带的 `klingai://Omni-video` 入口**:10-12 端到端真跑,它每跑一次就
 *    **新开一个「可灵 Omni」标签页**,而背后几个标签页的按键也都在辅助功能树里、位置一模一样 —— 两颗「生成」分不出哪颗在前面,
 *    壳一颗都不敢点;Omni 那一页的提示词框壳也认不出(字写进了另一个标签页)。而且它带过去的图会丢。
 * 1′. **图:粘贴进去**(维护者原话「复制粘贴进可灵」;壳 `paste_image`,她的剪贴板先存后还)。
 * 2. **提示词:壳现成的 `send_text`**(`submit:false`,只写不发)—— 与派活送字同一套找输入框、粘贴。
 * 3. **生成:壳现成的 `agent_press`** 按名字找那颗键(按辅助功能角色 + 名字,不写死坐标):先叫到台前,
 *    按得动就 AXPress,按不动才在那颗键上合成点一下 —— 与「替她点选项」同一道边界(只在这一次派活、窗口在台前时)。
 *    认不准 / 两颗都叫这个名字就一颗都不点,如实说。
 *
 * **进入生成就算完成**(维护者 10-12):不等视频出来。
 *
 * ★ **「进了生成」的判据 2026-10-13 晚收紧了**(卡 O;本机 17:22 与演示机 20:31 各栽了一次):
 * 按之前先读一眼留个底,按完 2 / 5 / 10 秒各读一眼,只有**新出现**的「创作中 / 排队 / 预计…」行
 * 或者结果列里**多了一条**卡才算 `started`。看不到时分两种(统筹 21:2x 收窄):
 * **页面明显被重置**(首帧格空了 / 提示词没了)→ 少哪样补哪样、再按一次;
 * **图和词都还在**→ 一下都不补按,接着等 90 秒(日志 `AllTaskFinish` / 新那行 / 结果卡变多,任一算它接下了),
 * 等不到才 `failed` 说实话(从前这一档叫 `pressed`,照旧收卡说「办完了」)。
 *
 * ★ **贴完图要等它真传完才写词、按生成**(2026-10-13 晚,卡 Q)。演示机那一单坐实了:
 * 自动那一回出来的片子与参考图无关,维护者在同一页(首帧格已有图)手按「60 生成」就按参考图生成了。
 * 判据与时长见 {@link KLING_UPLOAD_TICK_MS} 那一段;等不出来**不拦路**,卡上留一句
 * {@link KLING_IMAGE_SLOW_NOTE}(或读不到窗那一句)。
 *
 * **10-12 端到端真跑通过一次**(第五轮;维护者命题「生成花海中的大叔漫步的视频」):豆包出图 → 缓存取原图 → 可灵当前页点到
 * 「视频生成」→ 贴图 → 写提示词 → 按「60 生成」→ 可灵任务卡上出现「排队中 / 创作中,预计等待 1 分钟」,点数 728 → 668,
 * 提示词进了任务。前四轮撞到的坑(新开标签页、同名键、页签走不到、框里旧字、被藏起来)都写在交接里。
 */

import { helperOutcome } from './dispatchClient.ts'

export const KLING_BUNDLE = 'com.electron.klingai'

/**
 * 生成键叫什么(2026-10-12 本机真量,可灵 1.3.27 视频生成页):页面底部一颗 `AXButton`「生成」。
 * 左侧导航里还有一条 `AXLink` 也叫「生成」—— 所以按的时候带上角色 {@link KLING_GENERATE_ROLE},
 * 不带的话壳认成「两处都像」、一处都不点。后几个名字是可灵改版时的退路。
 */
export const KLING_GENERATE_LABELS: readonly string[] = ['生成', '立即生成', '生成视频', '开始生成']
export const KLING_GENERATE_ROLE = 'AXButton'
/** 按下之后窗口里出现这些字 = 已经进了生成(10-12 真量:「排队中」「创作中」「创作中,预计等待 1 分钟」)。 */
export const KLING_STARTED_TEXT = /生成中|排队|队列中|预计.{0,6}(分钟|秒)|正在生成|创作中|\d{1,2}%/

/**
 * ★ **首尾帧那一格的两句文案**(10-12 本机真量)。
 *
 * 空着时写「添加 首尾帧图」,首帧贴上了变成「添加 尾帧图(可选)」—— 这是「图到底进去了没有」
 * 唯一读得出来的判据(壳回包只说它把 ⌘V 发出去了)。页面重载过也看这一格:它会变回空的那一句。
 */
export const KLING_FRAME_EMPTY_TEXT = /添加\s*首尾帧图/
export const KLING_FRAME_FILLED_TEXT = /添加\s*尾帧图/

/**
 * ★ **贴完图要等它真传完才写词、按生成**(2026-10-13 晚,卡 Q)。
 *
 * 演示机那一单坐实了:自动那一回出来的片子与参考图无关,维护者**在同一页手按那颗「60 生成」**
 * 就按参考图生成了 —— 参考图 3–5 MB,传到可灵要几秒,传完之前按下去等于没图。
 * 读得出来的三样(21:5x 演示机截图原字,上传过程中长什么样**还没量过**):
 * - 首帧那一格不再是「添加 首尾帧图」({@link KLING_FRAME_EMPTY_TEXT});
 * - 页面上没有「上传中 / 正在上传 / uploading」那类字,也没有**新冒出来**的一行光百分比;
 * - 底部那颗生成键读回来**带点数**(「🔥 60 生成」;17:27 图没进去时读回来是光一个「生成」)。
 *
 * 一秒读一眼,**最少等六秒**(第一眼就齐也不立刻按:那一眼可能是贴之前的旧画面),最多 20 秒。
 *
 * ★ 维护者 22:2x 真机(演示机截图):**生成键一直是「60 生成」,上传中也不变**,它不是信号;
 * 唯一看得见的是首帧格里先转一个 loading、再显示整图 —— 而壳读窗只读得到文字,读不到图片与 loading。
 * 所以「首帧格文案变了」很可能一贴就成立,文字判据对上传这几秒基本是盲的,**靠的是这个最短等待**:
 * 3–5 MB 的图传完一般两三秒,留到六秒;真文案量到之前别把它缩回去(彩排 0.6 的 3′)。
 */
export const KLING_UPLOAD_TICK_MS = 1000
export const KLING_UPLOAD_MIN_MS = 6000
export const KLING_UPLOAD_MAX_MS = 20_000
export const KLING_UPLOADING_TEXT = /上传中|正在上传|上传…|uploading/i
/** 整行只有一个百分比(「43%」):贴图之前就有的是旧那条创作中的进度,**多出来**一行才算这张图在传。 */
const KLING_BARE_PERCENT = /^\s*\d{1,3}\s*%\s*$/
/**
 * 底部那颗生成键那一行:emoji / 点数之外没有别的字(「🔥 60 生成」「生成」)。
 * 带数字 = 这一格的东西齐了;光一个「生成」= 还不齐。
 * 页签「视频生成」、那一行「绑定主体,增强生成一致性」都不是它(前面有字)。
 */
const KLING_KEY_ROW = /^[^\p{L}\p{N}]{0,4}\s*(\d{1,4})?\s*生成$/u
/** 等满 20 秒还看不出图传完:照旧按(不新增拦路),卡上留这一句。 */
export const KLING_IMAGE_SLOW_NOTE = '图可能没传完就按了生成(等了 20 秒没看出可灵收下这张图)'
/** 等那一段一行字都读不到:「看不出来」与「没传完」是两件事。 */
export const KLING_IMAGE_UNREADABLE_NOTE = '按生成之前读不到可灵的窗口,图传完没传完看不出来'

/**
 * ★ **页面底部那条浮条**(2026-10-13 晚 21:5x 演示机截图原字:「1/1 生成完成 回到顶部」;卡 Q)。
 *
 * 「做完了」的强信号,但**不能光看它在不在** —— 她上一回生成留下的那条也写着「1/1 生成完成」。
 * 所以按生成之前先读一眼留底,等出片那一层判的是「跟那一眼**不一样**」(没有 → 有,或者 1/1 → 2/2)。
 * 那条浮条带着「回到顶部」,顺带坐实了卡 D / 卡 O 的前提:新做完的卡在结果列**最上面**。
 */
export const KLING_DONE_BAR_TEXT = /\d{1,3}\s*\/\s*\d{1,3}\s*生成完成/

/**
 * ★ **按完在这几个时刻各读一眼**(毫秒,从按下那一刻算;2026-10-13 晚,卡 O)。
 *
 * 10-13 17:22 真机那条的教训:按完只读一眼、而且「尾巴里命中任意一行」就算开始了 ——
 * 那一轮可灵页其实在报错重载(首帧与提示词被清空),页面别处一行旧字就把它判成了 `started`。
 * 现在按前先读一眼留个底,按完 2 秒 / 5 秒 / 10 秒各读一眼,只认**新出现**的那一行。
 */
export const KLING_WATCH_AT_MS: readonly number[] = [2000, 5000, 10_000]
/** 结果列里多了一条卡 = 它接下了(这一行不是页面上的字,只用来说明判据)。 */
export const KLING_STARTED_BY_CARD = '结果列里多了一条'
/** 可灵自己的日志里记了「创作完成」= 它早就接下了(晚来的那一条判据)。 */
export const KLING_STARTED_BY_LOG = '可灵日志里记了创作完成'
/**
 * ★ **没读到新一条、但页面上图和词都还在:接着等,不补按**(2026-10-13 晚 21:2x,统筹收窄本卡的补救)。
 *
 * 可灵的日志里**没有「提交了任务」这种记号**(今天只有 `AllTaskFinish` 与 `OrderPaid` 两种),
 * 「接没接单」只能靠读窗,而读窗那一行**在演示机上还没量过** —— 台上多按一次生成
 * (两份额度、可灵里两条任务)比多等一会儿更糟。所以只有**页面明显被重置**(首帧格空了 / 提示词没了)才补按;
 * 两样都还在就转入这里等:一拍 5 秒、最多 18 拍 ≈ 90 秒,等到就当它早就接下了。
 */
export const KLING_LATE_TRIES = 18
export const KLING_LATE_TICK_MS = 5000
/** 没接单那一句人话(维护者 10-13 晚:「这是演示啊,可不能报错」—— 说实话,并且说清她该点哪一下)。 */
export const KLING_NOT_TAKEN_WHY = '可灵没接下这一单,参考图和提示词都放好了,你在可灵里点一下生成'
/**
 * ★ **窗口一行字都读不到时那一句**(2026-10-13 晚,卡 O)。
 *
 * 「读不到」与「它没接下」是两件事:壳读不到可灵(藏着、树停住、尾巴空)时,这一下多半是进去了的。
 * 这时**不补按**(补按就是真生成两条),也不说成开始了 —— 如实说一句,让她看一眼。
 */
export const KLING_UNREADABLE_WHY = '按了可灵的生成,可是读不到可灵的窗口,看不出它接没接下 —— 你在可灵里看一眼'
/** 图没贴进去那一句人话。 */
export const KLING_IMAGE_MISSING_WHY = '参考图没贴进可灵,图在选题文件夹里'
/** 核「提示词还在框里没有」时拿前几个字去尾巴里找(整句太长,尾巴常被截断)。 */
export const KLING_PROMPT_HEAD = 20

/**
 * 到「视频生成」那一页要按的两下(10-12 本机真量,可灵 1.3.27):左侧导航的「生成」是 `AXLink`,
 * 顶上那一排「图片生成 / 视频生成 / 动作控制 / 数字人」是带 AXPress 的 `AXGroup`。
 */
/** 导航那两下各看几眼(页面没画完 / 刚被藏起来时第一眼常常找不到)。 */
export const KLING_NAV_TRIES = 12
export const KLING_NAV: readonly { label: string, role: string }[] = [
  { label: '生成', role: 'AXLink' },
  { label: '视频生成', role: 'AXGroup' },
]

/**
 * ★ **就绪轮询一拍多长**(2026-10-13,卡 D)。
 *
 * 10-12 那一版在开页、导航、等输入框、清帧、贴图、写词之间全是固定 `sleep(1500)`,维护者 10-13 真机看到的是
 * 「切到可灵之后等了 5、6 秒才动」。现在每一步**读到就绪就走**,读不到才等一拍;
 * 每个等待的**上限按真花掉的时间算**(等 + 那一次 op),与 10-12 那一版一样,没放宽。
 */
export const KLING_TICK_MS = 400
/**
 * 等提示词框最多几拍。**上限按真花掉的时间算**:一拍 = 400 毫秒的等 + 一次 `focus_input`(真机上约 200 毫秒),
 * 50 拍 ≈ 30 秒 —— 与 10-12 那版 20 × (1.5 秒 + 一次 op) 同一个上限,没放宽。
 */
export const KLING_LOAD_TRIES = 50

/**
 * ★ **墙钟上限**(2026-10-21,卡「派活按家隔离」第 5 条「改版检测」)。
 *
 * 上面两个拍数的注释写的是「约 30 秒」,可那是按一下 op 200 毫秒算的 —— op 自己的超时是 15 / 40 秒,
 * 可灵卡住或页面改版时,最坏 50 × 20 秒 ≈ 17 分钟。现在**拍数与墙钟谁先到算谁**:找不到约定的元素就快速失败,
 * 卡上写「页面结构变了,停在哪一步」,不重试到死。
 */
export const KLING_LOAD_DEADLINE_MS = 30_000
export const KLING_NAV_DEADLINE_MS = 15_000
/** 找元素那几下 op 的单次超时(可灵卡住时不让一下吃掉整段上限)。 */
export const KLING_FIND_OP_MS = 8_000

/** 找不到约定元素时卡上那一句(哪一步、找什么、找了多久)。 */
export function klingPageChangedSay(input: { step: string, what: string, waitedMs: number }): string {
  return `可灵的页面结构变了(或要你先登录):停在「${input.step}」这一步,找了 ${Math.round(input.waitedMs / 1000)} 秒没找到${input.what} —— 不再重试,参考图在选题文件夹里`
}

export interface KlingHelper {
  request: (req: Record<string, unknown> & { op: string }, timeoutMs?: number) => Promise<Record<string, unknown>>
}

export interface KlingStepDeps {
  /** 把可灵拉起来、叫到前面(`open -b`,由调用方起进程)。失败抛错。 */
  openApp: () => Promise<void>
  helper: KlingHelper
  sleep: (ms: number) => Promise<void>
  /** 等页面里出现输入框最多几拍(每拍 {@link pollMs})。 */
  loadTries?: number
  pollMs?: number
  labels?: readonly string[]
  /**
   * ★ 可灵自己那份日志({@link KLING_LOG})(2026-10-13 晚)。只用在一处:
   * 「没读到新一条、图和词都还在」时等那 90 秒,日志里出现按下之后的 `AllTaskFinish` 也算它接下了。
   * 缺席 = 只靠读窗(日志读不到的那台机器本来就是这样)。
   */
  readLog?: () => Promise<string>
  now?: () => number
}

export type KlingOutcome =
  /**
   * 按下了,而且看到它开始生成了。
   *
   * ★ `seen` = **判成「开始了」的是读窗里哪一行字**(2026-10-13,卡 M)。
   * ★ 2026-10-13 晚(卡 O):这一行现在必须是**按完才新出现**的那一行(或者 {@link KLING_STARTED_BY_CARD});
   * 老判据是「尾巴里命中任意一行」,17:22 真机那条就这么判错了。
   * `cards` = 按之前结果列里有几条做完的卡 —— 等出片那一层拿它当底(多出一条 = 这一单做完了)。
   */
  /**
   * ★ 2026-10-13 晚(卡 Q)多两格:
   * `imageWait` = 按生成之前**没看出图传完**(等满 20 秒 / 读不到窗),卡上要留这一句;
   * `doneBar` = 按生成之前底部那条浮条的原文(「1/1 生成完成」),等出片那一层拿它当底。
   */
  | { kind: 'started', how: string, label: string, seen?: string, cards?: number, doneBar?: string, imageWait?: string, imageSeen?: true, replaced?: string }
  /** 没按成 / 没接单。`step` = 卡在哪一步;`why` 是给她的人话。 */
  | { kind: 'failed', step: 'open' | 'load' | 'clear' | 'image' | 'prompt' | 'press', why: string }

/**
 * 读窗回来的一行字:`t` 是那段字,`y` 是它在窗口里的纵坐标(壳 `agent_read` 每一行都带位置);
 * `ctl` = 壳标的导航 / 控件行(左侧那条「生成」链接就是这样一行)。
 */
export interface KlingTextRow { t: string, y?: number, ctl?: boolean }

/**
 * ★ **壳读回来的两列**(2026-10-13 22:3x 本机探针,卡 S):可灵生成页的**编辑区在 `side` 那一列**
 * (首帧格「添加 尾帧图(可选) 历史创作」、底部那颗「60 生成」都是 `side` 里的 AXButton 行),
 * `tail` 是结果列(提示词、结果卡的「00:0x / 00:05」、「创作中」)外加左侧导航那几条(`ctl: true`,其中一条就叫「生成」)。
 * 卡 Q 那套「图传完了没有」只看 `tail`:首帧格永远读不到、生成键永远是导航那条光秃秃的「生成」→ 每条链白等满 20 秒。
 */
interface ReadLite { tail: readonly KlingTextRow[], side: readonly KlingTextRow[] }

function textRows(raw: unknown): KlingTextRow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((one): KlingTextRow[] => {
    if (typeof one !== 'object' || one === null) return []
    const row = one as { t?: unknown, y?: unknown, ctl?: unknown }
    if (typeof row.t !== 'string') return []
    return [{ t: row.t, ...(typeof row.y === 'number' ? { y: row.y } : {}), ...(row.ctl === true ? { ctl: true } : {}) }]
  })
}

function readLite(raw: Record<string, unknown>): ReadLite {
  return { tail: textRows(raw.tail), side: textRows(raw.side) }
}

/** 编辑区 + 结果列一起看(首帧格、生成键在 `side`;提示词、结果卡在 `tail`)。读不到就是空的。 */
function composerRows(lite: ReadLite | undefined): readonly KlingTextRow[] {
  return lite === undefined ? [] : [...lite.side, ...lite.tail]
}

/**
 * ★ **按生成之前 / 之后那一眼里,这一页长什么样**(2026-10-13 晚,卡 O)。
 *
 * 判「它接下这一单了没有」要的是**变化**,不是有没有:
 * - `working`:「创作中 / 排队 / 预计… / NN%」那些行,**数字先抹成 `#`** 再按行计数 ——
 *   上一条还在跑时那行百分比每读一眼都在变,不抹数字的话每一眼都像「新出现一行」;
 *   同一句出现两次算两条(新开一条、文案与旧那条一字不差时靠条数分出来);
 * - `cards`:结果列里做完的卡有几条(做完的卡才有播放时间);
 * - `frame`:首帧那一格空着 / 填着 / 读不出来(页面重载过会变回空的那一句)。
 */
export interface KlingPageLook {
  working: Readonly<Record<string, number>>
  cards: number
  frame: 'filled' | 'empty' | 'unknown'
  /** ★ 整行只有一个百分比的那几行有几条(卡 Q:判「这张图在传」时拿它当底,见 {@link klingUploadVerdict})。 */
  percents: number
}

/** 「创作中,预计等待 1 分钟」→「创作中,预计等待 # 分钟」:数字抹掉才比得出是不是同一行。 */
export function klingWorkingKey(text: string): string {
  return text.trim().replace(/\d+/g, '#')
}

export function klingPageLook(rows: readonly KlingTextRow[]): KlingPageLook {
  const working: Record<string, number> = {}
  for (const row of rows) {
    if (!KLING_STARTED_TEXT.test(row.t)) continue
    const key = klingWorkingKey(row.t)
    working[key] = (working[key] ?? 0) + 1
  }
  return {
    working,
    cards: rows.filter(row => KLING_PLAYTIME_RE.test(row.t.trim())).length,
    percents: barePercents(rows),
    frame: rows.some(row => KLING_FRAME_EMPTY_TEXT.test(row.t))
      ? 'empty'
      : rows.some(row => KLING_FRAME_FILLED_TEXT.test(row.t)) ? 'filled' : 'unknown',
  }
}

/**
 * 按完这一眼里,比按之前**多出来**的那一行「创作中 / 排队」(原文带回来,存进接力记录)。
 * 只多了别的字、或者同一行照旧 = `undefined`(就是「它没接下这一单」)。
 */
/** 页面底部那条浮条的原文(「1/1 生成完成」),没有就 `undefined`(见 {@link KLING_DONE_BAR_TEXT})。 */
export function klingDoneBar(rows: readonly KlingTextRow[]): string | undefined {
  for (const row of rows) {
    const hit = KLING_DONE_BAR_TEXT.exec(row.t)
    if (hit !== null) return hit[0]
  }
  return undefined
}

/**
 * ★ **这张图传完了没有**(2026-10-13 晚,卡 Q;判据见 {@link KLING_UPLOAD_TICK_MS} 那一段)。
 *
 * - `unreadable`:一行字都没读到 —— 「看不出来」不是「没传完」,调用方等够了照旧往下走;
 * - `waiting`:首帧格还空着、页面上有「上传中」那类字或**多出来**一行光百分比、
 *   或者生成键读得到却没带点数;
 * - `ready`:首帧格填着、没有在传的迹象,而且生成键带点数**或者压根读不到那颗键**
 *   (读不出来的判据不当拦路 —— 可灵改文案 / 尾巴被截时不能把这一步堵死)。
 */
export type KlingUploadVerdict = 'ready' | 'waiting' | 'unreadable'

export function klingUploadVerdict(beforePaste: KlingPageLook, rows: readonly KlingTextRow[]): KlingUploadVerdict {
  if (rows.length === 0) return 'unreadable'
  const look = klingPageLook(rows)
  if (look.frame === 'empty') return 'waiting'
  if (rows.some(row => KLING_UPLOADING_TEXT.test(row.t))) return 'waiting'
  if (barePercents(rows) > beforePaste.percents) return 'waiting'
  // ★ 导航 / 控件行不算生成键(卡 S):左侧那条「生成」链接永远没有点数,拿它判会一直「还没传完」。
  const keys = rows.filter(row => row.ctl !== true).map(row => KLING_KEY_ROW.exec(row.t.trim())).filter((hit): hit is RegExpExecArray => hit !== null)
  return keys.length > 0 && !keys.some(hit => hit[1] !== undefined) ? 'waiting' : 'ready'
}

function barePercents(rows: readonly KlingTextRow[]): number {
  return rows.filter(row => KLING_BARE_PERCENT.test(row.t)).length
}

export function klingNewWorking(before: KlingPageLook, rows: readonly KlingTextRow[]): string | undefined {
  const seen: Record<string, number> = {}
  for (const row of rows) {
    if (!KLING_STARTED_TEXT.test(row.t)) continue
    const key = klingWorkingKey(row.t)
    seen[key] = (seen[key] ?? 0) + 1
    if (seen[key] > (before.working[key] ?? 0)) return row.t
  }
  return undefined
}

/** 发一个 op,回包收成一种形状(壳有时回 `{ok,result}`、有时直接回结果);`ok:false` 抛出原因。 */
async function ask(helper: KlingHelper, req: Record<string, unknown> & { op: string }, timeoutMs: number): Promise<Record<string, unknown>> {
  const out = helperOutcome(await helper.request(req, timeoutMs))
  if (!out.ok) throw new Error(out.error)
  return out.result
}

/**
 * 读之前先把它从「藏起来」里放出来(只 unhide、不抢台前):工作台的窗口槽会把不在前面的程序藏起来,
 * 而可灵是 Chromium 外壳,**一藏辅助功能树就停在藏起那一刻**(10-08 千问办公同一个病;10-12 本机真量:
 * 打开生成页之后几秒可灵就被藏了,读到的还是首页)。
 */
async function unhide(helper: KlingHelper): Promise<void> {
  try { await ask(helper, { op: 'unhide_app', bundle_id: KLING_BUNDLE }, 5000) }
  catch { /* 放不出来就照读;读不到就是读不到 */ }
}

async function read(helper: KlingHelper): Promise<ReadLite | undefined> {
  await unhide(helper)
  try { return readLite(await ask(helper, { op: 'agent_read', bundle_id: KLING_BUNDLE }, 15_000)) }
  catch { return undefined }
}

/**
 * 生成页的提示词框出来了没有。用壳的 `focus_input`(只找、不聚焦、不写):10-12 真量,`agent_read` 那一套
 * 认不出可灵这一页的输入框(回包里没有 `input`),`focus_input` 认得出底部那个可写的 `AXTextArea`。
 */
async function promptBoxReady(helper: KlingHelper): Promise<boolean> {
  await unhide(helper)
  try {
    const found = await ask(helper, { op: 'focus_input', bundle_id: KLING_BUNDLE, index: 0, focus: false }, KLING_FIND_OP_MS)
    const picked = found.picked
    return typeof picked === 'object' && picked !== null && (picked as { writable?: unknown }).writable === true
  }
  catch { return false }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * ★ **贴完核一眼首帧格**(2026-10-13 晚,卡 O)。
 *
 * 10-12 那一版只看壳回包:壳说「⌘V 发出去了」就算贴上了。可网页那一侧是异步读剪贴板的,
 * 而 20:31 演示机那一轮系统日志里正好有一条 `CFPasteboard … Could not obtain entitlement` ——
 * 「壳贴了」和「可灵收到了」是两件事。判据是那一格的文案({@link KLING_FRAME_FILLED_TEXT})。
 * 还空着就**再贴一次**;两次都没上就如实说,不往下按生成(按出来的会是一条没有参考图的片子)。
 * **读不出那两句**(壳读不到 / 尾巴被截)照旧往下走 —— 读窗是加一道保险,不是新的拦路。
 */
async function pasteFrame(path: string, deps: KlingStepDeps, pollMs: number): Promise<{ ok: true } | { ok: false, why: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await ask(deps.helper, { op: 'paste_image', bundle_id: KLING_BUNDLE, index: 0, path }, 30_000) }
    catch (error) { return { ok: false, why: `参考图没贴进可灵(${messageOf(error)})—— 图在选题文件夹里,要你拖进可灵` } }
    await deps.sleep(pollMs)
    if (klingPageLook(composerRows(await read(deps.helper))).frame !== 'empty') return { ok: true }
  }
  return { ok: false, why: KLING_IMAGE_MISSING_WHY }
}

/**
 * ★ **贴完图等它真传完**(2026-10-13 晚,卡 Q;判据见 {@link klingUploadVerdict})。
 *
 * 一秒读一眼,最少 {@link KLING_UPLOAD_MIN_MS}、最多 {@link KLING_UPLOAD_MAX_MS}。
 * 等不出来**不拦路**:照旧写词、按生成(卡 O 那条路一个字没改),只把「没看出传完」那一句交回去挂卡上
 * —— 台上宁可多一句实话,也不为一条读不准的判据停在这里。
 */
/**
 * ★ **真信号:首帧格里那张图本身**(2026-10-13 22:4x 本机探针,卡 T)。
 *
 * 维护者:「按钮一直是 60 点,只能从图片判断,有一个 loading,然后显示完整的图片」。文字读窗看不见图;
 * 壳新 op `agent_images`(只读)把窗里的 AXImage 连 `AXURL` 一起回来 —— Chromium 给 `<img>` 带的就是 src。
 * 传完的页上首帧格那张是 `https://p4-fdl.klingai.com/bs2/upload-ylab-stunt/…/%E5%8F%82%E8%80%83%E5%9B%BE-20261013-220351.png?…`:
 * **上传完成后 CDN 的地址,带着我们那张参考图的文件名**;这个地址只在上传真完成之后才存在(上传中多半是 `blob:` 预览或没有)。
 * 所以判据只有一条:**出现一张 https 地址里带我们文件名的图**。上一回留下的图(别的时刻的文件名)、结果列的缩略图都对不上。
 */
export interface KlingImageNode { x?: number, y?: number, w?: number, h?: number, url?: string, desc?: string }

export function klingUploadedImage(images: readonly KlingImageNode[], imagePath: string): boolean {
  const name = imagePath.split('/').pop() ?? imagePath
  if (name.length === 0) return false
  const encoded = encodeURIComponent(name)
  return images.some((one) => {
    if (typeof one.url !== 'string' || !/^https:\/\//i.test(one.url)) return false
    // 地址里文件名多半是 URL 编码的(本机真量);没编码的、以及整条地址坏编码时按原样比,都认。
    if (one.url.includes(name) || one.url.includes(encoded)) return true
    try { return decodeURIComponent(one.url).includes(name) }
    catch { return false }
  })
}

/** 壳读回来的图片节点;老壳没有这个 op(回错)= `undefined`,调用方据此退回文字判据。 */
async function readImages(helper: KlingHelper): Promise<readonly KlingImageNode[] | undefined> {
  try {
    const res = await ask(helper, { op: 'agent_images', bundle_id: KLING_BUNDLE }, 8000)
    if (!Array.isArray(res.images)) return []
    return res.images.flatMap((one): KlingImageNode[] => {
      if (typeof one !== 'object' || one === null) return []
      const row = one as Record<string, unknown>
      return [{
        ...(typeof row.x === 'number' ? { x: row.x } : {}),
        ...(typeof row.y === 'number' ? { y: row.y } : {}),
        ...(typeof row.w === 'number' ? { w: row.w } : {}),
        ...(typeof row.h === 'number' ? { h: row.h } : {}),
        ...(typeof row.url === 'string' ? { url: row.url } : {}),
        ...(typeof row.desc === 'string' ? { desc: row.desc } : {}),
      }]
    })
  }
  catch { return undefined }
}

/**
 * 回 `{ seen: true }` = 真看到我们那张图传完了(当场写词、按生成);
 * `{ note }` = 没看出来(等满了 / 读不到),卡上要留那一句;`{}` = 老壳走文字判据等够了。
 *
 * ★ 2026-10-13 夜(卡 T):先问壳要图(`agent_images`),看到 https 地址带我们文件名那张就走,**不等那 6 秒**;
 * 老壳回「未知 op」只问一次,退回卡 S 的文字判据(最少 6 秒、最多 20 秒)。壳有图但 20 秒都没见到我们那张
 * → 照旧按、卡上留「图可能没传完」(与今天一样,不多花额度)。
 */
async function waitImageUploaded(beforePaste: KlingPageLook, imagePath: string, deps: KlingStepDeps): Promise<{ seen?: true, note?: string }> {
  let waited = 0
  let last: KlingUploadVerdict = 'unreadable'
  let imagesOp: boolean | undefined
  while (waited < KLING_UPLOAD_MAX_MS) {
    await deps.sleep(KLING_UPLOAD_TICK_MS)
    waited += KLING_UPLOAD_TICK_MS
    if (imagesOp !== false) {
      const images = await readImages(deps.helper)
      imagesOp = images !== undefined
      if (images !== undefined) {
        if (klingUploadedImage(images, imagePath)) return { seen: true }
        continue
      }
    }
    last = klingUploadVerdict(beforePaste, composerRows(await read(deps.helper)))
    if (last === 'ready' && waited >= KLING_UPLOAD_MIN_MS) return {}
  }
  if (imagesOp === true) return { note: KLING_IMAGE_SLOW_NOTE }
  return { note: last === 'unreadable' ? KLING_IMAGE_UNREADABLE_NOTE : KLING_IMAGE_SLOW_NOTE }
}

/**
 * 提示词写进框里。`save_draft`:10-12 端到端真跑撞上的 —— 可灵的生成页会**把上一次框里的字留着**
 * (彩排留下的、她自己写过的),壳照老规矩「框里有她没发的字就不盖」,于是卡在这一步。
 * 这一件就是要往这个框里写这一句:照盖,但壳先把原文读出来交回(只写不发时它不放回去),存在卡上
 * —— 「不许悄悄丢掉她的字」那条照旧。
 */
async function writePrompt(prompt: string, deps: KlingStepDeps): Promise<{ ok: true, replaced?: string } | { ok: false, why: string }> {
  try {
    const sent = await ask(deps.helper, { op: 'send_text', bundle_id: KLING_BUNDLE, index: 0, text: prompt, submit: false, restore_front: false, save_draft: true }, 60_000)
    const draft = typeof sent.draft === 'string' ? sent.draft.trim() : ''
    return draft !== '' && draft !== prompt.trim() ? { ok: true, replaced: sent.draft as string } : { ok: true }
  }
  catch (error) { return { ok: false, why: `提示词没写进可灵(${messageOf(error)})` } }
}

/**
 * 按那颗「生成」。`missing` = 这一页上没有这个名字的键(换下一个名字再找,不算没成);
 * 两颗同名一颗都不点(换名字也是在那几颗里猜)。
 */
async function pressGenerate(label: string, deps: KlingStepDeps): Promise<{ kind: 'ok', how: string } | { kind: 'missing' } | { kind: 'failed', why: string }> {
  let res: Record<string, unknown>
  try { res = await ask(deps.helper, { op: 'agent_press', bundle_id: KLING_BUNDLE, label, role: KLING_GENERATE_ROLE }, 40_000) }
  catch (error) { return { kind: 'failed', why: `可灵的「生成」没按成(${messageOf(error)})` } }
  if (typeof res.many === 'number' && res.many > 1) return { kind: 'failed', why: `可灵窗口里有 ${res.many} 颗都叫「${label}」,怕点错一颗都没点 —— 要你在可灵里点一下生成` }
  if (res.found !== true) return { kind: 'missing' }
  if (res.pressed !== true) return { kind: 'failed', why: typeof res.note === 'string' ? res.note : `可灵的「${label}」点不下去` }
  return { kind: 'ok', how: typeof res.how === 'string' ? res.how : 'pressed' }
}

/**
 * ★ **按完盯 10 秒:只认新出现的那一行**(2026-10-13 晚,卡 O;时刻表见 {@link KLING_WATCH_AT_MS})。
 *
 * 「新」有两种:多出一行「创作中 / 排队 / 预计…」(数字抹掉之后按条数比,见 {@link klingPageLook}),
 * 或者结果列里多了一条做完的卡。两种都没有就是**它没接下这一单** —— 回最后那一眼,
 * 调用方据此核图和词还在不在、重做一次再按。
 */
async function watchStarted(before: KlingPageLook, deps: KlingStepDeps): Promise<{ seen?: string, rows: readonly KlingTextRow[] }> {
  let waited = 0
  let rows: readonly KlingTextRow[] = []
  for (const at of KLING_WATCH_AT_MS) {
    if (at > waited) { await deps.sleep(at - waited); waited = at }
    rows = composerRows(await read(deps.helper))
    const fresh = klingNewWorking(before, rows)
    if (fresh !== undefined) return { seen: fresh, rows }
    if (klingPageLook(rows).cards > before.cards) return { seen: KLING_STARTED_BY_CARD, rows }
  }
  return { rows }
}

/**
 * ★ **图和词都还在、只是没读到新那一行:接着等 90 秒,一下都不补按**(2026-10-13 晚 21:2x)。
 *
 * 判据三样任一(都是现成的读数,没有新 op):按下之后可灵日志里的 `AllTaskFinish`、
 * 读窗里新出现的「创作中 / 排队」行、结果卡变多。等到了就当它早就接下了(只是那一眼读漏了);
 * 等不到才如实说没接单。回「凭哪一样认的」,没等到回 `undefined`。
 */
async function waitLateStart(before: KlingPageLook, since: number, deps: KlingStepDeps): Promise<string | undefined> {
  for (let i = 0; i < KLING_LATE_TRIES; i += 1) {
    await deps.sleep(KLING_LATE_TICK_MS)
    if (deps.readLog !== undefined) {
      const log = await deps.readLog().catch(() => '')
      if (klingFinishedSince(log, since)) return KLING_STARTED_BY_LOG
    }
    const rows = composerRows(await read(deps.helper))
    const fresh = klingNewWorking(before, rows)
    if (fresh !== undefined) return fresh
    if (klingPageLook(rows).cards > before.cards) return KLING_STARTED_BY_CARD
  }
  return undefined
}

/**
 * 跑一遍。**绝不抛**:每一种没成都回 `failed` + 卡在哪一步 + 一句人话。
 *
 * ★ **什么时候才补按那一下**(2026-10-13 晚,统筹 21:2x 收窄):只有**页面明显被重置**
 * (首帧格读回「添加 首尾帧图」或提示词框里找不到我们那句)才重做 + 再按一次 —— 那时第一下确实按在空页上。
 * 图和词都还在、只是没读到新那一行 → **一下都不补按**,转入 {@link waitLateStart} 等 90 秒。
 * 理由:可灵日志里没有「提交了任务」的记号,「接没接单」只能靠还没量过的读窗;
 * 台上多按一次生成(两份额度、两条任务)比多等一会儿更糟。
 */
export async function runKlingStep(input: { imagePath: string, prompt: string }, deps: KlingStepDeps): Promise<KlingOutcome> {
  const pollMs = deps.pollMs ?? KLING_TICK_MS
  const loadTries = deps.loadTries ?? KLING_LOAD_TRIES
  const clock = deps.now ?? (() => Date.now())
  try { await deps.openApp() }
  catch (error) { return { kind: 'failed', step: 'open', why: `可灵没打开(${messageOf(error)})—— 看一眼可灵装好、登录了没有` } }

  /*
   * 在当前标签页里点到「视频生成」那一页。好几处都像(开着好几个标签页)就停,如实说。
   * **认不出就再看几眼**(10-12 第三轮真跑:点完「生成」那一页还没画完、可灵又被窗口槽藏了,树停在旧画面,
   * 「视频生成」那个页签当场没找到 —— 过一会儿就在)。点页签是翻页,多点一次无害;「生成」键不在这里,那一下不重按。
   *
   * **第一下不等**(2026-10-13):`open -b` 回来就试着点,点不到才等一拍 —— 页面画完得多快是它说了算,不是我们猜的 1.5 秒。
   */
  for (const step of KLING_NAV) {
    let done = false
    const navStart = clock()
    for (let attempt = 0; attempt < KLING_NAV_TRIES && !done && (attempt === 0 || clock() - navStart < KLING_NAV_DEADLINE_MS); attempt += 1) {
      if (attempt > 0) await deps.sleep(pollMs)
      await unhide(deps.helper)
      let res: Record<string, unknown>
      try { res = await ask(deps.helper, { op: 'agent_press', bundle_id: KLING_BUNDLE, label: step.label, role: step.role }, 40_000) }
      catch (error) { return { kind: 'failed', step: 'open', why: `可灵里点不到「${step.label}」(${messageOf(error)})` } }
      if (typeof res.many === 'number' && res.many > 1) {
        return { kind: 'failed', step: 'open', why: `可灵里有 ${res.many} 处都叫「${step.label}」(多半开着好几个标签页)—— 只留一个标签页再来` }
      }
      done = res.found === true && res.pressed === true
    }
    if (!done) {
      const waitedMs = clock() - navStart
      return {
        kind: 'failed',
        step: 'open',
        why: waitedMs >= KLING_NAV_DEADLINE_MS
          ? klingPageChangedSay({ step: `点「${step.label}」`, what: `「${step.label}」那颗键`, waitedMs })
          : `可灵里没点到「${step.label}」—— 要你在可灵里点到「视频生成」那一页`,
      }
    }
  }

  // 提示词框出现了才往下走:**先看一眼**,看到就接着做(页面早画完了就一拍都不等)。
  let loaded = false
  const loadStart = clock()
  for (let i = 0; i < loadTries && !loaded && (i === 0 || clock() - loadStart < KLING_LOAD_DEADLINE_MS); i += 1) {
    if (i > 0) await deps.sleep(pollMs)
    loaded = await promptBoxReady(deps.helper)
  }
  if (!loaded) {
    const waitedMs = clock() - loadStart
    return {
      kind: 'failed',
      step: 'load',
      why: waitedMs >= KLING_LOAD_DEADLINE_MS
        ? klingPageChangedSay({ step: '等提示词框', what: '可写的提示词框', waitedMs })
        : '可灵的视频生成页没等到提示词框(多半要你先登录)—— 参考图在选题文件夹里',
    }
  }

  /*
   * 先把上一回留下的帧图删掉(10-12 第六轮真跑:那一页留着上一回的首帧,新图贴进去成了尾帧)。
   * 删除键要悬停才显示,壳 `clear_frames` 自己悬停再点;删不干净就停 —— 往尾帧里贴是做错事,不如如实说。
   */
  try {
    const cleared = await ask(deps.helper, { op: 'clear_frames', bundle_id: KLING_BUNDLE, index: 0 }, 30_000)
    if (typeof cleared.left === 'number' && cleared.left > 0) {
      return { kind: 'failed', step: 'clear', why: `可灵里上一回的 ${cleared.left} 张图没删掉 —— 要你把「首尾帧」那两格清空` }
    }
  }
  catch (error) { return { kind: 'failed', step: 'clear', why: `可灵里上一回的图没清掉(${messageOf(error)})` } }
  // 删完到那一格空出来还有一帧界面的事:这两处的「就绪」读不出来(壳回包就是唯一判据),留一拍(400 ms)。
  await deps.sleep(pollMs)

  /*
   * 图:**粘贴进去**(维护者原话「复制粘贴进可灵」)。10-12 真量:贴进「视频生成」这一页之后,
   * 「添加 首尾帧图」那一格变成「添加 尾帧图(可选)」= 首帧填上了 —— 贴完核这一格(见 {@link pasteFrame})。
   * 先贴图、再写字:写字那一下全选只选框里的字,不碰已经挂上的图。
   */
  /*
   * ★ **贴图之前读一眼留底**(2026-10-13 晚,卡 Q):这一页现在有几行光百分比的 ——
   * 旧那条在跑的进度每读一眼都在跳,不留底就会把它当成「这张图在传」,白等 20 秒。
   */
  const beforePaste = klingPageLook(composerRows(await read(deps.helper)))
  const pasted = await pasteFrame(input.imagePath, deps, pollMs)
  if (!pasted.ok) return { kind: 'failed', step: 'image', why: pasted.why }
  /*
   * ★ **图真传完了再写词、按生成**(2026-10-13 晚,卡 Q):演示机那一单坐实了「贴完立刻按 = 没有参考图」。
   * 等不出来不拦路,只把那一句挂卡上(见 {@link waitImageUploaded})。
   */
  let upload = await waitImageUploaded(beforePaste, input.imagePath, deps)

  const wrote = await writePrompt(input.prompt, deps)
  if (!wrote.ok) return { kind: 'failed', step: 'prompt', why: wrote.why }
  let replaced = wrote.replaced

  /*
   * ★ **按之前先读一眼留个底**(2026-10-13 晚,卡 O):这一页现在已经有哪几行「创作中 / 排队」、
   * 结果列里几条做完的卡。按完判「它接下了没有」比的就是这个底 —— 不比就会把页面别处、
   * 上一条卡、被藏起来那一刻停住的旧画面当成「开始了」(17:22 真机那条就是这么判错的)。
   */
  const beforeRows = composerRows(await read(deps.helper))
  const before = klingPageLook(beforeRows)
  // ★ 底部那条浮条也留一眼(卡 Q):等出片那一层判「又做完一条」比的是它变没变。
  const doneBar = klingDoneBar(beforeRows)
  const started = (how: string, label: string, seen: string): KlingOutcome => ({
    kind: 'started',
    how,
    label,
    seen,
    cards: before.cards,
    ...(doneBar === undefined ? {} : { doneBar }),
    ...(upload.note === undefined ? {} : { imageWait: upload.note }),
    ...(upload.seen === true ? { imageSeen: true as const } : {}),
    ...(replaced === undefined ? {} : { replaced }),
  })

  for (const label of deps.labels ?? KLING_GENERATE_LABELS) {
    // 日志里那条 `AllTaskFinish` 只认按下之后的(留一秒富余,与 `waitKlingVideo` 同一个写法)。
    const pressedAt = (deps.now?.() ?? Date.now()) - 1000
    const first = await pressGenerate(label, deps)
    // 这个名字这一页上没有(可灵改了文案)→ 换下一个名字;真按不下去 / 两颗同名 → 如实说,不换名字猜。
    if (first.kind === 'missing') continue
    if (first.kind === 'failed') return { kind: 'failed', step: 'press', why: first.why }
    const watched = await watchStarted(before, deps)
    if (watched.seen !== undefined) return started(first.how, label, watched.seen)

    // 一行字都没读到:不是「它没接下」,是「我看不见」—— 一下都不补按(见 {@link KLING_UNREADABLE_WHY})。
    if (watched.rows.length === 0) return { kind: 'failed', step: 'press', why: KLING_UNREADABLE_WHY }

    /*
     * ★ **只有页面明显被重置才补按那一下**(2026-10-13 晚,统筹 21:2x 收窄;理由见 {@link waitLateStart})。
     *
     * 本机 17:22 那一轮:可灵自己在新开标签页、那个页 `Failed to load remote URL` 之后重载 ——
     * 重载把贴进去的首帧和写进去的提示词都清空了,那一下按在一个空页上,页面上**读得出来**:
     * 首帧格回到「添加 首尾帧图」、尾巴里找不到我们那句。这时才重做 + 再按一次(第一下确实没进去)。
     */
    const look = klingPageLook(watched.rows)
    const head = input.prompt.slice(0, KLING_PROMPT_HEAD)
    const promptGone = !watched.rows.some(row => row.t.includes(head))
    if (look.frame !== 'empty' && !promptGone) {
      // 图和词都还在:多半是那一眼读漏了,接着等 90 秒;等到了就当它早就接下了,一下都不补按。
      const late = await waitLateStart(before, pressedAt, deps)
      if (late !== undefined) return started(first.how, label, late)
      return { kind: 'failed', step: 'press', why: KLING_NOT_TAKEN_WHY }
    }
    if (look.frame === 'empty') {
      const again = await pasteFrame(input.imagePath, deps, pollMs)
      if (!again.ok) return { kind: 'failed', step: 'image', why: again.why }
      /*
       * ★ 重贴之后**也要等它传完**(卡 Q):补按那一下同样不能按在一张还在传的图上。
       * 卡上那一句按**这一轮**算 —— 真按进去的是第二下(第一下按在被重置的空页上)。
       */
      upload = await waitImageUploaded(beforePaste, input.imagePath, deps)
    }
    if (promptGone) {
      const again = await writePrompt(input.prompt, deps)
      if (!again.ok) return { kind: 'failed', step: 'prompt', why: again.why }
      if (again.replaced !== undefined) replaced = again.replaced
    }
    const second = await pressGenerate(label, deps)
    if (second.kind !== 'ok') return { kind: 'failed', step: 'press', why: second.kind === 'missing' ? KLING_NOT_TAKEN_WHY : second.why }
    const retried = await watchStarted(before, deps)
    if (retried.seen !== undefined) return started(second.how, label, retried.seen)
    return { kind: 'failed', step: 'press', why: retried.rows.length === 0 ? KLING_UNREADABLE_WHY : KLING_NOT_TAKEN_WHY }
  }
  return { kind: 'failed', step: 'press', why: '可灵窗口里没找到「生成」那颗键 —— 参考图和提示词已经放进去了,要你点一下生成' }
}

// ───────────────────────────── 出片之后:等片子、下下来 ─────────────────────────────

/** 可灵自己的日志(10-12 真量:出片通知与下载完成都记在这里)。 */
export const KLING_LOG = 'Library/Logs/KlingAI/kling-local-app/app.log'
/**
 * 结果卡上的播放时间(「00:01 / 00:05」):认「哪条片子」用的锚。
 *
 * ★ **锚是怎么落到最新那条上的**(2026-10-13 查壳的源码,`SendTextPolicy.pickKeyBelowAnchor`):壳把窗口里
 * 所有命中这条正则的静态字收起来,取**最上面那一条**(`anchors.min(minY)`),再在它下面 80 点内取最左那颗
 * 没名字的 `AXPopUpButton`。所以:
 * - 认的是**位置**,不是时间的字面 —— 几条卡都在自动播放、各自的「00:0x / 00:05」每秒都在变,一点关系都没有;
 * - 落在最新那条身上靠的是「结果列里新的在最上面」这一条**没量过**的前提(彩排 0.6 要量);
 * - 最上面那一行**并排两条**时壳的 `min(minY)` 谁先谁后看遍历顺序 —— 那时插件一下都不点(见 {@link klingCardLook}),
 *   按错一条就是把旧片子下下来、还说成「办完了」。
 */
export const KLING_PLAYTIME = '^\\d{2}:\\d{2} / \\d{2}:\\d{2}$'
const KLING_PLAYTIME_RE = /^\d{2}:\d{2} \/ \d{2}:\d{2}$/
/** 两段播放时间的纵坐标差在这以内 = 同一行上的两条卡(分不出哪条新)。 */
export const KLING_SAME_ROW_PT = 16
/** 等最新那条结果卡切到完成态最多几拍(一拍 = {@link KLING_CARD_TICK_MS} 的等 + 一次读窗,12 拍 ≈ 14 秒)。 */
export const KLING_CARD_TRIES = 12
export const KLING_CARD_TICK_MS = 700
/** 按完多久内该在可灵日志里见到「Download started」(没见就再按一次,只一次)。 */
export const KLING_DOWNLOAD_START_MS = 10_000
/** 下载这一下最多按几次(按两次只是多下一份同一个文件,不花额度;按第三次就是在乱点了)。 */
export const KLING_PRESS_TRIES = 2
/**
 * ★ **等出片时隔多久读一眼窗**(2026-10-13 晚,卡 O)。
 *
 * 等出片原来只认可灵自己的日志。演示机 20:35 那条就断在这里:可灵**真把片子做出来了**,
 * 而插件在 `AllTaskFinish` 上干等 —— 那台的可灵版本 / 日志路径 / 字段都没核过(日志文件不在诊断包里)。
 * 所以日志之外加一条旁路:读窗(现成只读 `agent_read`)看结果列里是不是**比按生成之前多了一条做完的卡**。
 * 读窗比读日志贵(要先 `unhide_app`),所以不跟日志同一拍:日志 5 秒一拍,窗 15 秒一眼。
 */
export const KLING_WINDOW_POLL_MS = 15_000
/** 「下载」文件夹里可灵下下来的片子叫什么(10-12 真量:`kling_20261012_作品_花海.mp4`)。 */
export const KLING_FILE_RE = /^kling.*\.(mp4|mov|m4v)$/i
/**
 * ★ **文件夹那条旁路认一个片子之前,它的大小要停住多久**(2026-10-13 22:06 真机,卡 R)。
 *
 * 可灵(Electron)把片子**直接写在最终那个名字上**,没有 `.crdownload` 一类的临时名:22:06 那条
 * `Download started` 之后文件夹里立刻有了 `kling_….mp4`,旁路一秒内就认了 —— 那会儿它只写了 32 120 字节;
 * 三秒后 `Download completed` 时才是 8 023 474 字节。半截片子复制进素材、推到手机,手机弹了播放器、播放失败。
 * 一条 5 秒的片子 5–12 MB、CDN 三四秒下完,**大小三秒没变**就是写完了;日志那条 `Download completed` 照旧一到就认。
 */
export const KLING_FILE_SETTLE_MS = 3000
/**
 * ★ **「做完了」是哪条路认出来的**(2026-10-14 中午,演示机,卡 AD)。记进插件日志(`[可灵] 做完了:…`),
 * 演示机上出了事诊断包里才有据可查(12:0x 那条诊断包里这一层一行都没有)。
 * `download` 那条是新的:她自己在可灵里点了下载 —— 按生成之后「下载」文件夹里冒出了 `kling_*.mp4`,
 * 或日志记了 `Download started`。片子能下,必然已经做完;这时**一下都不按**(她已经点了,再按只是多下一份)。
 */
export const KLING_DONE_BY = {
  log: '可灵日志记了创作完成',
  card: '结果列里多了一条做完的卡',
  bar: '底部浮条变了',
  download: '她自己点了下载(片子已经在下了)',
  /**
   * ★ 2026-10-14 13:40 演示机(卡 AE):按生成之后见过「创作中」、后来它没了,而且做完的卡比那一眼多了(或最上面那条
   * 播放时间上移了)。「比按生成之前多一条」在演示机上永远到不了:`agent_read` 只给 30 行,做完的卡数封顶在 5,底就是封顶值。
   */
  working_gone: '「创作中」出现过又消失,做完的卡多了或顶上来了',
} as const

/**
 * ★ **日志里没有「下完了」时的旁路:「下载」文件夹里那一刻之后新冒出来的可灵片子**(2026-10-13 晚,卡 O)。
 *
 * 只认按下下载那一刻之后改动过的(`mtimeMs >= since`),新的在前;挑最新那一个。
 * **不认整条路径**(文件名由调用方拼回去),这一层只做挑选,好单独验。
 */
export function pickFreshKlingFile(files: readonly { name: string, mtimeMs: number }[], since: number): string | undefined {
  return [...files].filter(one => KLING_FILE_RE.test(one.name) && one.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
}

/** 那一刻之后可灵记过「创作完成」(`AllTaskFinish`)没有。块里的 `timestamp` 是毫秒。 */
export function klingFinishedSince(log: string, since: number): boolean {
  const re = /"timestamp":\s*(\d{12,})[\s\S]{0,400}?"notixTopic":\s*"AllTaskFinish"/g
  for (const m of log.matchAll(re)) if (Number(m[1]) >= since) return true
  return false
}

/**
 * ★ 那一刻之后可灵**真开始下载**了没有(`Download started`)。
 *
 * 10-13 真机那两次就是这里分出来的:壳回「按了」,可灵日志里一条 `Download started` 都没有 ——
 * 「壳按下去了」和「可灵开始下载了」是两件事,只有后者算按成。
 */
export function klingDownloadStartedSince(log: string, since: number): boolean {
  const re = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] Download started\b/gm
  for (const m of log.matchAll(re)) if (Date.parse(m[1] as string) >= since) return true
  return false
}

/** 那一刻之后可灵记的「Download completed」带的完整路径(最后一条)。 */
export function klingDownloadedSince(log: string, since: number): string | undefined {
  const re = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] Download completed \{[\s\S]*?"fullPath":\s*"([^"]+)"/gm
  let found: string | undefined
  for (const m of log.matchAll(re)) if (Date.parse(m[1] as string) >= since) found = m[2]
  return found
}

/** 读窗那一眼里结果卡的样子(判「该不该按下载」用)。 */
export interface KlingCardLook {
  /** 看到几条做完的片子(有播放时间的那种卡)。 */
  done: number
  /** 最上面那条的纵坐标。 */
  top?: number
  /** 窗口里还有「创作中 / 排队」那类字:界面还没切过来。 */
  working: boolean
  /** 最上面那一行上有两条并排:分不出哪条是刚做好的。 */
  tied: boolean
}

/**
 * ★ **最上面那条结果卡切到完成态了没有**(2026-10-13,卡 D)。
 *
 * 读得出来的判据只有一样:结果卡上的播放时间(「00:01 / 00:05」)—— **做完的卡才有播放器**,
 * 还在生成的那条写的是「创作中,预计等待 1 分钟」。`agent_read` 的尾巴有上限(壳里 30 行 / 450 毫秒),
 * 读不到就是 `done: 0` —— 调用方据此**接着等**,等够了照 10-12 那样按(读窗是加一道保险,不是新的拦路)。
 */
export function klingCardLook(rows: readonly KlingTextRow[]): KlingCardLook {
  const times = rows.filter(row => KLING_PLAYTIME_RE.test(row.t.trim()))
  const ys = times.flatMap(row => (row.y === undefined ? [] : [row.y]))
  const top = ys.length === 0 ? undefined : Math.min(...ys)
  return {
    done: times.length,
    ...(top === undefined ? {} : { top }),
    working: rows.some(row => KLING_STARTED_TEXT.test(row.t)),
    tied: top !== undefined && ys.filter(y => Math.abs(y - top) <= KLING_SAME_ROW_PT).length > 1,
  }
}

export interface KlingVideoDeps {
  readLog: () => Promise<string>
  helper: KlingHelper
  sleep: (ms: number) => Promise<void>
  now: () => number
  pollMs?: number
  /** 等出片最多多久(视频 3.0 一条 5 秒片,10-12 真量排队 + 创作约 2–6 分钟)。 */
  finishTimeoutMs?: number
  downloadTimeoutMs?: number
  /** 等结果卡切到完成态:几拍、一拍多长。 */
  cardTries?: number
  cardTickMs?: number
  /** 按完等「Download started」多久。 */
  startWindowMs?: number
  /** 等出片时隔多久读一眼窗({@link KLING_WINDOW_POLL_MS})。 */
  windowPollMs?: number
  /**
   * ★ 「下载」文件夹里那一刻之后新冒出来的那个可灵片子的**整条路径**(2026-10-13 晚,卡 O)。
   * 可灵日志读不到 / 字段不一样时的旁路,只读文件名与改动时刻(见 {@link pickFreshKlingFile})。缺席 = 不走这条旁路。
   */
  findDownload?: (since: number) => Promise<KlingFreshFile | undefined>
  /** ★ 每一步的样子记一行进插件日志(`[可灵] …`;2026-10-14,卡 AD)。缺席 = 不记。 */
  log?: (line: string) => void
}

/** 「下载」文件夹里那个新冒出来的片子:整条路径 + **此刻**多少字节(还在写就会一眼一个数)。 */
export interface KlingFreshFile { path: string, bytes: number }

/**
 * `log_missing` = 可灵自己那份日志这一趟一次都没读到(文件不在 / 读不动)。
 * 不是失败:这一单是按读窗判的,但要在卡上留一句 —— 演示机那台的可灵版本还没核过。
 */
export type KlingVideoOutcome =
  | { kind: 'ready', path: string, log_missing?: boolean }
  | { kind: 'failed', why: string, log_missing?: boolean }

/** 按完那一下窗口里新冒出来的字里有这个 = 弹出来的是那张菜单(10-12 真量:里面有「去除水印」那个开关)。 */
const KLING_MENU_TEXT = /水印/

/**
 * 按一下那颗 ⬇。回「按下去了没有」+「是不是弹了那张菜单」。
 * 壳认不出 / 叫不到台前 / 发不出去都算没按下去;菜单那一格来自壳回包的 `new_texts`(它按完会重读一眼)。
 */
async function pressDownload(deps: KlingVideoDeps): Promise<{ pressed: boolean, menu: boolean }> {
  try {
    await unhide(deps.helper)
    const res = await ask(deps.helper, { op: 'press_below_text', bundle_id: KLING_BUNDLE, index: 0, pattern: KLING_PLAYTIME, role: 'AXPopUpButton' }, 30_000)
    const fresh = Array.isArray(res.new_texts) ? res.new_texts.filter((one): one is string => typeof one === 'string') : []
    return { pressed: res.found === true && res.pressed === true, menu: fresh.some(one => KLING_MENU_TEXT.test(one)) }
  }
  catch { return { pressed: false, menu: false } }
}

/**
 * 按下生成之后:盯可灵自己的日志等「创作完成」→ **等最新那条结果卡真切到完成态** → 按那颗 ⬇(一点就按 MP4 下,
 * 弹出来的菜单里「去除水印」是改她账号设置的开关,一下都不碰)→ **核对日志里出现了 `Download started`**,
 * 10 秒没出现就再按一次(只一次)→ 盯日志等「Download completed」→ 回路径。**绝不抛**。
 *
 * ## ★ 2026-10-13 真机:四次里自动下载只成两次(卡 D)
 *
 * 14:02 / 14:19 两通:`AllTaskFinish` 一到就按,壳回 `found/pressed`,可灵日志里一条 `Download started` 都没有,
 * 之后干等 2 分钟。改了三处:
 * 1. **不立刻按** —— 先读窗等那条卡有播放时间、而且两眼之间条数与位置都没动(列表还在插新卡 / 滚动时按的是移动的目标);
 * 2. **按完要核对** —— 判据是可灵自己的 `Download started`,不是壳说「按了」;没见就再按一次,**只一次**;
 * 3. **两次都没见也接着盯到窗口尽头** —— 14:19 那次是维护者自己手点下载救回来的(落在这个窗口里,整条链照样走完)。
 *    盯完还是没有才如实说「下载那一下没按成」—— **不许说办完了**(收卡那一层据此不走 confirm 那一档)。
 *
 * 已知局限:「创作完成」不带是哪一条;最新那条在不在结果列最上面**没量过**(彩排 0.6 要量)。
 *
 * ## ★ 2026-10-13 晚:判「做完了」不能只靠那份日志(卡 O)
 *
 * 演示机 20:35 那条:可灵**真把片子做出来了**,而这一层在 `AllTaskFinish` 上干等、从没走到按下载 ——
 * 那台的可灵版本 / 日志路径 / 字段一样都没核过(日志文件不在诊断包里)。所以日志与读窗**两条路任一成立就算做完**:
 * 读窗那一条认的是「结果列里比按生成之前多了一条做完的卡、而且没有『创作中 / 排队』那类字」
 * (`input.cardsBefore` 就是按生成之前那一眼;缺席时拿第一眼当底)。下完那一步同理多一条旁路:
 * 日志里没有 `Download completed` 时,看「下载」文件夹里有没有那一刻之后新冒出来的 `kling_*.mp4`。
 * **日志一次都读不到要在卡上留一句**(`log_missing`),别当没事发生。
 */
export async function waitKlingVideo(input: { since: number, cardsBefore?: number, doneBarBefore?: string }, deps: KlingVideoDeps): Promise<KlingVideoOutcome> {
  const pollMs = deps.pollMs ?? 5000
  /** 一行进插件日志(`[可灵] …`)。记不上不碍事。 */
  const say = (line: string): void => { try { deps.log?.(`[可灵] ${line}`) } catch { /* 记日志失败不该拦这条链 */ } }
  /** 日志读不到(文件不在 / 读不动)就当空的照走,但记一笔:这一单是按读窗判的。 */
  let logMissing = false
  const readLog = async (): Promise<string> => {
    try { return await deps.readLog() }
    catch { logMissing = true; return '' }
  }
  const finishMinutes = Math.round((deps.finishTimeoutMs ?? 20 * 60_000) / 60_000)
  const finishBy = deps.now() + (deps.finishTimeoutMs ?? 20 * 60_000)
  let finishedBy: string | undefined
  let cardsBefore = input.cardsBefore
  let lookAt = deps.now()
  let lastShape: string | undefined
  /** 按生成之后最近一眼见到「创作中」时的样子(卡 AE 那条判据的底)。 */
  let workingSeen: KlingCardLook | undefined
  let logNoted = false
  while (deps.now() < finishBy) {
    const log = await readLog()
    if (!logNoted) {
      logNoted = true
      say(logMissing
        ? '可灵日志:读不到(文件不在 / 读不动),只靠读窗与「下载」文件夹判'
        : `可灵日志:读到 ${log.length} 字,历史上 AllTaskFinish ${(log.match(/"AllTaskFinish"/g) ?? []).length} 条`)
    }
    if (klingFinishedSince(log, input.since)) { finishedBy = KLING_DONE_BY.log; break }
    /*
     * ★ **她自己点了下载也算做完了**(2026-10-14 中午,演示机,卡 AD)。
     * 12:0x 那条:可灵真把片子做出来了,下面那几条判据一条都没响(那台的可灵日志 / 读窗都没核过),
     * 维护者在可灵里手点了下载 —— 可这一层原来只在「做完」之后才看「下载」文件夹与 `Download started`,
     * 于是在这里干等到 20 分钟。片子能下,必然已经做完:按生成之后文件夹里冒出了 `kling_*.mp4`、
     * 或日志记了 `Download started`,就当做完,而且**一下都不按**(她已经点了)。
     */
    if (klingDownloadStartedSince(log, input.since) || (await deps.findDownload?.(input.since).catch(() => undefined)) !== undefined) {
      finishedBy = KLING_DONE_BY.download
      break
    }
    if (deps.now() >= lookAt) {
      lookAt = deps.now() + (deps.windowPollMs ?? KLING_WINDOW_POLL_MS)
      const rows = (await read(deps.helper))?.tail ?? []
      const look = klingCardLook(rows)
      const bar = klingDoneBar(rows)
      /*
       * 读窗那一条要有个「按生成之前有几条」的底 —— 结果列里本来就躺着她从前那些片子,
       * 「有一条做完的卡」在任何时候都成立。按生成那一步量过就用它;没量过(重启之后接着等)
       * 拿第一眼**读出点东西来的**那一眼当底,读空的那几眼不算(读不到不等于一条都没有)。
       */
      if (cardsBefore === undefined && (look.done > 0 || look.working)) cardsBefore = look.done
      /* 每一眼的样子变了才记一行(15 秒一眼、最多 20 分钟,样子不变不刷屏)。 */
      const shape = `读窗:做完的卡 ${look.done} 条(底 ${cardsBefore ?? '未定'}),创作中${look.working ? '有' : '无'},浮条「${bar ?? '无'}」(按之前「${input.doneBarBefore ?? '无'}」),读到 ${rows.length} 行`
      if (shape !== lastShape) { say(`等出片 · ${shape}`); lastShape = shape }
      /*
       * ★ **底部那条浮条跟按生成之前不一样了**(2026-10-13 晚,卡 Q):没有 → 有,或者 1/1 → 2/2,
       * 都是「又做完一条」。只看它在不在不行 —— 她上一回留下的那条也写着「1/1 生成完成」。
       */
      if (bar !== undefined && bar !== input.doneBarBefore && !look.working) { finishedBy = KLING_DONE_BY.bar; break }
      if (cardsBefore !== undefined && look.done > cardsBefore && !look.working) { finishedBy = KLING_DONE_BY.card; break }
      /*
       * ★ **「创作中」出现过又消失**(2026-10-14 13:40 演示机,卡 AE)。读空的那几眼不算;
       * 做完的卡要比见到「创作中」那一眼多,或最上面那条播放时间上移(新卡顶上来、最旧那条被 30 行挤出去);
       * 既没多也没上移(多半是失败了)不算,照旧等。
       */
      if (look.working && rows.length > 0) workingSeen = look
      else if (workingSeen !== undefined && rows.length > 0 && look.done > 0) {
        const moved = look.done > workingSeen.done
          || (look.top !== undefined && workingSeen.top !== undefined && look.top < workingSeen.top)
        if (moved) { finishedBy = KLING_DONE_BY.working_gone; break }
      }
    }
    await deps.sleep(pollMs)
  }
  const tail = (): { log_missing?: boolean } => (logMissing ? { log_missing: true } : {})
  const done = (out: KlingVideoOutcome): KlingVideoOutcome => {
    say(out.kind === 'ready' ? `下完了:${out.path}` : `没成:${out.why}`)
    return out
  }
  if (finishedBy === undefined) {
    return done({
      kind: 'failed',
      why: `等了 ${finishMinutes} 分钟,可灵还没说做完 —— 片子做好会在可灵右边那一列里`,
      ...tail(),
    })
  }
  say(`做完了:${finishedBy}${logMissing ? '(可灵日志一次都没读到)' : ''}`)
  const byDownload = finishedBy === KLING_DONE_BY.download
  /* ★ 她自己点了下载时「那一刻之后」从按生成那一刻算 —— 她点的那一下在我们认出来之前。 */
  const watchFrom = byDownload ? input.since : deps.now() - 1000

  /*
   * ① 等最新那条结果卡切到完成态。两眼看到的条数与最上面那条的位置都一样才算稳住 ——
   * 卡刚插进列表那几百毫秒里按下去,按的是一个正在移动的目标。她自己点了下载的那一单不用等(也不按)。
   */
  const cardTick = deps.cardTickMs ?? KLING_CARD_TICK_MS
  let tied = false
  let settled = false
  let last: KlingCardLook | undefined
  for (let i = 0; i < (deps.cardTries ?? KLING_CARD_TRIES) && !settled && !tied && !byDownload; i += 1) {
    if (i > 0) await deps.sleep(cardTick)
    const look = klingCardLook((await read(deps.helper))?.tail ?? [])
    if (look.tied) { tied = true; break }
    const steady = look.done > 0 && !look.working
    settled = steady && last !== undefined && last.done === look.done && last.top === look.top
    last = steady ? look : undefined
  }

  /*
   * ② 按下去,再核对可灵自己记的 `Download started`。她自己已经点上了就一下都不按(别下两份)。
   */
  let pressed = 0
  let menu = false
  /** 下起来了没有。日志那一条是正路;「下载」文件夹里真多了一个文件同样算(日志读不到时就剩这一条)。 */
  const downloadSeen = async (): Promise<boolean> =>
    klingDownloadStartedSince(await readLog(), watchFrom) || (await deps.findDownload?.(watchFrom).catch(() => undefined)) !== undefined
  let started = await downloadSeen()
  if (!tied && !byDownload) {
    for (let attempt = 0; attempt < KLING_PRESS_TRIES && !started && !menu; attempt += 1) {
      if (attempt > 0) await deps.sleep(cardTick)
      const press = await pressDownload(deps)
      if (press.pressed) pressed += 1
      say(`按下载:第 ${attempt + 1} 次,${press.pressed ? '按下去了' : '没按下去'}${press.menu ? ',弹了菜单' : ''}`)
      /*
       * 弹出来的是那张菜单(里面有「去除水印」—— 改她账号设置、还要同意条款)**就不再按第二下**:
       * 壳没有收菜单的 op,第二下合成点击会落在菜单盖住的那一块上,可能正好点在那个开关上。一下都不冒这个险。
       */
      menu = press.menu
      if (!press.pressed) continue
      const startBy = deps.now() + (deps.startWindowMs ?? KLING_DOWNLOAD_START_MS)
      while (deps.now() < startBy && !started) {
        await deps.sleep(Math.min(cardTick, 1000))
        started = await downloadSeen()
      }
    }
  }
  if (tied) say('结果列最上面两条并排着,分不出哪条新,一下都没点')
  else if (!byDownload) say(started ? '可灵开始下载了' : '按完没见可灵开始下载')

  /*
   * ③ 等它下完。**没按成也接着盯** —— 10-13 14:19 就是维护者自己在可灵里点了下载,落在这个窗口里救回来的。
   * ★ 2026-10-13 晚(卡 O):日志里没有「Download completed」时,看一眼「下载」文件夹里新冒出来的那个片子。
   * ★ 2026-10-13 22:06(卡 R):那个片子要**大小停住 3 秒**才认 —— 可灵直接写最终文件名,刚冒出来的是半截。
   */
  const downloadBy = deps.now() + (deps.downloadTimeoutMs ?? 2 * 60_000)
  /**
   * ★ 文件夹那条旁路看到的片子与它**停住**多久了(卡 R)。可灵直接写最终那个名字,刚冒出来的是半截;
   * 同一条路径、同一个字节数连着 {@link KLING_FILE_SETTLE_MS} 没变才算写完。路径或大小一变就重新数。
   */
  let settling: (KlingFreshFile & { since: number }) | undefined
  while (deps.now() < downloadBy) {
    const path = klingDownloadedSince(await readLog(), watchFrom)
    if (path !== undefined) return done({ kind: 'ready', path, ...tail() })
    const fresh = await deps.findDownload?.(watchFrom).catch(() => undefined)
    if (fresh !== undefined && fresh.bytes > 0) {
      if (settling === undefined || settling.path !== fresh.path || settling.bytes !== fresh.bytes) settling = { ...fresh, since: deps.now() }
      else if (deps.now() - settling.since >= KLING_FILE_SETTLE_MS) return done({ kind: 'ready', path: fresh.path, ...tail() })
    }
    await deps.sleep(Math.min(pollMs, 2000))
  }
  if (started || byDownload) return done({ kind: 'failed', why: '可灵做完了,点了下载但没等到它下完 —— 片子在可灵里,也可能在「下载」文件夹', ...tail() })
  if (tied) return done({ kind: 'failed', why: '片子做好了,可灵右边两条片子并排着、分不出哪条是新的,我没敢点 —— 你在可灵里点一下那条片子的下载', ...tail() })
  if (menu) return done({ kind: 'failed', why: '片子做好了,下载那一下没按成(可灵弹了个菜单)—— 你在可灵里点一下', ...tail() })
  return done(pressed === 0
    ? { kind: 'failed', why: '片子做好了,可灵里没认出那条片子的下载键,没按成 —— 你在可灵里点一下', ...tail() }
    : { kind: 'failed', why: '片子做好了,下载那一下没按成 —— 你在可灵里点一下', ...tail() })
}
