/**
 * 采集类三项的**纯解析层**(2026-09-22)。链接怎么认、页面数据怎么读成结构、
 * 评论怎么挑、落盘那两份 markdown 长什么样 —— 全在这里,**一行 I/O 都没有**。
 *
 * 依据:决策记录 2026-09-22 待拍板回复 B1/B7「采集类用开源项目,能采就采」、
 * B2「承诺维持『不点』,只采集(滚动不算点)」;
 * `docs/调研/采集类预研-小红书评论笔记与爆款拆解-2026-09-21.md` 第三节那七条红线;
 * 运营同事白板第二节:评论 ≤100 条、优先高赞、不采子评论;笔记采标题/短文案/标签/源图文或视频。
 *
 * ## ★ 这份文件里的「开源项目」是怎么用的(许可证判断写在这里,别处不重复)
 *
 * 选的是 **[xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)**
 * (2026-09-21 实测:15,905 ★、当天有提交、**Apache-2.0**)。
 * 但**只借它对页面数据结构的知识**,不引入它一行代码、不引入 go-rod、
 * **不引入它的 `go-rod/stealth`,也不引入它的 `humanize/`(模拟人类鼠标、点击、打字)**。
 *
 * 借的是这一条事实:登录态下的笔记页上,`window.__INITIAL_STATE__.note.noteDetailMap[<笔记id>]`
 * 里有 `{ note, comments }` 两块,字段名见下面那几个 interface
 * (对应它 `xiaohongshu/types.go` 的 `FeedDetail` / `CommentList`,与
 * `xiaohongshu/feed_detail.go` 的 `extractFeedDetail`)。风控页那张关键词表
 * ({@link BLOCKED_WORDS})同样取自它的 `checkPageAccessible`,并补上了我们自己
 * 2026-09-21 实测到的 `300031 当前笔记暂时无法浏览`。
 *
 * **为什么不直接依赖它**(这一条要 Ben 能推翻,所以写全):
 * 它的仓库里同时有 `like_favorite.go`(点赞收藏)、`publish.go` / `publish_video.go`(发布)、
 * `comment_feed.go`(发评论、回复评论)、`search.go`(关键词搜索)、`humanize/mouse.go`。
 * 把它作为依赖装进 dmg,等于**把「点赞 / 发布 / 发评论 / 关键词搜索 / 伪装人类输入」
 * 这些能力一起装进产品**,而预研第 3.4 节那七条红线里,第 1、3、4 条各自被它破掉一条。
 * 我们最值钱的资产是「代码里没有一行能点东西」这句话是真的 —— 引入它这句话当场不成立。
 *
 * **许可证判断**(下一个人不用重查):
 * - `xiaohongshu-mcp` **Apache-2.0**:允许商用、允许修改,要求保留版权与许可证声明。
 *   我们**没有复制它的代码**(Go → 这里是重写的 TypeScript),借的是接口形状这类事实;
 *   出处仍逐条写在注释里(上面那几行),这比 Apache-2.0 要求的更多,不会少。
 * - `yt-dlp` **Unlicense**(公有领域):它的 `XiaoHongShuIE` 也是读同一个
 *   `__INITIAL_STATE__` → `note.video.media.stream[].masterUrl`。同样只借思路,不引入代码,
 *   **也不喂 cookie 给它**(喂 cookie 就必须把 cookie 写进文件,直接破红线第 5 条)。
 * - **明确排除** `NanmiCoder/MediaCrawler`(65,451 ★,但 LICENSE 是作者自写的
 *   《非商业学习使用许可证》,GitHub 标 NOASSERTION,**明写禁止商用**)、
 *   `JoeanAmier/XHS-Downloader`(12,786 ★,**GPL-3.0**,打进 dmg 会传染到整个产品)、
 *   `cv-cat/Spider_XHS`(7,782 ★,**仓库里没有 LICENSE 文件** = 默认保留全部著作权)。
 *   三个数字都是 2026-09-21 当天用 `gh api repos/<owner>/<name>` 亲自拉的。
 *
 * ## 红线在这个文件里的落点
 *
 * - **只从用户自己给的链接进**:{@link parseNoteLink} 只认**一条笔记的详情地址**。
 *   搜索页、博主主页、话题页、发现页一律拒绝 —— 那是"遍历"的入口,不是"他本来就点开的那一页"。
 * - **不采子评论**:{@link pickTopComments} 里 `subComments` 一个字都不读。
 * - **≤100 条、优先高赞**:同上,先按赞数降序再切。
 * - **一个凭据都不取**:这份文件里没有 cookie / localStorage / token 这些词,
 *   落盘的两份 markdown 里也不会出现(用例逐字钉着)。
 */

