/**
 * 一句话 → 一份布局动作草案(2026-09-22,「非标需求由事务官直接改」第一层)。
 *
 * Ben 原话:「我希望用户能用自然语言描述他对布局和模块功能的需求,事务官直接改。」
 * 他给的四个样句就是这个文件的验收标准:
 *
 *   「把消耗数据挪到项目区下面」「把随手记藏起来」「项目区改叫账号」「底部那排高一点」
 *
 * ## 这是一张**词表**,不是一次模型调用
 *
 * 整个文件没有一行 I/O、没有一次 fetch,输入是一个字符串、输出是一份动作数组。三个理由:
 *
 * ① **认不出的不猜**。模型在"他到底想干嘛"这件事上永远有话说;词表没命中就是没命中,
 *    于是「认不出」是一个**可以被用例钉住的状态**,而不是"这次模型心情不好"。
 * ② **复述必须是他自己的话**。确认卡上那句「我把 X 挪到 Y,对吗?」是从命中的词条拼出来的
 *    (同 server/devTool.ts 的 devToolRestate:复述最忌讳复述出他没说过的意思)。
 * ③ 电话里(channel-worker)和界面上走**同一份判据**。词表在服务端,两个入口打同一条
 *    `/butler/item`,不会出现"手机上认得、桌面上不认得"。
 *
 * ## 词表覆盖什么
 *
 * 模块别名要**同时认两套模板的标题**(做产品的「项目区 / 系统文件夹 / 待办事项」与运营的
 * 「账号 / 素材管理 / 选题池」),下面 MODULE_WORDS 旁边那条用例直接拿 templates.ts 的两份
 * `module_titles` 逐个查一遍 —— 以后谁加一个模块、改一个标题,词表没跟上就当场红。
 *
 * ## 三条"宁可不认"的纪律
 *
 * - **带否定词的一律退回**(除了「不要显示」「别藏了」这两组它本身就是词表条目的)。
 *   「别把消耗数据挪上去」不等于「把消耗数据挪下去」,猜反了他得自己再说一遍才发现。
 * - **「所有模块都…」退回**。一句话把整个工作台清空,不该是一次词表命中的后果。
 * - **「删掉 / 去掉」退回并反问**。模块只能收起,删不掉;把"删"当"藏"办,他下次找不到
 *    那一格时会以为东西真没了。
 */
import type { LayoutAct } from './protocol.ts'
import { LAYOUT_DECK_TARGET } from './protocol.ts'
import { DEFAULT_MODULE_TITLES } from './templates.ts'

/** 草案按哪个方向的布局算。与 client/orientation.ts 的 Orientation 同义,这里不 import 它(那个文件带 React)。 */
export type LayoutWordsOrientation = 'portrait' | 'landscape'

export interface LayoutWordsHit {
  ok: true
  /** 确认卡上那一句「我把 X 挪到 Y,对吗?」。**由词表拼,不经模型**。 */
  restate: string
  actions: readonly LayoutAct[]
}

export interface LayoutWordsMiss {
  ok: false
  /** 为什么没认出来。**说给用户听的一句人话**,不是错误码 —— 他要据此换一句话再说一遍。 */
  reason: string
}

export type LayoutWordsResult = LayoutWordsHit | LayoutWordsMiss

export interface LayoutWordsContext {
  orientation: LayoutWordsOrientation
  /**
   * 模块此刻叫什么(复述里要用他看得见的那几个字:运营模板下项目区叫「账号」)。
   * 不给就用 `DEFAULT_MODULE_TITLES`。
   */
  titleOf?: (id: string) => string
}

/**
 * 一次调整加减几个百分点。
 *
 * 6 不是量出来的常数,是**一次点得出来、又点得动**的步长:竖屏模块篇幅夹在 8–70、
 * 横屏底部一排夹在 14–48,6 个点在这两条区间里都是"看得见变了,又不至于一句话就拖到头"。
 * 他说两遍就是 12。可推翻:嫌慢改这一个数,别的地方都不用动。
 */
