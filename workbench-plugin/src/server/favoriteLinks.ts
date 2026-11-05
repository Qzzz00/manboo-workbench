/**
 * 「收藏网址」(2026-09-21,白板第一节:素材管理里 Ben 草图上第一格就是它)。
 *
 * 一个文件、一行一条:`- [标题](链接) —— 备注`。这个模块**一行 I/O 都没有** ——
 * 解析、格式化、追加、查重全是纯函数;建文件在 `templateStore.ts`(切到运营模板时种一份),
 * 往里写的人是**事务官**(技能 `docs/技能/运营-收藏网址.md`),不是这段代码。
 *
 * ## 为什么是 markdown 链接语法,不是 `标题 | 链接 | 备注`
 *
 * 这个文件他自己会打开改(素材管理那一格点进去就是它)。三种候选:
 *
 * - `标题 | 链接 | 备注` —— 标题里出现 `|` 就散架,而中文标题里 `|` 少见但 `,`「·」很常见,
 *   换成别的分隔符同样有这个问题;
 * - 一行一个裸链接 —— 存得下,但一个月后他看着一屏 `https://…` 认不出哪个是哪个;
 * - **`- [标题](链接) —— 备注`** —— 标题里可以有任何字符(除了 `]`),
 *   在任何 markdown 预览里都是一条能点的链接,而且他手写起来跟平时写笔记一样。
 *
 * 取舍代价:标题里带 `]` 的会解析不出来。这种时候**整行原样留着**(见 `parseFavoriteLinks`
 * 的 `raw` 那一支)—— 解析不出来不等于可以丢掉他的行。
 *
 * ## 只追加,不重排
 *
 * `appendFavoriteLink` 只在文件末尾加一行。不排序、不去重整份文件、不动他自己写的行 ——
 * 一个"顺手帮你整理了一下"的写入,会让他再也不敢在这个文件里手写东西。
 */

/** 收藏网址那个文件在工作目录下的相对路径。**一处写死**(templates.ts 里也引这一份)。 */
export { OPS_FAVORITES_REL } from '../templates.ts'
import { OPS_FAVORITES_REL } from '../templates.ts'

export interface FavoriteLink {
  /** 显示名。他没起名时是域名(技能里会在备注里说明这一点)。 */
  title: string
  url: string
  /** 他顺口说的那句话。没有就缺席 —— **不编一句用途**。 */
  note?: string
}

export interface FavoriteLine {
  /** 认出来的那一条。认不出来时缺席,`raw` 仍在。 */
  link?: FavoriteLink
  /** 这一行的原文。认不出来的行靠它原样留着。 */
  raw: string
}

/** `- [标题](链接) —— 备注`,备注可以没有。破折号认 `——`、`—`、`--` 三种写法。 */
const LINE_RE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:(?:——|—|--)\s*(.*))?$/

/** 没有标题、只有一个裸链接的行:`- https://…  备注`。他手写时最可能是这个样子。 */
const BARE_RE = /^\s*[-*]\s*(https?:\/\/\S+)\s*(?:(?:——|—|--)?\s*(.*))?$/

/**
 * 读出所有条目。**认不出来的行不算条目,但也不丢**(调用方要能原样写回去)。
 *
 * 裸链接那一支的标题回的是链接本身 —— 不去猜一个标题(要猜就得打开它,那是联网)。
 */
export function parseFavoriteLinks(text: string): FavoriteLine[] {
  const out: FavoriteLine[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim() === '') continue
    const matched = LINE_RE.exec(raw)
    if (matched !== null) {
      const note = matched[3]?.trim()
      out.push({
        raw,
        link: {
          title: (matched[1] ?? '').trim(),
          url: (matched[2] ?? '').trim(),
          ...(note === undefined || note === '' ? {} : { note }),
        },
      })
      continue
    }
    const bare = BARE_RE.exec(raw)
    if (bare !== null) {
      const note = bare[2]?.trim()
      const url = (bare[1] ?? '').trim()
      out.push({ raw, link: { title: url, url, ...(note === undefined || note === '' ? {} : { note }) } })
      continue
    }
    out.push({ raw })
  }
  return out
}

