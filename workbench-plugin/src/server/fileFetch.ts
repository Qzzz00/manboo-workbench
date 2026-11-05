/**
 * 手机从电脑取文件(2026-09-25,卡 J `feat/phone-fetch-file`)。
 *
 * 维护者 09-24 20:02:「从电脑取文件呢」。他在引导里定的核心体验四段里第三段就是「跨系统调文件」,
 * 9/29 起只带 Pad 出门,**不在局域网**才是主用法。
 *
 * 电话里那条(工人的 `wb_search_files` / `wb_send_file`)09-21 就有了;这个文件管的是
 * **打字那一条**:手机首页输入框里打「把工作台仓库的 README 发到我手机上」。以前这句会被当成
 * 一条普通事项交给 DSH 里的事务官 —— 它找得到文件,却没有任何一条路把文件送到手机上,
 * 于是只能回一句「我没法直接发文件」。
 *
 * ## 这一条怎么走
 *
 *   ① `/butler/item` 在建卡之前岔出去(与「改布局」「开发一个小工具」两条岔路并排):
 *      {@link parseFetchRequest} 认出这是一句「把 X 发到我手机上」;
 *   ② 8791 自己在授权过的目录里**按文件名**找({@link searchLocalFiles},一个 `readFile` 都没有);
 *   ③ 每个候选各开一张**取件单**({@link createFileOffers}):只有问的那台手机能取、30 分钟过期,
 *      路径只在电脑上,回给手机的只有文件名、在哪、多大;
 *   ④ 手机上摆一张卡「找到 README.md(工作台)· 发到这台手机?」——**他点那一下就是复述确认**,
 *      和电话里「她先复述、他说对」是同一道门,只是换成了手指;
 *   ⑤ 取:在家(直连 8791)走 `GET /files/offer/<id>` 直接下载;在外面走房间 ——
 *      手机在 `wb.rpc` 上说一句 `file_pull`,工人来 8791 核这张单(`GET /channel/file-offer/<id>`),
 *      再用 `wb.file` 字节流推过去。
 *
 * ## 边界(与工人那一侧逐条同口径)
 *
 *   - **只在授权目录里找**:扫描根要 `read_scan_roots` 是「可以」;事务官自己的文件夹
 *     (`~/Documents/事务官`)一直能找 —— 那里的东西是他为了传才放进去的;
 *   - **只看名字,不读内容**;隐藏文件、`.git`、`node_modules`、看着像密钥的文件一律不进结果,
 *     取的那一刻再拦一遍;
 *   - **只传搜出来的那一条**:取件单里的路径是这里搜出来的,手机只拿得到单号;
 *   - 单个文件上限 200MB(与工人 `MAX_TRANSFER_BYTES` 同一个数)。
 *
 * **认不出就不岔**(宁可漏认):「把这个功能做了」「把 README 改一下再发我」都照旧当事项。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { projectNameKey, projectNameScore, projectQueryKeys } from './projectsService.ts'

/** 单个文件的上限。**与 channel-worker/src/files/inbox.ts 的 MAX_TRANSFER_BYTES 同一个数**。 */
export const FETCH_MAX_BYTES = 200 * 1024 * 1024
/** 手机那张卡上最多摆几个候选。多了他挑不过来,更多的如实说「还有 N 个」。 */
export const FETCH_ASK_HITS = 5
/** 一次最多看几个目录条目(与工人同数)。 */
export const FETCH_SCAN_LIMIT = 20000
/** 从根往下最多几层(与工人同数)。 */
export const FETCH_MAX_DEPTH = 6
/** 取件单多久过期。他在外面点开卡、走两步再点「发过来」,半小时够了。 */
export const FETCH_OFFER_TTL_MS = 30 * 60 * 1000
/** 内存里最多留几张单。 */
export const FETCH_OFFER_KEEP = 200
/** 永远不进的目录名(与工人 SEARCH_SKIP_DIRS 同一份)。 */
export const FETCH_SKIP_DIRS: readonly string[] = ['.git', 'node_modules', 'Library', '.Trash']

// ———————————————————————— ① 认出「要一份文件」 ————————————————————————