export const LAYOUT_WORDS_STEP_PCT = 6

/**
 * 模块别名 → 模块 id。
 *
 * **长的必须能先匹配上**:`matchModule` 按别名长度倒序扫,否则「文件」会先吃掉「文件夹」、
 * 「发布」会先吃掉「发布计划」。这一条靠排序保证,不靠书写顺序 —— 书写顺序按模块归类,
 * 人读着方便;匹配顺序由代码算,不会因为有人插了一行而走样。
 *
 * 只收**他真会说出口的**那些。没收「窗口」两个字:它太泛(窗口槽、窗位叠、原生窗、
 * 甚至浏览器窗口都能叫窗口),一个泛词命中的代价是把一句本该退回的话认成了动作。
 */
const MODULE_WORDS: Readonly<Record<string, readonly string[]>> = {
  projects: ['项目区', '项目执行', '项目那格', '账号区', '账号', '项目'],
  slot: ['窗口槽', '窗位槽', '窗位叠', '窗口区', '贴窗区'],
  usage: ['消耗数据', '用量数据', '消耗', '用量'],
  quota: ['余额额度', '余额/额度', '余额 / 额度', '额度', '余额'],
  notes: ['随手记', '便签'],
  // 2026-10-23:这一格改叫「图谱」,旧词保留(布局存档/老说法里还是它们)。
  files: ['系统文件夹', '图谱', '素材管理', '文件夹', '素材', '文件'],
  todo: ['待办事项', '选题池', '待办', '选题'],
  publish: ['发布计划', '发布'],
  review: ['数据复盘', '复盘'],
  // 比 todo 那几个长,从长到短扫时先命中这里(「今天的待办」不会被认成「待办」那一格)。
  today: ['今天的待办', '今天待办', '今日待办'],
}

/** 扁平化 + 按长度倒序,匹配时从长到短扫。 */
const MODULE_ENTRIES: readonly (readonly [string, string])[] = Object.entries(MODULE_WORDS)
  .flatMap(([id, words]) => words.map(word => [word, id] as const))
  .sort((left, right) => right[0].length - left[0].length)

/** 底部那一排(横屏)的说法。它不是模块,所以单独一张表。 */
const DECK_WORDS: readonly string[] = [
  '底部那一排', '底部那排', '底部一排', '底部那一行', '底下那一排', '底下那排',
  '最底下那排', '最下面那排', '下面那排', '底部', '底下那一行',
]

/** 右侧栏(横屏)的说法。「项目区下面」另走一条(它带着参照物)。 */
const SIDE_WORDS: readonly string[] = ['右侧栏', '右边栏', '右栏', '侧栏', '右边那一栏', '右边那栏']

const HIDE_WORDS: readonly string[] = [
  '藏起来', '藏一下', '收起来', '隐藏起来', '隐藏', '不要显示', '不显示', '别显示', '不想看见', '收起', '藏',
]
const SHOW_WORDS: readonly string[] = [
  '显示出来', '放出来', '露出来', '展开', '重新显示', '恢复显示', '别藏了', '不要藏', '不用藏', '显示', '打开',
]
const RENAME_WORDS: readonly string[] = [
  '改名叫', '改名为', '改名成', '名字改成', '名字改叫', '重命名为', '重命名成', '改叫', '叫做', '改成',
]
/** 「删掉」不是「藏起来」。命中这一档一律退回并反问 —— 模块删不掉,只能收起。 */
const DELETE_WORDS: readonly string[] = ['删掉', '删除', '去掉', '干掉', '拿掉', '扔掉']

const TALLER_WORDS: readonly string[] = ['高一点', '高一些', '高点', '再高', '加高', '高些', '长高']
const SHORTER_WORDS: readonly string[] = ['矮一点', '矮一些', '矮点', '低一点', '压低', '变矮', '矮些']
const WIDER_WORDS: readonly string[] = ['宽一点', '宽一些', '宽点', '加宽', '宽些', '变宽']
const NARROWER_WORDS: readonly string[] = ['窄一点', '窄一些', '窄点', '变窄', '窄些', '收窄']