/** 只要认出来的那几条(界面与查重用)。 */
export function favoriteLinksOf(text: string): FavoriteLink[] {
  return parseFavoriteLinks(text).flatMap(line => (line.link === undefined ? [] : [line.link]))
}

/** 写成一行。备注为空就不写破折号 —— 一行末尾挂一个光秃秃的「——」很难看,也会被读成"备注是空的"。 */
export function formatFavoriteLink(link: FavoriteLink): string {
  const note = link.note?.trim()
  const title = link.title.trim() === '' ? link.url : link.title.trim()
  return `- [${title}](${link.url})${note === undefined || note === '' ? '' : ` —— ${note}`}`
}

/**
 * 查重用的归一化:去掉首尾空白、去掉末尾的 `/`、协议与域名按小写比。
 *
 * **查询串一个字都不动** —— `?id=1` 和 `?id=2` 是两个不同的页面,
 * 而 UTM 那类跟踪参数要不要去掉是**他的事**(去掉就是替他改了他粘过来的链接)。
 */
export function normalizeFavoriteUrl(url: string): string {
  const trimmed = url.trim()
  const matched = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(trimmed)
  const rest = matched === null ? trimmed : `${(matched[1] ?? '').toLowerCase()}${(matched[2] ?? '').toLowerCase()}${matched[3] ?? ''}`
  return rest.endsWith('/') ? rest.slice(0, -1) : rest
}

/** 这个链接是不是已经在里面了。在的话把已有那一条回出去(技能要念出它的标题)。 */
export function findFavoriteLink(text: string, url: string): FavoriteLink | undefined {
  const want = normalizeFavoriteUrl(url)
  return favoriteLinksOf(text).find(link => normalizeFavoriteUrl(link.url) === want)
}

/** 新文件的头。**技能里那段格式说明也在这儿** —— 他打开文件就知道怎么手写一行。 */
export function favoritesSeedText(): string {
  return [
    '# 收藏网址',
    '',
    '> 一行一条:`- [标题](链接) —— 备注`。你可以直接在这里改、直接手写一行。',
    '> 工作台的素材管理那一格里点「收藏网址」就能找到这个文件;',
    '> 跟事务官说「把这个链接收藏一下」,它也往这里追加。',
    '',
  ].join('\n')
}

export interface AppendFavoriteResult {
  text: string
  added: boolean
  /** 没加的时候为什么(已经有了)。加了就缺席。 */
  reason?: string
  /** 已经有了时,已有的那一条。 */
  existing?: FavoriteLink
}

/**
 * 追加一行。**已经有同一个链接就不加**(回 `added: false` 与已有那一条)。
 *
 * 文件是空的 / 不存在(传 `undefined`)时先垫一份头再追加 —— 一个只有一行 `- [x](y)`
 * 的文件,他打开之后不知道该怎么往下写。
 */
export function appendFavoriteLink(
  text: string | undefined,
  link: FavoriteLink,
): AppendFavoriteResult {
  const base = text === undefined || text.trim() === '' ? favoritesSeedText() : text
  const existing = findFavoriteLink(base, link.url)
  if (existing !== undefined) {
    return { text: base, added: false, reason: '这个链接已经在收藏里了', existing }
  }
  const body = base.endsWith('\n') ? base : `${base}\n`
  return { text: `${body}${formatFavoriteLink(link)}\n`, added: true }
}

/** 收藏网址那个文件的绝对路径。工作目录没配时回 undefined(**不猜一个路径**)。 */
export function favoritesFilePath(butlerCwd: string | undefined): string | undefined {
  if (butlerCwd === undefined || butlerCwd === '') return undefined
  return `${butlerCwd}/${OPS_FAVORITES_REL}`
}