/**
 * ## 为什么这一段 2026-10-04 整个重写了(卡 `claude/phone-file-send-loop`)
 *
 * 维护者 10-04 早在手机上说的是:
 *
 * > 「官网逐字稿,这份文件发到我这个手机上。」
 *
 * 老那一版认不出它,于是这句话落成了一件普通事项交给事务官 —— 事务官手里没有任何一条
 * 「把文件推到手机」的路,两轮各跑十几步去 grep 工作台自己的源码(http.ts / fileFetch.ts / devTool.ts)
 * 找办法,两轮都以 `aborted` 收场(她看到的「阻塞了两次」),第三轮把文件拷到事务官文件夹、
 * 回了一句「你在手机上再打一句『把官网逐字稿发我』」就把事项记成了完成。**什么都没到她手机上。**
 *
 * 认不出的原因不是少一个词,是**判法本身**:老那一版把整段「送到我这儿」压成一条正则,
 * 而且要求这条正则**把那一段吃干净**(吃不掉的剩字一律当成"还有别的交代"→ 不岔)。
 * 「发到我**这个**手机上」里的「这个」不在那条正则的任何一个分支里,于是只吃掉了「发到我」,
 * 剩下「这个手机上」被当成另一段交代。往正则里再补一个「这个」只能挡住这一句话
 * (维护者 10-02:「不要拿着打补丁的心态,要有机制上的调整」)。
 *
 * ## 现在的判法:一段一段扫,不靠一条大正则
 *
 * 「送到我这儿」是一个**短语**,按文法扫:
 *
 *     动词(发/发送/传/送/推/弄/同步) 衬字(一下/个/份…)* 介词(到/给/去/至/往)? 收件人段+
 *
 * 收件人段是一串**词**({@link RECIPIENT_WORDS}),顺序随意、可多可少:
 * 「我」「我的」「这」「这个」「这台」「这边」「手机」「平板」「pad」「上」「上来」「里」「来」……
 * 扫到不认得的字就停;**整段里必须至少有一个"落到她身上"的词**({@link RECIPIENT_ANCHORS}:
 * 我 / 手机 / 平板 / pad / 这边 / 这里 / 这儿 / 过来 / 回来)。
 *
 * 于是「发到我这个手机上」「弄到手机上」「同步到我手机」「传给我」「发我这边」「发过来」全都认得出,
 * 而「发给张三」「发个消息给 Kimi」「把这段发给豆包」照旧一个都不认(**收件人不是她**)。
 * 收件人段后面紧跟着另一个收件处(「发我邮箱」「发我微信」「发到我电脑上」)也不认 ——
 * 落到她身上了,可**不是她手机**({@link OTHER_DESTINATION})。
 *
 * ## 两档门,一处判据
 *
 * - {@link parseFetchRequest}(**窄**):够确定才岔出去自己找文件、自己摆卡 —— 宾语干净、
 *   后面只跟语气词、不带「改一下」这种先干活的动词。**宁可漏认**,老那一版的每一条边界一个字没松。
 * - {@link fileWantHint}(**宽一格**):同一个短语扫出来就算。它不岔路、不摆卡,只做两件事 ——
 *   ① 这件事照旧交给事务官,但给它的第一条消息里写明「要把文件送到她手机上,走 `POST /butler/send-file`,
 *      别去读工作台源码」;② 这张卡登记成「要有传输回执才算办完」(`fileDelivery.ts`)。
 *
 * 所以**认不准不再等于掉地上**:窄的那一档漏了,宽的那一档还在,而事务官手里从此有正规的那一下。
 */

/**
 * 送东西的那几个动词。
 * - 「给」不在里头 —— 它只在「给我发/传/送」里当介词(见下);
 * - 「过」不是衬字(「发**过来**」里的「过来」是收件人段的锚点,吃掉「过」就只剩一个没锚点的「来」)。
 */
const DELIVERY_VERBS: readonly string[] = ['发送', '同步', '发', '传', '送', '推', '弄']

/** 动词与介词之间的衬字:「发**一下**」「发**个**」「传**过**来」。 */
const DELIVERY_FILLERS: readonly string[] = ['一下', '一份', '一个', '下', '个', '份', '张', '条']

/** 介词:「发**到**我手机」「传**给**我」。 */
const DELIVERY_PREPS: readonly string[] = ['到', '给', '去', '至', '往']

/**
 * 收件人段里认得的词。顺序随意、可多可少 —— 「我这个手机上」= 我 + 这个 + 手机 + 上。
 * 长的排前面(先吃「我的」再吃「我」),扫的时候按这个顺序试。
 */
const RECIPIENT_WORDS: readonly string[] = [
  '我的', '我', '这台', '这个', '这边', '这里', '这儿', '这',
  '手机', '平板', 'ipad', 'pad', '苹果手机', '机子',
  '过来', '回来', '上来', '上', '里面', '里', '来',
]

/**
 * 整段收件人里**至少要有一个**这些词,否则不算「送到我这儿」。
 * 「发给张三」的收件人段扫不出任何一个词;「发到那台电脑上」扫出的是「那台/上」,没有锚点 —— 都不算。
 */
const RECIPIENT_ANCHORS: readonly string[] = ['我', '我的', '手机', '平板', 'pad', 'ipad', '这边', '这里', '这儿', '过来', '回来']

/**
 * 收件人段后面紧跟的**另一个收件处**:那就不是「送到她手机上」这件事。
 *
 * 「把方案发我邮箱」「发我微信」是另一回事(她要的是另一条路);
 * 「发到我电脑上」是反方向(手机 → 电脑那条老路)。这几种**一律不认** ——
 * 认了的下场是卡上立一个送不到的牌子,那张卡就永远停在「还没送到」上。
 */
const OTHER_DESTINATION = /^(?:邮箱|邮件|微信|群|钉钉|飞书|网盘|云盘|电脑|桌面|mac\b|pc\b)/i

/** 否定:「别把 README 发我」。 */
const NEGATION = /(?:别|不要|不用|甭|先别|没让你)(?:再)?(?:把|将)?[^,，。!！?？]{0,30}?(?:发|传|送|推|弄|同步)/

/**
 * 宾语里带这些动词 = 他要事务官**先做一件事**再发(「把 README 改一下再发我」「整理成一份发我」)——
 * 那是一件活,不是取一个现成的文件。**窄的那一档不岔**,照旧交给事务官;
 * 宽的那一档照样算「要文件」(事务官干完那件事还是得把文件送到她手机上)。
 */
const WORK_VERBS = /改|写|做|整理|总结|翻译|润色|生成|修|查|找找|对比|合并|压缩|导出|打包|截个|拍/

/** 「发我」后面允许跟的那几个字(语气词、「一下」「看看」)。多出别的话 = 还有交代,窄的那一档不岔。 */
const TRAILING_OK = /^[\s,，。.!！~～]*(?:吧|呗|啊|哈|呀|一下|下|看看|瞧瞧|好吗|好不好|行吗|可以吗|谢谢|thanks?|thx)*[\s,，。.!！~～?？]*$/i

/** 前面允许的客气话(「帮我把」「麻烦把」)。 */
const POLITE_PREFIX = /^(?:请|麻烦|帮我|帮忙|你|拜托|劳驾|能不能|可以)+/

/** 宾语里是一个问句(「你发我的那个文件在哪」):他在问,不是在要。 */
const QUESTION = /在哪|哪儿|哪里|哪个|是什么|什么时候|为什么|怎么/