/** 一次采集最多留多少条评论。白板原话:单次 ≤100 条。 */
export const COMMENT_MAX = 100

/** 采集产物落在工作目录下的哪个文件夹。与「会议」那一格同一条约定(`<工作目录>/<中文目录名>/`)。 */
export const COLLECT_DIR_NAME = '采集'

/** 那个文件夹里的两份产物。**一处定义**,服务层与用例都读这一份。 */
export const NOTE_FILE_NAME = '笔记.md'
export const COMMENTS_FILE_NAME = '评论.md'
/** 爆款拆解那一份(C6:必须带时间戳段落)。 */
export const BREAKDOWN_FILE_NAME = '拆解.md'
/** 机器转写的逐字稿(带时间戳)。拆解.md 里每一段都回指它。 */
export const TRANSCRIPT_FILE_NAME = '逐字稿.md'

/** 目录名里标题最多留多少个字(同 meetingText 的口径)。 */
const TITLE_MAX = 40

/** 标题读不出来时目录叫什么。**不编一个标题**,就叫「无标题笔记」。 */
export const UNTITLED = '无标题笔记'

/**
 * 风控 / 不可见页面的关键词。
 *
 * 前十条取自 `xiaohongshu-mcp` 的 `checkPageAccessible`(Apache-2.0);
 * 最后两条是我们自己 2026-09-21 实测抓到的匿名闸(`error_code=300031`)。
 * **命中任何一条 = 停下如实说,不重试、不绕过**(红线第 7 条)。
 */
export const BLOCKED_WORDS: readonly string[] = [
  '当前笔记暂时无法浏览',
  '该内容因违规已被删除',
  '该笔记已被删除',
  '内容不存在',
  '笔记不存在',
  '已失效',
  '私密笔记',
  '仅作者可见',
  '因用户设置，你无法查看',
  '因违规无法查看',
  '300031',
  '你访问的页面不见了',
]

/** 验证码 / 人机校验页的关键词。命中 = **停下**,我们绝不过验证码(红线,3.5 节第一条)。 */
export const CAPTCHA_WORDS: readonly string[] = [
  '滑动验证',
  '拖动滑块',
  '安全验证',
  '人机验证',
  '请完成验证',
  // ★ 这里**故意不放** `verifyMsg`。2026-09-22 真跑:风控那张 404 页的跳转地址里
  //   就带着一个**空的** `verifyMsg=`(`...&error_code=300031&...&verifyMsg=`),
  //   拿它当判据会把"这条笔记被风控挡了"误报成"要你做人机验证" ——
  //   后者会让他去那个窗口里找一个根本不存在的滑块。宁可少认一种,不要认错一种。
]

/** 登录页的关键词(与 `href` 里的 `/login` 互为旁证:一个看 URL,一个看文字)。 */
export const LOGGED_OUT_WORDS: readonly string[] = [
  '扫码登录',
  '短信登录',
  '登录后查看',
  '新用户可直接登录',
]

// ───────────────────────── 链接 ─────────────────────────

/** 认出来的一条笔记链接。 */
export interface NoteLink {
  /** 24 位十六进制的笔记 id。 */
  id: string
  /** 真正去打开的那个地址(原样保留 `xsec_token` 这类参数 —— 少了它多半打不开)。 */
  url: string
}