const UP_WORDS: readonly string[] = ['往上挪', '往上移', '上移', '挪上去', 'move up', '往上']
const DOWN_WORDS: readonly string[] = ['往下挪', '往下移', '下移', '挪下去', '往下']
const LEFT_WORDS: readonly string[] = ['往左挪', '往左移', '左移', '挪左边', '往左']
const RIGHT_WORDS: readonly string[] = ['往右挪', '往右移', '右移', '挪右边', '往右']

/**
 * 否定词。命中就走「宁可不认」那一支,除非整句同时落在下面两组"本身就是词条"的说法上。
 *
 * 「别」单独一个字太常见了(**特别**、区别、级别、性别…),所以它不走 `includes`,
 * 走下面 `NEGATION_BIE` 那条带 lookbehind 的正则 —— 「项目区改叫一个特别长的名字」
 * 里那个「别」不是否定,把它当否定的话这句合法的改名会被退回。
 */
const NEGATIONS: readonly string[] = ['不要', '不用', '不想', '甭', '不许', '不准']
const NEGATION_BIE = /(?<![特分个差区级类性派识辨告送离])别/
/** 带否定字、但**本身就是一条词表**的说法。分两组:这一组的意思是「藏」。 */
const NEGATION_HIDE_WORDS: readonly string[] = ['不要显示', '不显示', '别显示', '不想看见']
/** 这一组的意思是「显示」。**必须比 HIDE 先判** —— 「别藏了」里的「藏」会先命中藏那一档。 */
const NEGATION_SHOW_WORDS: readonly string[] = ['别藏了', '别藏着', '不要藏', '不用藏', '别收起来']
const NEGATION_ALLOWED: readonly string[] = [...NEGATION_HIDE_WORDS, ...NEGATION_SHOW_WORDS]

/** 「所有模块都藏起来」这一类。一句话清空工作台不该是一次词表命中的后果。 */
const ALL_WORDS: readonly string[] = ['所有模块', '全部模块', '每个模块', '所有的模块', '全部的格子', '所有格子']

/**
 * 改完之后说的那一句。
 *
 * **它必须把那个口令原样写出来**:「撤销」这个词只有出现在这句话里,他才知道可以说。
 * 一句"已完成"什么都没教会他 —— 而这一层的整个安全网就是"说一句就能回去"。
 * 与 `UNDO_WORDS` 同住一个文件,改口令时两处一起看得见。
 */
export const LAYOUT_DONE_LINE = '挪好了,不合适说「撤销」。'

/** 「撤销」。**只认整句**,不认包含 —— 「这条撤销规则要改一下」不该把上一次改动回退掉。 */
const UNDO_WORDS: readonly string[] = [
  '撤销', '撤销吧', '撤回', '撤回吧', '还原', '还原吧', '回退', '回退吧', '恢复原样', '改回去', '改回来', 'undo',
]

/** 说话时常带的尾巴,认名字之前削掉。 */
const TAIL_WORDS: readonly string[] = ['谢谢', '好吗', '行吗', '可以吗', '吧', '呗', '啊', '呀', '哦', '。', '!', '~']

function includesAny(text: string, words: readonly string[]): string | undefined {
  return words.find(word => text.includes(word))
}