/** 只是一个代词,等于没说要哪一个。 */
const PRONOUN_ONLY = /^(?:这|那|它|他|她|你|我|这个|那个|这份|那份|这些|那些|它们|刚才那个|刚才的|上面那个)$/

/** 一句话最长多长还算「取个文件」。再长多半是在交代一件事。 */
const MAX_REQUEST_CHARS = 80

/**
 * 「给我看看那份 X」那一类(2026-10-04 新加)。
 *
 * 她说「给我看看那份逐字稿」要的和「把那份逐字稿发我」是同一件事 —— 手机上看一个文件,
 * 唯一的办法就是先把它送过去。但「看」太宽(「给我看看进度」「给我看看都有哪几家」不是要文件),
 * 所以这一支**多一道门**:宾语里要有一个像文件的词({@link FILE_ISH}),否则不认。
 */
const SHOW_PHRASE = /(?:给我|帮我|让我)?看(?:看|一下|一眼|下)?/
/** 像在说一个文件:量词「份」、类名(文档/稿/表/图…)、或者带扩展名的名字。 */
const FILE_ISH = /份|文件|文档|稿|表格|报表|图片|照片|截图|录屏|视频|音频|录音|压缩包|\.(?:md|txt|pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|webp|heic|mp4|mov|m4a|mp3|wav|zip|json|log)\b/i