export type NoteLinkResult =
  | { ok: true, link: NoteLink }
  | { ok: false, reason: string }

/** 笔记详情页的两种路径写法(yt-dlp 的 `_VALID_URL` 也是这两条)。 */
const NOTE_PATHS = [/^\/explore\/([0-9a-f]{8,32})$/i, /^\/discovery\/item\/([0-9a-f]{8,32})$/i]

/** 认识的域名。`rednote.com` 是 2026 年换的新域名(yt-dlp issue #16519),同一个站。 */
const NOTE_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'www.rednote.com', 'rednote.com'])

/**
 * 把用户贴的一条链接认成一条笔记。**认不出就拒绝,不猜**。
 *
 * ★ 这个函数就是「只从用户自己给的链接进」那条红线的闸:
 * 它**只认一条笔记的详情地址**。搜索结果页、博主主页、话题页、发现流一律拒绝 ——
 * 那几种是"批量遍历"的入口,而我们和爬虫的分界线正好画在这里。
 *
 * 短链(`xhslink.com`)也拒绝:要用它就得先跟随一次 302,那是**我们自己发起的、
 * 用户没看见的一次请求**,而且预研没验证过它的真实行为。让他把浏览器地址栏里那条给我。
 */
export function parseNoteLink(raw: unknown): NoteLinkResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: '没给链接' }
  const text = raw.trim()
  let parsed: URL
  try { parsed = new URL(text) }
  catch { return { ok: false, reason: '这不是一条网址' } }

  if (parsed.protocol !== 'https:') return { ok: false, reason: '只认 https 的链接' }
  if (parsed.hostname === 'xhslink.com' || parsed.hostname.endsWith('.xhslink.com')) {
    return { ok: false, reason: '这是短链。请在浏览器里打开它,把地址栏里那条完整链接给我 —— 我不替你跳转。' }
  }
  if (!NOTE_HOSTS.has(parsed.hostname)) return { ok: false, reason: '只认小红书的笔记链接' }

  for (const pattern of NOTE_PATHS) {
    const hit = pattern.exec(parsed.pathname)
    if (hit === null) continue
    const id = (hit[1] ?? '').toLowerCase()
    return { ok: true, link: { id, url: parsed.toString() } }
  }
  return {
    ok: false,
    reason: '这不是一条笔记的链接(只认打开某一条笔记时地址栏里那条)。搜索页、博主主页、话题页都不采 —— 那是遍历,不是采集。',
  }
}

// ───────────────────────── 页面数据 ─────────────────────────

/**
 * `__INITIAL_STATE__.note.noteDetailMap[<id>]` 的形状。
 *
 * 字段名取自 `xiaohongshu-mcp` 的 `xiaohongshu/types.go`(Apache-2.0,见文件头)。
 * **全部 optional**:站点随时会改,少一个字段应该是"这一项没采到",不是整条崩掉。
 */
export interface RawNoteUser { nickname?: string, nickName?: string, userId?: string }
export interface RawImage { urlDefault?: string, urlPre?: string }
export interface RawStream { masterUrl?: string, backupUrls?: string[], width?: number, height?: number, videoDuration?: number }
export interface RawVideo { media?: { video?: { duration?: number }, stream?: Record<string, RawStream[]> } }
export interface RawNote {
  noteId?: string
  title?: string
  desc?: string
  type?: string
  time?: number
  ipLocation?: string
  user?: RawNoteUser
  interactInfo?: { likedCount?: string, collectedCount?: string, commentCount?: string, sharedCount?: string }
  imageList?: RawImage[]
  video?: RawVideo
  tagList?: { name?: string, type?: string }[]
}
export interface RawComment {
  id?: string
  content?: string
  likeCount?: string
  createTime?: number
  ipLocation?: string
  userInfo?: RawNoteUser
  subCommentCount?: string
  /** ★ **我们一个字都不读**。写在这里只为了说清楚"它存在,而我们故意不要"。 */
  subComments?: unknown[]
}