/** 归一化:两端空白、全角标点换半角、多余空格压掉。**不动中文字符本身**。 */
export function normalizeLayoutSentence(text: string): string {
  return text
    .replace(/[，、]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 这句话是不是「撤销」。**整句匹配**,不是包含匹配。
 *
 * 他刚被告知「不合适说『撤销』」,那一刻他会只打这两个字。一句长话里出现「撤销」二字
 * (「把撤销按钮做大一点」)绝不能触发回退 —— 回退是有副作用的,宁可不认。
 */
export function isLayoutUndoWord(text: string): boolean {
  let s = normalizeLayoutSentence(text).toLowerCase()
  for (const tail of TAIL_WORDS) {
    while (s.endsWith(tail)) s = s.slice(0, -tail.length).trim()
  }
  return UNDO_WORDS.includes(s)
}

/** 从一句话里认出第一个模块(按别名长度从长到短)。回 `{ id, word, at }`,没有就 undefined。 */
function matchModule(text: string): { id: string, word: string, at: number } | undefined {
  let best: { id: string, word: string, at: number } | undefined
  for (const [word, id] of MODULE_ENTRIES) {
    const at = text.indexOf(word)
    if (at === -1) continue
    // 位置靠前的优先;位置相同(一个别名是另一个的前缀)时长的优先——MODULE_ENTRIES
    // 已经按长度倒序,所以先命中的那个就是长的,这里只需要"更靠前才换"。
    if (best === undefined || at < best.at) best = { id, word, at }
  }
  return best
}

/** 认第二个模块(用于 swap):把第一个的字样挖掉再认一次。 */
function matchSecondModule(text: string, first: { word: string, at: number }): { id: string, word: string, at: number } | undefined {
  const rest = `${text.slice(0, first.at)}${' '.repeat(first.word.length)}${text.slice(first.at + first.word.length)}`
  return matchModule(rest)
}

function miss(reason: string): LayoutWordsMiss {
  return { ok: false, reason }
}

/** 削掉尾巴与包裹的引号,剩下的就是他要的那几个字。 */
function cleanName(raw: string): string {
  let name = raw.trim()
  for (const tail of TAIL_WORDS) {
    while (name.endsWith(tail)) name = name.slice(0, -tail.length).trim()
  }
  name = name.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim()
  return name
}

/** 标题最多几个字。同 devTool 的 MAX_NAME:模块头上那一条写不下更多。 */
export const LAYOUT_MAX_TITLE = 10

/**
 * 一句话 → 一份动作草案。认不出就 `{ ok:false, reason }`,**绝不猜一个动作交上去**。
 */
export function parseLayoutWords(text: string, ctx: LayoutWordsContext): LayoutWordsResult {
  const raw = normalizeLayoutSentence(text)
  if (raw === '') return miss('这句话是空的。')
  const title = (id: string): string => ctx.titleOf?.(id) ?? DEFAULT_MODULE_TITLES[id] ?? id

  // ① 「所有模块都…」。一次命中清空整个工作台,不做。
  const all = includesAny(raw, ALL_WORDS)
  if (all !== undefined) {
    return miss(`「${all}」这种一次改一片的我不做 —— 一格一格说,我一次改一格。`)
  }

  // ② 否定。除了那几个本身就是词条的说法,一律退回:猜反了他得自己再说一遍才发现。
  const negation = includesAny(raw, NEGATIONS) ?? (NEGATION_BIE.test(raw) ? '别' : undefined)
  if (negation !== undefined && includesAny(raw, NEGATION_ALLOWED) === undefined) {
    return miss(`这句里有「${negation}」,我怕理解反了。直接说要它变成什么样,比如「把随手记藏起来」。`)
  }

  // ③ 「删掉」。模块只能收起,删不掉 —— 反问一句,不替他当成「藏」办了。
  const deleteWord = includesAny(raw, DELETE_WORDS)
  if (deleteWord !== undefined) {
    return miss(`模块${deleteWord}不了,只能藏起来(以后还能再显示)。你是要藏起来吗?`)
  }

  // ④ 改名。**先于别的动作判**:「项目区改叫账号」里「账号」本身也是一个模块别名,
  //    不先把改名切出来,右边那个名字会被当成第二个模块。
  const renameWord = RENAME_WORDS.find(word => raw.includes(word))
  if (renameWord !== undefined) {
    const at = raw.indexOf(renameWord)
    const left = raw.slice(0, at)
    const name = cleanName(raw.slice(at + renameWord.length))
    const target = matchModule(left)
    if (target === undefined) return miss(`「${renameWord}」前面没说是哪一格。比如「项目区改叫账号」。`)
    if (name === '') return miss(`「${renameWord}」后面没说新名字叫什么。`)
    if (name.length > LAYOUT_MAX_TITLE) {
      return miss(`新名字最多 ${LAYOUT_MAX_TITLE} 个字(模块头上那条写不下更多),「${name}」太长了。`)
    }
    return {
      ok: true,
      restate: `我把「${title(target.id)}」改叫「${name}」,对吗?`,
      actions: [{ kind: 'rename', module: target.id, title: name }],
    }
  }

  // ⑤ 高矮宽窄。目标可以是一个模块,也可以是横屏底部那一整排。
  const sizeHit
    = includesAny(raw, TALLER_WORDS) !== undefined ? { axis: 'height' as const, sign: 1, word: includesAny(raw, TALLER_WORDS) as string }
      : includesAny(raw, SHORTER_WORDS) !== undefined ? { axis: 'height' as const, sign: -1, word: includesAny(raw, SHORTER_WORDS) as string }
        : includesAny(raw, WIDER_WORDS) !== undefined ? { axis: 'width' as const, sign: 1, word: includesAny(raw, WIDER_WORDS) as string }
          : includesAny(raw, NARROWER_WORDS) !== undefined ? { axis: 'width' as const, sign: -1, word: includesAny(raw, NARROWER_WORDS) as string }
            : undefined
  if (sizeHit !== undefined) {
    const deckWord = includesAny(raw, DECK_WORDS)
    const target = matchModule(raw)
    // 底部那一排:只有横屏有这个东西。竖屏如实说一句,不拿"最下面那个模块"顶替。
    if (deckWord !== undefined && target === undefined) {
      if (ctx.orientation !== 'landscape') {
        return miss('竖屏没有「底部那一排」这回事(那是横屏才有的)。说哪一格,我改那一格。')
      }
      if (sizeHit.axis === 'width') return miss('底部那一排是横着的,只能调高矮,调不了宽窄。')
      return {
        ok: true,
        restate: `我把底部那一排调${sizeHit.sign > 0 ? '高' : '矮'}一点,对吗?`,
        actions: [{
          kind: 'resize',
          module: LAYOUT_DECK_TARGET,
          axis: 'height',
          delta_pct: sizeHit.sign * LAYOUT_WORDS_STEP_PCT,
        }],
      }
    }
    if (target === undefined) return miss(`「${sizeHit.word}」说的是哪一格?我没听出来。`)
    const word = sizeHit.axis === 'height' ? (sizeHit.sign > 0 ? '高' : '矮') : (sizeHit.sign > 0 ? '宽' : '窄')
    return {
      ok: true,
      restate: `我把「${title(target.id)}」调${word}一点,对吗?`,
      actions: [{
        kind: 'resize',
        module: target.id,
        axis: sizeHit.axis,
        delta_pct: sizeHit.sign * LAYOUT_WORDS_STEP_PCT,
      }],
    }
  }

  // ⑥ 藏 / 显示。**「别藏了」这一组先判** —— 它里面那个「藏」会先命中藏那一档,
  //    而他要的正好是反过来的那件事。
  const negShow = includesAny(raw, NEGATION_SHOW_WORDS)
  const hideWord = negShow === undefined ? includesAny(raw, HIDE_WORDS) : undefined
  const showWord = negShow ?? includesAny(raw, SHOW_WORDS)
  // 「不要显示」同时落在 HIDE(整词)与 SHOW(「显示」)上 —— HIDE 那条更长、更贴他的意思,
  // 所以 hide 优先判。两边都空才往下走。
  if (hideWord !== undefined || showWord !== undefined) {
    const target = matchModule(raw)
    if (target === undefined) return miss(`「${hideWord ?? showWord as string}」说的是哪一格?我没听出来。`)
    if (hideWord !== undefined) {
      return {
        ok: true,
        restate: `我把「${title(target.id)}」藏起来,对吗?`,
        actions: [{ kind: 'hide', module: target.id }],
      }
    }
    return {
      ok: true,
      restate: `我把「${title(target.id)}」放出来,对吗?`,
      actions: [{ kind: 'show', module: target.id }],
    }
  }

  // ⑦ 换位:「把随手记和系统文件夹换个位置」。
  if (raw.includes('换位') || raw.includes('换个位置') || raw.includes('对调') || raw.includes('调换')) {
    const first = matchModule(raw)
    const second = first === undefined ? undefined : matchSecondModule(raw, first)
    if (first === undefined || second === undefined) {
      return miss('换位要说清是哪两格,比如「把随手记和系统文件夹换个位置」。')
    }
    return {
      ok: true,
      restate: `我把「${title(first.id)}」和「${title(second.id)}」换个位置,对吗?`,
      actions: [{ kind: 'swap', module: first.id, other: second.id }],
    }
  }

  // ⑧ 挪。先看有没有参照物(「项目区下面」/「右侧栏」/「底部那排」),再看光秃秃的方向词。
  const target = matchModule(raw)
  if (target === undefined) return miss('这句话里没提到我认得的模块。')

  // ⑧a 「挪到项目区下面」——Ben 那句原话。横屏下 = 进右侧栏(项目区钉在最上,进来就落在它下面)。
  const belowProjects = /(项目区|账号|项目)\s*(的)?\s*(下面|下边|底下|之下|下方)/.test(raw)
  const sideWord = includesAny(raw, SIDE_WORDS)
  if ((belowProjects && target.id !== 'projects') || sideWord !== undefined) {
    if (ctx.orientation !== 'landscape') {
      return miss('竖屏是一列一列往下堆的,没有「右侧栏」这个地方 —— 竖屏我只会把它往上/往下挪一格。')
    }
    return {
      ok: true,
      restate: `我把「${title(target.id)}」挪到右侧栏、「${title('projects')}」下面,对吗?`,
      actions: [{ kind: 'region', module: target.id, region: 'side' }],
    }
  }

  // ⑧b 「挪回底部那排」。
  const deckWord = includesAny(raw, DECK_WORDS)
  if (deckWord !== undefined) {
    if (ctx.orientation !== 'landscape') {
      return miss('竖屏没有「底部那一排」这回事(那是横屏才有的)。')
    }
    return {
      ok: true,
      restate: `我把「${title(target.id)}」挪回底部那一排,对吗?`,
      actions: [{ kind: 'region', module: target.id, region: 'deck' }],
    }
  }

  // ⑧c 光秃秃的方向词:上/下/左/右,各挪一格。
  const dir
    = includesAny(raw, UP_WORDS) !== undefined ? 'up' as const
      : includesAny(raw, DOWN_WORDS) !== undefined ? 'down' as const
        : includesAny(raw, LEFT_WORDS) !== undefined ? 'left' as const
          : includesAny(raw, RIGHT_WORDS) !== undefined ? 'right' as const
            : undefined
  if (dir === undefined) {
    return miss(`我听出你说的是「${title(target.id)}」,但没听出要把它怎么样。说个方向(上/下/左/右)、或者「藏起来」「改叫…」「高一点」。`)
  }
  const dirWord = { up: '上', down: '下', left: '左', right: '右' }[dir]
  return {
    ok: true,
    restate: `我把「${title(target.id)}」往${dirWord}挪一格,对吗?`,
    actions: [{ kind: 'move', module: target.id, dir }],
  }
}

/** 词表里认得的全部模块 id(用例拿它跟 MODULE_IDS 对表)。 */
export function layoutWordModuleIds(): readonly string[] {
  return Object.keys(MODULE_WORDS)
}