/** 去掉引号、书名号和两头的空白与标点。 */
function cleanObject(text: string): string {
  return text
    .replace(/[「」『』“”"'‘’《》<>]/g, ' ')
    .replace(/^[\s,，。.!！:：、]+|[\s,，。.!！:：、]+$/g, '')
    .trim()
}

/** 这个位置上是不是这几个词之一;是就回它有多长。 */
function wordAt(said: string, at: number, words: readonly string[]): string | undefined {
  const lower = said.toLowerCase()
  for (const word of words) {
    if (lower.startsWith(word, at)) return word
  }
  return undefined
}

/** 扫一段收件人。回它有多长、里头有没有锚点。 */
function scanRecipient(said: string, from: number): { length: number, anchored: boolean } {
  let at = from
  let anchored = false
  for (;;) {
    const word = wordAt(said, at, RECIPIENT_WORDS)
    if (word === undefined) break
    if (RECIPIENT_ANCHORS.includes(word)) anchored = true
    at += word.length
  }
  return { length: at - from, anchored }
}

/**
 * 一句话里「送到我这儿」那一段在哪(没有就 undefined)。
 *
 * 两种开头各扫一遍,取**最靠前**的那一处:
 *   - 「(把 X)发到我这个手机上」:动词 → 衬字 → 介词 → 收件人段;
 *   - 「给我发一下 X」:`给我` → 动词 → 衬字(收件人在动词前面,已经落在她身上)。
 */
export function findDeliveryPhrase(said: string): { index: number, length: number } | undefined {
  for (let at = 0; at < said.length; at += 1) {
    // 「给我发一下 X」:收件人在前,动词在后。
    if (said.startsWith('给我', at)) {
      let end = at + 2
      const verb = wordAt(said, end, DELIVERY_VERBS)
      if (verb !== undefined) {
        end += verb.length
        for (;;) {
          const filler = wordAt(said, end, DELIVERY_FILLERS)
          if (filler === undefined) break
          end += filler.length
        }
        end += scanRecipient(said, end).length
        return { index: at, length: end - at }
      }
    }
    const verb = wordAt(said, at, DELIVERY_VERBS)
    if (verb === undefined) continue
    let end = at + verb.length
    for (;;) {
      const filler = wordAt(said, end, DELIVERY_FILLERS)
      if (filler === undefined) break
      end += filler.length
    }
    const prep = wordAt(said, end, DELIVERY_PREPS)
    if (prep !== undefined) end += prep.length
    const recipient = scanRecipient(said, end)
    // **必须落到她身上**:「发给张三」「发个消息给 Kimi」在这里被挡住。
    if (!recipient.anchored) continue
    // 「发我邮箱」「发到我电脑上」:落到她身上了,可**不是她手机**。
    if (OTHER_DESTINATION.test(said.slice(end + recipient.length))) continue
    return { index: at, length: end + recipient.length - at }
  }
  return undefined
}

/** 「给我看看那份 X」那一段在哪。宾语像文件才算(见 {@link SHOW_PHRASE})。 */
function findShowPhrase(said: string): { index: number, length: number } | undefined {
  const hit = SHOW_PHRASE.exec(said)
  if (hit === null) return undefined
  // 光一个「看」不算:要么前面有「给我 / 帮我 / 让我」,要么后面叠字(「看看」「看一下」)。
  if (hit[0] === '看') return undefined
  return { index: hit.index, length: hit[0].length }
}

/**
 * 「给我看看 X」里的 X 够不够当一个文件名来找:像文件({@link FILE_ISH})、而且不止两个字。
 * 「给我看看这个文件」摘完只剩「文件」—— 那等于没说要哪一个,照旧交给事务官去问。
 */
function showQueryOk(query: string): boolean {
  return FILE_ISH.test(query) && query.replace(/\s+/g, '').length >= 3
}

/** 一句话 → 宾语那一段(她原话里的那一截)。认不出就 undefined。 */
function objectOf(said: string, phrase: { index: number, length: number }, strict: boolean): string | undefined {
  const before = said.slice(0, phrase.index)
  const after = said.slice(phrase.index + phrase.length)
  let object: string
  const ba = Math.max(before.lastIndexOf('把'), before.lastIndexOf('将'))
  if (ba >= 0) {
    // 「把 X 发到我手机上」:X 在「把」和「发」之间;后面只许跟语气词。
    if (strict && !TRAILING_OK.test(after)) return undefined
    object = before.slice(ba + 1)
  }
  else if (before.replace(POLITE_PREFIX, '').trim() === '') {
    // 「发我一下工作台的 README」「给我发一下 X」「给我看看那份 X」:X 在后面。
    // 长的先摘(「那份」要整个摘掉,只摘「那」会剩一个「份」)。
    object = after.replace(/^(?:一下|一份|一个|那份|这份|那个|这个|下|个|份|那|这)/, '')
  }
  else {
    // 「工作台的 README 发我一下」「官网逐字稿,这份文件发到我这个手机上」:X 在前面。
    if (strict && !TRAILING_OK.test(after)) return undefined
    object = before.replace(POLITE_PREFIX, '')
  }
  const query = cleanObject(object)
  if (query === '' || PRONOUN_ONLY.test(query)) return undefined
  if (strict && (WORK_VERBS.test(query) || QUESTION.test(query))) return undefined
  if (!strict && QUESTION.test(query)) return undefined
  // 至少要有一点能拿来比对文件名的东西:两个字以上。
  if (query.replace(/\s+/g, '').length < 2) return undefined
  return query
}

/**
 * 一句话 → 要找的那个东西(她的原话里那一段)。认不出就 undefined —— **宁可漏认**。
 *
 * 这是**窄**的那一档:认出来 8791 就自己找文件、自己把卡摆到她手机上(`http.ts` 的 `/butler/item` 岔路)。
 * 漏认的那些由 {@link fileWantHint} 接着(事务官去办,但手里有正规的那一下)。
 */
export function parseFetchRequest(text: string): { query: string } | undefined {
  const said = (text ?? '').trim()
  if (said === '' || said.length > MAX_REQUEST_CHARS) return undefined
  if (NEGATION.test(said)) return undefined
  const phrase = findDeliveryPhrase(said)
  if (phrase !== undefined) {
    const query = objectOf(said, phrase, true)
    return query === undefined ? undefined : { query }
  }
  // 「给我看看那份逐字稿」:宾语像文件才算(「给我看看进度」不算)。
  const show = findShowPhrase(said)
  if (show === undefined) return undefined
  const query = objectOf(said, show, true)
  if (query === undefined || !showQueryOk(query)) return undefined
  return { query }
}

/** {@link fileWantHint} 认出来之后那一句:摆进第一条消息里,也写在卡上。 */
export const FILE_WANT_NOTE = '这件事要把一个文件送到她手机上'

/**
 * 一句话里**像不像在要一份文件**(2026-10-04)。宽一格:同一个短语扫出来就算,
 * 宾语脏一点(「改一下再发我」)、后面还有别的交代都照算。
 *
 * 它**不岔路**:这句话照旧建卡、照旧交给事务官。它只决定两件事 ——
 *   ① 第一条消息里写明「要把文件送到她手机上,只走 `POST /butler/send-file`」(`butlerBrief.ts`);
 *   ② 这张卡登记成「没有传输回执就不算办完」(`fileDelivery.ts`)。
 *
 * 宁可宽:登记错了最坏的下场是一张卡停在「还没送到」上、她看得见、点一下能收掉;
 * 漏登记的下场是 10-04 早上那一幕(事项 `done`、note「只是问了一句」、她手机上什么都没有)。
 */
export function fileWantHint(text: string): { query?: string } | undefined {
  const said = (text ?? '').trim()
  if (said === '') return undefined
  if (NEGATION.test(said)) return undefined
  const phrase = findDeliveryPhrase(said)
  if (phrase !== undefined) {
    const query = objectOf(said, phrase, false)
    return query === undefined ? {} : { query }
  }
  const show = findShowPhrase(said)
  if (show === undefined) return undefined
  const query = objectOf(said, show, false)
  if (query === undefined || !showQueryOk(query)) return undefined
  return { query }
}

// ———————————————————————— ② 一句话 → 在哪找、找什么 ————————————————————————

/** 不是文件名的那些词(「仓库」「项目」「那个」……)。 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  '仓库', '项目', '目录', '文件夹', '文件', '那个', '这个', '那份', '这份', '一份', '一个', '最新', '最近',
  '我', '我的', '电脑', '电脑上', 'mac', '上面', '下面', '里面', '里边', '一下', '帮我', '给我', '把',
])

/**
 * 这一段只是在**指**那个东西,不是它的名字:「这份文件」「那个」「一份材料」。
 *
 * 2026-10-04:她说的是「官网逐字稿,这份文件发到我这个手机上。」—— 宾语是
 * 「官网逐字稿,这份文件」,拆出来两段。老那一版两段**都**要在文件名里出现,
 * 于是一个都找不到。`STOP_WORDS` 那张表挡不住「这份文件」这种组合词
 * (表里有「这份」也有「文件」,偏偏没有拼在一起的那个)——
 * 所以这里按**构造**判:指代词 + 量词 + 类名 拼起来的整词一律不算要找的名字。
 * 「逐字稿」不是(它不以指代词开头),所以照样进 `terms`。
 */
export function isPointingToken(token: string): boolean {
  return /^(?:这|那|此|该)?(?:一)?(?:份|个|张|条|些|篇|本|套)?(?:文件|文档|东西|材料|资料|稿子|玩意儿?)?$/.test(token.trim())
    && token.trim() !== ''
}

export interface ProjectRef {
  name: string
  path: string
}

export interface FileQueryPlan {
  /** 认出来的项目(「工作台」→ desktop-workbench)。认出来了就只在它底下找。 */
  project?: ProjectRef
  /** 要在文件名 / 路径里出现的词(小写)。**每个都要出现**。 */
  terms: readonly string[]
  /** 给人看的那一句「找的是什么」:「工作台 · README」。 */
  label: string
}

/** 一句话 → 几个段。「的」「里」「中」、空白与标点都算分隔。 */
export function queryTokens(query: string): string[] {
  return (query ?? '')
    .replace(/[「」『』“”"'‘’《》<>]/g, ' ')
    .split(/[\s,，、;；/|]+|的|里面|里边|里|中的|上的|下的/)
    .map(token => token.trim())
    .filter(token => token !== '')
}

/**
 * 一句话 + 项目表 → 在哪找、找什么。
 *
 * 项目名要**认得像**才算(`projectNameScore` ≥ 2,与引导里「按名字找项目」同一把尺),
 * 而且一句话里只认一个项目:认错一个项目,就是在别人的仓库里给他找东西。
 */
export function planFileQuery(query: string, projects: readonly ProjectRef[]): FileQueryPlan {
  const tokens = queryTokens(query)
  let project: ProjectRef | undefined
  let projectToken: string | undefined
  let best = 0
  for (const token of tokens) {
    const key = projectNameKey(token)
    if (key.length < 2 || STOP_WORDS.has(key)) continue
    // 「工作台仓库」→ 去掉尾巴上的「仓库 / 项目」再比。
    const bare = token.replace(/(?:仓库|项目|目录|文件夹)$/, '')
    const keys = projectQueryKeys(bare === '' ? token : bare)
    for (const candidate of projects) {
      const score = Math.max(projectNameScore(candidate.name, keys), projectNameScore(basename(candidate.path), keys))
      if (score > best) { best = score; project = candidate; projectToken = token }
    }
  }
  if (best < 2) { project = undefined; projectToken = undefined }
  const terms: string[] = []
  for (const token of tokens) {
    if (token === projectToken) continue
    const lower = token.toLowerCase()
    if (STOP_WORDS.has(lower)) continue
    // 「这份文件」这种**只是在指**的整词不算要找的名字(2026-10-04);
    // 全句都是指代词时下面 terms 为空,照旧回「没听出要哪个文件」那一句。
    if (isPointingToken(lower)) continue
    // 单个汉字几乎什么都「包含」;单个字母同理。
    if ([...lower].length < 2) continue
    if (!terms.includes(lower)) terms.push(lower)
  }
  const label = [project?.name, ...terms].filter((part): part is string => part !== undefined && part !== '').join(' · ')
  return { ...(project === undefined ? {} : { project }), terms, label: label === '' ? query.trim() : label }
}

// ———————————————————————— ③ 按文件名找(不读内容) ————————————————————————

/** 看着像密钥 / 凭据的文件名。**不找、不传**(电脑上这类文件不该经任何一条路出门)。 */
const SECRET_NAME = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials\.json|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pem|p12|pfx|key|keychain|keychain-db|kdbx))$/i

/** 这一段路径名该不该跳过(隐藏、`.git`、`node_modules`)。 */
export function skipFetchEntry(name: string): boolean {
  if (name.startsWith('.')) return true
  return FETCH_SKIP_DIRS.includes(name)
}

/**
 * 这个文件**能不能出门**。不能就回一句人话(能就 undefined)。
 * 搜的时候已经跳过了一遍,这里是**取的那一刻再看一遍**(与工人 transferBlockReason 同一道)。
 */
export function fetchBlockReason(path: string): string | undefined {
  const segments = resolve(path).split(sep).filter(segment => segment !== '')
  for (const segment of segments) {
    if (segment.startsWith('.')) return `「${segment}」是隐藏文件或隐藏目录,不传`
    if (segment === 'node_modules') return '`node_modules` 里的东西不传'
  }
  if (SECRET_NAME.test(basename(path))) return `「${basename(path)}」看着像密钥或凭据,不传`
  return undefined
}

/**
 * 这条路径在不在某个根底下。**按路径段比**,不是 `startsWith` ——
 * `/a/bc` 不该因为 `/a/b` 是根就被放行。
 */
export function withinFetchRoots(path: string, roots: readonly string[]): boolean {
  const target = resolve(path)
  return roots.some((root) => {
    const base = resolve(root)
    if (target === base) return true
    return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  })
}

export interface FetchRoot {
  path: string
  /** 给人看的名字(「扫描根」「事务官文件夹」)。 */
  label: string
  depth?: number
  /**
   * 「在哪」要不要带上这个根的名字。事务官文件夹要带(「事务官文件夹 / 收件」);扫描根不带 ——
   * 「GitHub / desktop-workbench / docs」里那个 GitHub 他听了没用,仓库名才是他认的。
   */
  labelPrefix?: boolean
}

export interface FoundLocalFile {
  path: string
  name: string
  bytes: number
  mtimeMs?: number
  /** 在哪:项目名,或者相对那个根的上一级目录。 */
  where: string
  /** 文件名里就有全部的词(比「路径里有」更像他要的那一个)。 */
  nameHit: boolean
  depth: number
}

export interface LocalSearchOutcome {
  files: readonly FoundLocalFile[]
  total: number
  truncated: boolean
  errors: readonly string[]
  /**
   * 哪几个根是**没权限**读(EPERM / EACCES),2026-10-13。
   *
   * 与 `errors` 分开是因为这一类要说的话完全不同:别的错(目录不在、路径写错了)说给她听
   * 没用也不要紧,而这一类**有一个她点一下就能解决的根治动作**(给那条 node 一次
   * 完全磁盘访问),所以要单独认出来,换成 `FILE_ACCESS_DENIED_NOTE` 那一句。
   */
  denied: readonly string[]
}

export interface LocalSearchDeps {
  readdirImpl?: (dir: string) => Promise<readonly { name: string, isDirectory: boolean, isFile: boolean }[]>
  statImpl?: (path: string) => Promise<{ size: number, mtimeMs: number, isFile: boolean }>
  scanLimit?: number
  /** 最多收多少个命中(排序之前)。 */
  keep?: number
}

async function defaultReaddir(dir: string): Promise<readonly { name: string, isDirectory: boolean, isFile: boolean }[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  // Dirent 的 isFile/isDirectory **不跟符号链接**:一条指向 ~/.ssh 的链接既不是文件也不是目录,直接跳过。
  return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
}

async function defaultStat(path: string): Promise<{ size: number, mtimeMs: number, isFile: boolean }> {
  const info = await lstat(path)
  return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() }
}

/** 一条相对路径是不是命中:每个词都在(不分大小写)。 */
export function fetchMatches(relativePath: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const hay = relativePath.toLowerCase()
  return terms.every(term => hay.includes(term))
}

/**
 * 真去走一遍。**绝不抛**。广度优先:浅的先出。**比的是相对根的路径** ——
 * 绝对路径里有 `/Users/example/Documents/GitHub` 这一截,「github」「documents」这种词会让所有文件都命中。
 */
export async function searchLocalFiles(
  input: { roots: readonly FetchRoot[], terms: readonly string[], whereLabel?: string },
  deps: LocalSearchDeps = {},
): Promise<LocalSearchOutcome> {
  const readdirImpl = deps.readdirImpl ?? defaultReaddir
  const statImpl = deps.statImpl ?? defaultStat
  const scanLimit = deps.scanLimit ?? FETCH_SCAN_LIMIT
  const keep = deps.keep ?? 200
  const files: FoundLocalFile[] = []
  const errors: string[] = []
  const denied: string[] = []
  if (input.terms.length === 0) return { files: [], total: 0, truncated: false, errors: [], denied: [] }
  let scanned = 0
  let total = 0
  let truncated = false
  const seen = new Set<string>()
  const queue: { dir: string, depth: number, maxDepth: number, root: FetchRoot }[] = input.roots.map(root => ({
    dir: resolve(root.path), depth: 0, maxDepth: root.depth ?? FETCH_MAX_DEPTH, root,
  }))
  while (queue.length > 0) {
    const current = queue.shift() as { dir: string, depth: number, maxDepth: number, root: FetchRoot }
    if (seen.has(current.dir)) continue
    seen.add(current.dir)
    if (scanned >= scanLimit) { truncated = true; break }
    let entries: readonly { name: string, isDirectory: boolean, isFile: boolean }[]
    try { entries = await readdirImpl(current.dir) }
    catch (err) {
      if (current.depth === 0) {
        // 没权限与"读不到"分两路说(2026-10-13):前者有根治动作,后者只能如实报原文。
        if (isAccessDenied(err)) denied.push(current.dir)
        else errors.push(`${current.root.label}读不到(${(err as Error)?.message ?? '没说原因'})`)
      }
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned >= scanLimit) { truncated = true; break }
      if (skipFetchEntry(entry.name)) continue
      const full = `${current.dir}${sep}${entry.name}`
      if (entry.isDirectory) {
        if (current.depth + 1 <= current.maxDepth) {
          queue.push({ dir: full, depth: current.depth + 1, maxDepth: current.maxDepth, root: current.root })
        }
        continue
      }
      if (!entry.isFile) continue
      if (SECRET_NAME.test(entry.name)) continue
      const rel = relative(resolve(current.root.path), full)
      if (!fetchMatches(rel, input.terms)) continue
      total += 1
      if (files.length >= keep) { truncated = true; continue }
      let bytes = 0
      let mtimeMs: number | undefined
      try {
        const info = await statImpl(full)
        if (!info.isFile) continue
        bytes = info.size
        mtimeMs = info.mtimeMs
      }
      catch { /* 读不到大小就只给名字:不编一个大小 */ }
      const parent = dirname(rel)
      const where = input.whereLabel !== undefined
        ? (parent === '.' ? input.whereLabel : `${input.whereLabel} / ${parent.split(sep).slice(-2).join(' / ')}`)
        : (parent === '.' ? current.root.label : current.root.labelPrefix === true ? `${current.root.label} / ${parent.split(sep).slice(0, 2).join(' / ')}` : parent.split(sep).slice(0, 2).join(' / '))
      files.push({
        path: full,
        name: entry.name,
        bytes,
        ...(mtimeMs === undefined ? {} : { mtimeMs }),
        where,
        nameHit: fetchMatches(entry.name, input.terms),
        depth: current.depth,
      })
    }
  }
  return { files, total, truncated, errors, denied }
}