/** 采下来的一条笔记(我们自己的形状,不是站点的)。取不到的字段一律缺席,**不补空串**。 */
export interface CollectedNote {
  id: string
  title?: string
  desc?: string
  /** `normal` = 图文,`video` = 视频。读不出来就缺席。 */
  kind?: 'normal' | 'video'
  tags: readonly string[]
  author?: string
  /** 发布时间(ISO)。站点给的是毫秒时间戳。 */
  published_at?: string
  ip?: string
  /** 页面上**原样那串**("1.1万"),不换算 —— 换算过的数对不上他看到的。 */
  likes?: string
  collects?: string
  comments?: string
  /** 图文笔记的图片直链。 */
  images: readonly string[]
  /** 视频直链(挑最大分辨率那一档)。图文笔记没有。 */
  video?: { url: string, width?: number, height?: number, ms?: number }
}

/** 采下来的一条评论。**没有子评论这一项** —— 结构上就装不下。 */
export interface CollectedComment {
  id?: string
  content: string
  /** 页面上原样那串。 */
  likes_raw?: string
  /** 排序用的数。读不出来算 0(**只影响排序,不落盘**)。 */
  likes: number
  author?: string
  at?: string
  ip?: string
  /** 这条底下有几条子评论。**只记个数,不采内容**(白板:不采子评论)。 */
  sub_count?: string
}

export type NotePageState = 'ok' | 'logged_out' | 'blocked' | 'captcha' | 'not_found'

export interface NotePageResult {
  state: NotePageState
  /** 一句人话,界面与记录原样用。 */
  message: string
  note?: CollectedNote
  comments?: readonly CollectedComment[]
  /** 站点说这条笔记一共有多少评论(原样那串)。用来在产物里写明"我只采到了其中几条"。 */
  comment_total?: string
}

/** 「1.1万」这种中文计数读成数。读不出来回 0 —— **只用于排序**,不落盘。 */
export function countOf(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return 0
  const text = raw.trim()
  if (text === '') return 0
  const hit = /^([0-9]+(?:\.[0-9]+)?)\s*(万|亿|w|k)?$/i.exec(text)
  if (hit === null) return 0
  const base = Number(hit[1])
  if (!Number.isFinite(base)) return 0
  switch ((hit[2] ?? '').toLowerCase()) {
    case '万': case 'w': return base * 10_000
    case '亿': return base * 100_000_000
    case 'k': return base * 1_000
    default: return base
  }
}

/** 页面此刻是不是一堵墙(登录 / 风控 / 验证码)。**先判墙再判数据** —— 墙上也可能有半份数据。 */
export function wallOf(href: string, text: string): { state: Exclude<NotePageState, 'ok' | 'not_found'>, message: string } | undefined {
  const hitCaptcha = CAPTCHA_WORDS.find(word => text.includes(word) || href.includes(word))
  if (hitCaptcha !== undefined) {
    return { state: 'captcha', message: `这一页要求做人机验证(页面上写着「${hitCaptcha}」)。我不替你过验证码,这一条就到这儿。` }
  }
  const hitBlocked = BLOCKED_WORDS.find(word => text.includes(word) || href.includes(word))
  if (hitBlocked !== undefined) {
    return { state: 'blocked', message: `这条笔记打不开(页面上写着「${hitBlocked}」)。不重试。` }
  }
  if (href.includes('/login') || LOGGED_OUT_WORDS.some(word => text.includes(word))) {
    return { state: 'logged_out', message: '那个浏览器窗口现在是未登录状态。请在窗口里自己登录一次,我不替你填任何东西。' }
  }
  return undefined
}