/**
 * 这个错是不是「没权限」(2026-10-13)。
 *
 * **只认 EPERM / EACCES 这两个码**,不去匹配错误文案 —— 文案随 Node 版本与语言变,
 * 错误码不变。认错了的后果是两头的:把别的错说成"没授权"会把她支去点一个没用的开关,
 * 把"没授权"说成别的错又会让根治动作永远不出现。
 */
export function isAccessDenied(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * 「电脑上还没给文件访问授权」那一句(2026-10-13,维护者:「不解决这个问题,那这个功能就废了」)。
 *
 * **手机只显示这一句**,不另外判断、不改协议:判断在电脑上做(EPERM 这个码),
 * 手机那头照着念。去哪儿点写在句子里 —— 她看到这句话时人在手机上,得知道回电脑干什么。
 */
export const FILE_ACCESS_DENIED_NOTE = '电脑上还没给文件访问授权,所以我读不到那些文件。去电脑上的 设置 › 高级 › 体检与修复 › 第 3 步「系统授权」,把「完全磁盘访问」那一格给一次(或者点电脑首页顶上那条横幅的「去给」),给完再说一次就行。'

/**
 * 排个序:**文件名里就有全部的词**的排前面;文件名去掉扩展名正好等于某个词的再往前
 * (他说「README」要的是 README.md,不是 README-old-备份.md);然后浅的在前、新的在前。
 */
export function rankFound(files: readonly FoundLocalFile[], terms: readonly string[]): FoundLocalFile[] {
  const exact = (file: FoundLocalFile): boolean => {
    const stem = basename(file.name, extname(file.name)).toLowerCase()
    return terms.some(term => term === stem || term === file.name.toLowerCase())
  }
  return [...files].sort((a, b) => {
    if (a.nameHit !== b.nameHit) return a.nameHit ? -1 : 1
    const ea = exact(a)
    const eb = exact(b)
    if (ea !== eb) return ea ? -1 : 1
    if (a.depth !== b.depth) return a.depth - b.depth
    return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
  })
}

// ———————————————————————— ④ 取件单 ————————————————————————

export type FetchFileKind = 'text' | 'pdf' | 'image' | 'video' | 'audio' | 'other'

const EXT_MIME: Readonly<Record<string, string>> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** 文件名 → MIME。认不出就 octet-stream(手机那头按扩展名再认一次)。 */
export function fetchMimeOf(name: string): string {
  return EXT_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** 文件名 → 大类(手机上那张卡按它挑图标 / 挑怎么打开)。 */
export function fetchKindOf(name: string): FetchFileKind {
  const mime = fetchMimeOf(name)
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

export interface FileOffer {
  id: string
  /** 绝对路径。**只在电脑上**,不进任何回给手机的回包。 */
  path: string
  name: string
  bytes: number
  /** 给人看的「在哪」。 */
  where: string
  /** 只有这台设备能取。 */
  device_id: string
  /** 谁开的单:打字那条(`typed`)还是电话里那条(`call`)。 */
  source: 'typed' | 'call'
  /**
   * 取的那一刻额外许可的根(2026-10-04,卡「手机看各家对话里的图片和文件」)。
   *
   * 对话里的附件不一定落在扫描根底下 —— Codex 自己生成的图在 `~/.codex/generated_images/`、
   * Kimi 的图在它自己的 `blobs/` 里。这类单开出来时把**这一个文件的 realpath** 记在这里:
   * `checkOfferFile` 照旧核一遍(还在、普通文件、没超限、不是密钥、realpath 没被换走),
   * 只是「在授权目录里」这一问多认这一个文件。**不是一个目录**,所以开一张单只放过一个文件。
   */
  roots?: readonly string[]
  created_at: number
  expires_at: number
  /** 取过几次(同一张单可以重取:第一次半路断了,再点一次)。 */
  pulls: number
}

export interface FileOffersStore {
  add: (input: Omit<FileOffer, 'id' | 'created_at' | 'expires_at' | 'pulls'>) => FileOffer
  /** 这张单**这台设备**能不能取。不能就 undefined(没这张单、过期了、不是开给它的 —— 三种一个口径,不告诉外人是哪一种)。 */
  forDevice: (id: string, deviceId: string) => FileOffer | undefined
  /** 本机(回环)看:不核设备。 */
  get: (id: string) => FileOffer | undefined
  markPulled: (id: string) => void
  size: () => number
}

export function createFileOffers(deps: { now?: () => number, ttlMs?: number, keep?: number, newId?: () => string } = {}): FileOffersStore {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? FETCH_OFFER_TTL_MS
  const keep = deps.keep ?? FETCH_OFFER_KEEP
  const newId = deps.newId ?? (() => randomBytes(18).toString('base64url'))
  const offers = new Map<string, FileOffer>()
  const alive = (offer: FileOffer | undefined): FileOffer | undefined =>
    offer !== undefined && offer.expires_at > now() ? offer : undefined
  function prune(): void {
    const t = now()
    for (const [id, offer] of offers) if (offer.expires_at <= t) offers.delete(id)
    while (offers.size > keep) {
      const oldest = offers.keys().next().value
      if (oldest === undefined) break
      offers.delete(oldest)
    }
  }
  return {
    add(input) {
      prune()
      const t = now()
      const offer: FileOffer = { ...input, id: newId(), created_at: t, expires_at: t + ttlMs, pulls: 0 }
      offers.set(offer.id, offer)
      prune()
      return offer
    },
    forDevice(id, deviceId) {
      const offer = alive(offers.get(id))
      return offer !== undefined && offer.device_id === deviceId ? offer : undefined
    },
    get(id) {
      return alive(offers.get(id))
    },
    markPulled(id) {
      const offer = offers.get(id)
      if (offer !== undefined) offer.pulls += 1
    },
    size: () => offers.size,
  }
}

/**
 * 取之前最后一道:还在不在、是不是普通文件(不是符号链接)、真实路径还在不在根底下、
 * 有没有超上限、是不是不该出门的东西。**任何一道没过都回一句人话**。
 */
export async function checkOfferFile(
  path: string,
  roots: readonly string[],
): Promise<{ ok: true, bytes: number } | { ok: false, status: number, error: string }> {
  const blocked = fetchBlockReason(path)
  if (blocked !== undefined) return { ok: false, status: 403, error: blocked }
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(path) }
  catch (err) {
    // 2026-10-13:EPERM 不是"没了" —— 文件好好地在那儿,是这条 node 没权限读它。
    if (isAccessDenied(err)) return { ok: false, status: 403, error: FILE_ACCESS_DENIED_NOTE }
    return { ok: false, status: 410, error: '电脑上这个文件已经不在了(被挪走或删了)' }
  }
  if (!info.isFile()) return { ok: false, status: 403, error: '这不是一个普通文件,不传' }
  if (info.size > FETCH_MAX_BYTES) {
    return { ok: false, status: 413, error: `这个文件有 ${(info.size / 1024 / 1024).toFixed(1)}MB,超过了 ${FETCH_MAX_BYTES / 1024 / 1024}MB 的上限` }
  }
  try {
    const real = await realpath(path)
    const realRoots = await Promise.all(roots.map(async root => await realpath(root).catch(() => resolve(root))))
    if (!withinFetchRoots(real, realRoots)) return { ok: false, status: 403, error: '这个文件不在授权过的目录里了,不传' }
  }
  catch (err) {
    if (isAccessDenied(err)) return { ok: false, status: 403, error: FILE_ACCESS_DENIED_NOTE }
    return { ok: false, status: 410, error: '电脑上这个文件已经不在了(被挪走或删了)' }
  }
  return { ok: true, bytes: info.size }
}

/** 算一个文件的 sha256(流式,200MB 也不进内存)。 */
export async function sha256OfFile(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** `Content-Disposition` 里的名字(RFC 5987,中文名字要能过去)。 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// ———————————————————————— ⑤ 拼成手机上那张卡 ————————————————————————

export interface FileAskHitView {
  /** 取件单号。手机拿它来取,**路径不出电脑**。 */
  offer: string
  name: string
  where: string
  bytes: number
  kind: FetchFileKind
  /** 最后修改时间(ISO)。读不到就缺席。 */
  mtime?: string
}

export interface FileAskView {
  id: string
  /** 他的原话。 */
  request: string
  /** 找的是什么(「工作台 · README」)。 */
  query: string
  /** 在哪台电脑上找的。 */
  device: string
  hits: readonly FileAskHitView[]
  /** 命中总数(可能多于 hits)。 */
  total: number
  /** 没授权 / 没找到 / 只找了一部分:**原样摆给他看**。 */
  note?: string
}

/** 一句「没找到」的人话。说清楚在哪找的、找的什么,让他知道换个说法还是去开授权。 */
export function notFoundNote(plan: FileQueryPlan, input: { authorized: boolean, workDirLabel: string }): string {
  if (plan.terms.length === 0) {
    return plan.project === undefined
      ? '没听出要哪个文件。换个说法,比如「把 README 发我」。'
      : `「${plan.project.name}」是一整个仓库,要里面哪一个文件?比如「把${plan.project.name}的 README 发我」。`
  }
  const what = plan.terms.map(term => `「${term}」`).join('、')
  const where = plan.project !== undefined
    ? `「${plan.project.name}」里`
    : input.authorized ? '授权过的目录里' : `${input.workDirLabel}里`
  return `在${where}没找到名字带${what}的文件。`
}

/** 找文件的范围:授权了没有、在哪几个根里找、认得哪些项目。 */
export interface FetchScope {
  /** `read_scan_roots` 是不是「可以」。 */
  authorized: boolean
  /** 没授权 / 没接授权表时那一句(原样摆给他看)。 */
  note?: string
  /** 能找的根(扫描根 + 事务官文件夹)。 */
  roots: readonly FetchRoot[]
  /** 认得的项目(只收在能找的根底下的那些)。 */
  projects: readonly ProjectRef[]
}

/**
 * 他那句话 → 手机上那张卡。找、排序、每个候选各开一张取件单。**绝不抛**。
 *
 * 认出了项目就只在项目底下找(找不到时**不**退到全盘:他点了名的仓库里没有,
 * 在别处找到一个同名的只会让他以为是那一个)。
 */
export async function buildFileAsk(
  input: { request: string, query: string, deviceId: string, computer: string },
  deps: { scope: () => Promise<FetchScope>, offers: FileOffersStore, search?: LocalSearchDeps, newId?: () => string },
): Promise<FileAskView> {
  const id = deps.newId?.() ?? randomBytes(9).toString('base64url')
  let scope: FetchScope
  try { scope = await deps.scope() }
  catch { scope = { authorized: false, note: '这会儿说不出能在哪些目录里找。', roots: [], projects: [] } }
  const plan = planFileQuery(input.query, scope.projects)
  const base = { id, request: input.request, query: plan.label, device: input.computer }
  if (plan.terms.length === 0) {
    return { ...base, hits: [], total: 0, note: notFoundNote(plan, { authorized: scope.authorized, workDirLabel: '事务官文件夹' }) }
  }
  const roots: readonly FetchRoot[] = plan.project !== undefined
    ? [{ path: plan.project.path, label: plan.project.name, depth: FETCH_MAX_DEPTH }]
    : scope.roots
  if (roots.length === 0) {
    return { ...base, hits: [], total: 0, note: scope.note ?? '这台电脑上还没有能找的目录。' }
  }
  const outcome = await searchLocalFiles(
    { roots, terms: plan.terms, ...(plan.project === undefined ? {} : { whereLabel: plan.project.name }) },
    deps.search ?? {},
  )
  const ranked = rankFound(outcome.files, plan.terms).slice(0, FETCH_ASK_HITS)
  const hits: FileAskHitView[] = ranked.map((file) => {
    const offer = deps.offers.add({
      path: file.path,
      name: file.name,
      bytes: file.bytes,
      where: file.where,
      device_id: input.deviceId,
      source: 'typed',
    })
    return {
      offer: offer.id,
      name: file.name,
      where: file.where,
      bytes: file.bytes,
      kind: fetchKindOf(file.name),
      ...(file.mtimeMs === undefined ? {} : { mtime: new Date(file.mtimeMs).toISOString() }),
    }
  })
  const notes: string[] = []
  if (hits.length === 0) notes.push(notFoundNote(plan, { authorized: scope.authorized, workDirLabel: '事务官文件夹' }))
  if (outcome.total > hits.length && hits.length > 0) notes.push(`一共 ${outcome.total} 个,只列了最像的 ${hits.length} 个;不是这几个就说得再具体一点。`)
  if (outcome.truncated && hits.length === 0) notes.push('目录太大,只找了一部分。')
  if (plan.project === undefined && scope.note !== undefined) notes.push(scope.note)
  // 没权限那一条**排在最前**(2026-10-13):它是唯一一条她照着做就能根治的。
  if (outcome.denied.length > 0) notes.unshift(FILE_ACCESS_DENIED_NOTE)
  if (outcome.errors.length > 0) notes.push(outcome.errors.join(';'))
  return { ...base, hits, total: outcome.total, ...(notes.length === 0 ? {} : { note: notes.join(' ') }) }
}