/** 从 `stream` 里挑一档。**按像素面积挑最大的**,挑不出来就没有视频 —— 不退回一个糊的。 */
export function pickStream(video: RawVideo | undefined): CollectedNote['video'] {
  const buckets = video?.media?.stream
  if (buckets === undefined || buckets === null) return undefined
  const all: RawStream[] = []
  for (const list of Object.values(buckets)) if (Array.isArray(list)) all.push(...list)
  let best: RawStream | undefined
  for (const one of all) {
    const url = typeof one.masterUrl === 'string' && one.masterUrl !== ''
      ? one.masterUrl
      : (Array.isArray(one.backupUrls) ? one.backupUrls.find(item => typeof item === 'string' && item !== '') : undefined)
    if (url === undefined) continue
    if (best === undefined) { best = one; continue }
    const area = (one.width ?? 0) * (one.height ?? 0)
    const bestArea = (best.width ?? 0) * (best.height ?? 0)
    if (area > bestArea) best = one
  }
  if (best === undefined) return undefined
  const url = typeof best.masterUrl === 'string' && best.masterUrl !== ''
    ? best.masterUrl
    : (best.backupUrls ?? []).find(item => typeof item === 'string' && item !== '')
  if (url === undefined) return undefined
  return {
    url,
    ...(typeof best.width === 'number' ? { width: best.width } : {}),
    ...(typeof best.height === 'number' ? { height: best.height } : {}),
    ...(typeof best.videoDuration === 'number' ? { ms: best.videoDuration } : {}),
  }
}

/** 标签。站点把它放在 `tagList`,正文里同时还写着 `#标签`。两处都取,去重。 */
export function tagsOf(note: RawNote): string[] {
  const out: string[] = []
  for (const tag of note.tagList ?? []) {
    const name = typeof tag?.name === 'string' ? tag.name.trim() : ''
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  for (const hit of (note.desc ?? '').matchAll(/#([^#\s[\]]+)/g)) {
    const name = (hit[1] ?? '').replace(/\[话题\]$/, '').trim()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/** 一条评论,从站点的形状读成我们的。**`subComments` 一个字不读**。 */
export function commentOf(raw: RawComment): CollectedComment | undefined {
  const content = typeof raw?.content === 'string' ? raw.content.trim() : ''
  if (content === '') return undefined
  const author = raw.userInfo?.nickname ?? raw.userInfo?.nickName
  return {
    ...(typeof raw.id === 'string' && raw.id !== '' ? { id: raw.id } : {}),
    content,
    ...(typeof raw.likeCount === 'string' && raw.likeCount !== '' ? { likes_raw: raw.likeCount } : {}),
    likes: countOf(raw.likeCount),
    ...(typeof author === 'string' && author !== '' ? { author } : {}),
    ...(typeof raw.createTime === 'number' && raw.createTime > 0 ? { at: new Date(raw.createTime).toISOString() } : {}),
    ...(typeof raw.ipLocation === 'string' && raw.ipLocation !== '' ? { ip: raw.ipLocation } : {}),
    ...(typeof raw.subCommentCount === 'string' && raw.subCommentCount !== '' && raw.subCommentCount !== '0'
      ? { sub_count: raw.subCommentCount }
      : {}),
  }
}

/**
 * 挑评论:**先按赞数降序,再切到 ≤100 条,子评论一条不要**(白板原话)。
 *
 * 赞数一样时保留站点原来的顺序(稳定排序)—— 不另造一套二级排序,
 * 那会让"为什么这条在前面"变成一个我们自己也说不清的问题。
 */
export function pickTopComments(list: readonly RawComment[], max = COMMENT_MAX): CollectedComment[] {
  const mapped: CollectedComment[] = []
  for (const raw of list) {
    const one = commentOf(raw)
    if (one !== undefined) mapped.push(one)
  }
  return mapped
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.likes - a.item.likes) || (a.index - b.index))
    .slice(0, max)
    .map(pair => pair.item)
}

/**
 * 把浏览器读回来的那一份读成结构。
 *
 * @param payload `JSON.stringify(window.__INITIAL_STATE__.note.noteDetailMap)` 的原文。
 *   读不出来(空串 / 不是 JSON / 里面没有这条笔记)一律**如实说**,不拿半份数据顶。
 */
export function parseNotePayload(payload: string, id: string, href = '', text = ''): NotePageResult {
  const wall = wallOf(href, text)
  if (wall !== undefined) return wall

  if (payload.trim() === '') {
    return { state: 'not_found', message: '这一页里没有笔记数据(页面结构可能变了,也可能这条打不开)。不重试。' }
  }
  let map: Record<string, { note?: RawNote, comments?: { list?: RawComment[] } }>
  try { map = JSON.parse(payload) as typeof map }
  catch { return { state: 'not_found', message: '笔记数据读不出来(不是一份能解析的 JSON)。不重试。' } }

  const entry = map[id] ?? Object.values(map)[0]
  const raw = entry?.note
  if (entry === undefined || raw === undefined) {
    return { state: 'not_found', message: '这一页里没有这条笔记的数据。不重试。' }
  }

  const author = raw.user?.nickname ?? raw.user?.nickName
  const images = (raw.imageList ?? [])
    .map(one => one?.urlDefault ?? one?.urlPre)
    .filter((one): one is string => typeof one === 'string' && one !== '')
  const video = pickStream(raw.video)
  const kind = raw.type === 'video' ? 'video' : (raw.type === 'normal' ? 'normal' : undefined)

  const note: CollectedNote = {
    id: typeof raw.noteId === 'string' && raw.noteId !== '' ? raw.noteId : id,
    ...(typeof raw.title === 'string' && raw.title.trim() !== '' ? { title: raw.title.trim() } : {}),
    ...(typeof raw.desc === 'string' && raw.desc.trim() !== '' ? { desc: raw.desc.trim() } : {}),
    ...(kind === undefined ? {} : { kind }),
    tags: tagsOf(raw),
    ...(typeof author === 'string' && author !== '' ? { author } : {}),
    ...(typeof raw.time === 'number' && raw.time > 0 ? { published_at: new Date(raw.time).toISOString() } : {}),
    ...(typeof raw.ipLocation === 'string' && raw.ipLocation !== '' ? { ip: raw.ipLocation } : {}),
    ...(typeof raw.interactInfo?.likedCount === 'string' ? { likes: raw.interactInfo.likedCount } : {}),
    ...(typeof raw.interactInfo?.collectedCount === 'string' ? { collects: raw.interactInfo.collectedCount } : {}),
    ...(typeof raw.interactInfo?.commentCount === 'string' ? { comments: raw.interactInfo.commentCount } : {}),
    images,
    ...(video === undefined ? {} : { video }),
  }

  return {
    state: 'ok',
    message: '读到了',
    note,
    comments: pickTopComments(entry.comments?.list ?? []),
    ...(typeof raw.interactInfo?.commentCount === 'string' && raw.interactInfo.commentCount !== ''
      ? { comment_total: raw.interactInfo.commentCount }
      : {}),
  }
}

// ───────────────────────── 落盘 ─────────────────────────

/** 目录名里的标题:把路径分隔符、控制字符这些挡掉(同 meetingText.safeMeetingTitle 的口径)。 */
export function safeNoteTitle(raw: unknown): string {
  if (typeof raw !== 'string') return UNTITLED
  const cleaned = raw
    .replace(/\.\.+/g, '_')
    // eslint-disable-next-line no-control-regex -- 控制字符正是要挡的东西
    .replace(/[\u0000-\u001F\u007F/\\:*?"<>|\uFF1A\uFF0F]/g, '_')
    .replace(/^[.\s_]+/, '')
    .replace(/[\s_]+$/, '')
    .trim()
  if (cleaned === '') return UNTITLED
  return cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX) : cleaned
}

/** `<日期>-<标题>`。同 `meetingDirName`,两处各写一遍的风险由用例钉着。 */
export function noteDirName(date: string, title: unknown): string {
  return `${date}-${safeNoteTitle(title)}`
}

export interface CollectMeta {
  /** 采集时刻(ISO)。产物头上逐字写着它。 */
  at: string
  /** 来源链接,原样。 */
  url: string
}

/** 笔记.md。**取不到的字段写「没采到」,不写空、不写 0**(同数据复盘那张卡的纪律)。 */
export function renderNoteMd(note: CollectedNote, meta: CollectMeta): string {
  const miss = '没采到'
  const lines = [
    `# ${note.title ?? UNTITLED}`,
    '',
    `> 采集于 ${meta.at},来源:${meta.url}`,
    '> 用的是你自己的登录、你自己的电脑;只读这一页,没点任何东西。',
    '',
    '## 基本',
    '',
    `- **作者**:${note.author ?? miss}`,
    `- **类型**:${note.kind === 'video' ? '视频' : (note.kind === 'normal' ? '图文' : miss)}`,
    `- **发布时间**:${note.published_at ?? miss}`,
    `- **IP 属地**:${note.ip ?? miss}`,
    `- **点赞 / 收藏 / 评论**:${note.likes ?? miss} / ${note.collects ?? miss} / ${note.comments ?? miss}`,
    '  (页面上原样那串,没有换算)',
    '',
    '## 短文案',
    '',
    note.desc ?? `(${miss})`,
    '',
    '## 标签',
    '',
    note.tags.length === 0 ? `(${miss})` : note.tags.map(tag => `- #${tag}`).join('\n'),
    '',
    '## 源素材',
    '',
  ]
  if (note.video !== undefined) {
    const size = note.video.width !== undefined && note.video.height !== undefined
      ? `${note.video.width}×${note.video.height}`
      : miss
    lines.push(`- **视频**(${size}):${note.video.url}`)
    lines.push('  ⚠️ 这个直链是**有时效的**(带签名),过一阵就打不开了 —— 要下就趁早。')
  }
  else if (note.images.length > 0) {
    for (const [index, url] of note.images.entries()) lines.push(`- **图 ${index + 1}**:${url}`)
  }
  else lines.push(`(${miss})`)
  lines.push('')
  return lines.join('\n')
}

/** 评论.md。头上逐字写明「只采了前 N 条高赞、没有采子评论」—— 这是承诺,不是脚注。 */
export function renderCommentsMd(
  comments: readonly CollectedComment[],
  meta: CollectMeta,
  title: string | undefined,
  total?: string,
): string {
  const lines = [
    `# ${title ?? UNTITLED} · 评论`,
    '',
    `> 采集于 ${meta.at},来源:${meta.url}`,
    `> **只采了 ${comments.length} 条**(按点赞降序,上限 ${COMMENT_MAX} 条)`
    + `${total === undefined ? '' : `;这条笔记站点上写着一共 ${total} 条`}。`,
    '> **子评论一条都没采**,底下有几条只记个数。滚动加载到这里为止,没有点开任何「展开更多」。',
    '',
  ]
  if (comments.length === 0) {
    lines.push('(这一次一条评论都没采到。可能是这条笔记还没有评论,也可能是评论区没加载出来 —— 两种我分不清,所以不猜。)', '')
    return lines.join('\n')
  }
  for (const [index, one] of comments.entries()) {
    lines.push(`## ${index + 1}. ${one.author ?? '没采到作者'}${one.likes_raw === undefined ? '' : ` · 赞 ${one.likes_raw}`}`)
    lines.push('')
    lines.push(one.content)
    lines.push('')
    const meta2 = [
      one.at === undefined ? undefined : `时间 ${one.at}`,
      one.ip === undefined ? undefined : `IP ${one.ip}`,
      one.sub_count === undefined ? undefined : `底下还有 ${one.sub_count} 条回复(**没采**)`,
    ].filter((item): item is string => item !== undefined)
    if (meta2.length > 0) { lines.push(`> ${meta2.join(' · ')}`); lines.push('') }
  }
  return lines.join('\n')
}
