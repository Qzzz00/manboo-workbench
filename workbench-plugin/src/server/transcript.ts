/**
 * 从 Claude 的 transcript JSONL 里提取会话标题/摘要（PRD §5.3：拿不到不编造）。
 *
 * 这段跑在 hook 请求的处理路径上：Claude 那头的 curl 等着这次 POST 落地才退出
 * （agent-hook.sh --max-time 1），transcript 可能有几 MB，所以默认只读头尾各至多
 * CHUNK_BYTES 字节、按行解析，绝不把整份文件读进内存做全量 JSON.parse。
 *
 * 头部有一种例外要单独处理：**第一条 user 消息可能贴了张截图**。真实数据验证过——
 * 一条贴图的 user 消息单行能到 441KB（base64 图片数据撑大的），200KB 的头根本装不下
 * 一整行，JSON.parse 直接失败，标题就变成 undefined。所以头部改成"够用就停、不够用
 * 就按 4 倍往上长，封顶 MAX_HEAD_BYTES"——常规会话第一次 200KB 就能拿到标题，
 * 不会多读一个字节；只有这种大附件开场的会话才会多读几轮。尾部不做这个处理：
 * 摘要（最后一条 assistant 文本）在真实数据上已经验证没这个问题，尾部继续固定大小。
 *
 * 标题优先级：type=="custom-title" 的最后一条（Claude Code 的正式会话名，
 * `{"type":"custom-title","customTitle":"...","sessionId":"..."}`，2026-08-21 Ben 抓出来的
 * 硬伤——第一版只找了 type=="summary"，漏了这个字段；真实文件里 custom-title 会话
 * 一确定就重复写好几十条同样内容的行，不是只出现一次）> type=="summary" 的最后一条
 * （压缩摘要，本机 172 个文件实测没见过一条，字段存在但没实测触发过）> 第一条能读出
 * 文字的 user 消息。
 *
 * 副作用（头部固有的截断代价，接受它换"不拖慢 Claude"这条更硬的约束）：
 * 三种来源若都只出现在 MAX_HEAD_BYTES 之外的文件正中间，这里看不到。
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const DEFAULT_CHUNK_BYTES = 200 * 1024
/** 头部增长的封顶。441KB 的真实案例第二轮（800KB）就能读全；4MB 留够余量又不会退化成读整份文件。 */
const DEFAULT_MAX_HEAD_BYTES = 4 * 1024 * 1024
/** 头部每轮探测不到就往上长的倍数。 */
const HEAD_GROWTH_FACTOR = 4
const TITLE_MAX = 40
const SUMMARY_MAX = 80

/**
 * 明显不是人打的文字，混进 user 消息里的常客：技能注入的说明文本、系统提醒、
 * 斜杠命令的展开——都不该被当成"这个会话在聊什么"的标题。
 * 前缀匹配足够：这些都是固定模板开头的注入文本，不是用户能打出来的自然语言。
 */
const NON_HUMAN_TEXT_PREFIXES = ['Base directory for this skill', '<system-reminder', '<command-name>'] as const

export interface ExtractOptions {
  /** 头尾初始各读取的字节数，默认 200KB。测试用小值验证"只看头尾、不扫中间"。 */
  chunkBytes?: number
  /** 头部增长的封顶，默认 4MB。测试用小值验证"长到头也找不到就放弃，不会读穿整个文件"。 */
  maxHeadBytes?: number
}

export interface ClaudeTranscriptDetails {
  title?: string
  summary?: string
}

function readChunk(fd: number, position: number, length: number): string {
  if (length <= 0) return ''
  const buf = Buffer.alloc(length)
  const bytesRead = readSync(fd, buf, 0, length, position)
  return buf.toString('utf8', 0, bytesRead)
}

function splitLines(chunk: string): string[] {
  return chunk.split('\n').filter(line => line.trim() !== '')
}

/**
 * 逐行 JSON.parse。头尾截断可能把首/末一行切成半截，那一行必然解析失败——
 * 按行 try/catch，扔掉那一行就好，不能因为半截行让整段提取失败。
 */
function tryParseLine(line: string): Record<string, unknown> | undefined {
  try {
    const obj: unknown = JSON.parse(line)
    return typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : undefined
  }
  catch {
    return undefined
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** 判断一段文本能不能当标题/摘要用：非空，且不是技能注入/系统提醒那类固定模板开头。 */
function isUsableText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  return !NON_HUMAN_TEXT_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

/**
 * type=="user" 消息里第一段能用的文本：
 * - content 是字符串（老格式）：直接判断能不能用。
 * - content 是数组：**遍历全部 block**（不止第一个），找第一个 type=="text" 且
 *   `isUsableText` 的——真实数据里贴图的消息是 `[image, image, text]`，图片块
 *   排在文本前面很常见，只看第一个块会直接判定"没有文字"。
 * 整条消息里没有能用的文本（纯图、纯 tool_result、纯技能注入）就返回 undefined，
 * 调用方据此跳到下一条 user 消息，不能拿这条当"会话没有标题"的结论。
 */
function userText(obj: Record<string, unknown>): string | undefined {
  const message = obj.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') {
    return isUsableText(content) ? content : undefined
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string' && isUsableText(text)) return text
      }
    }
  }
  return undefined
}

/** type=="assistant" 消息里全部 type=="text" 块按序拼起来（thinking 块跳过——那不是给人看的）。 */
function assistantText(obj: Record<string, unknown>): string | undefined {
  const message = obj.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

interface HeadScan {
  customTitle?: string
  summaryTitle?: string
  firstUserText?: string
}

/**
 * 扫一遍缓冲区，找 type=="custom-title" 的最后一条 + type=="summary" 的最后一条 +
 * 第一条能读出文字的 user 消息。
 *
 * custom-title 是 2026-08-21 Ben 抓出来的硬伤：Claude Code 每个会话本来就有正式标题，
 * 存在 `{"type":"custom-title","customTitle":"...","sessionId":"..."}` 这种行里——
 * 本会话文件实测有 85 条同样内容的行贯穿全程（Claude Code 大概是每次会话标题一确定
 * 就重复写一遍，不是只写一次）。之前只找了 type=="summary"，完全漏掉了这个字段，
 * 属于没扫全字段，不是数据里真没有。
 */
function scanForTitle(chunk: string): HeadScan {
  let customTitle: string | undefined
  let summaryTitle: string | undefined
  let firstUserText: string | undefined
  for (const line of splitLines(chunk)) {
    const obj = tryParseLine(line)
    if (obj === undefined) continue
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle !== '') {
      customTitle = obj.customTitle
    }
    if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary !== '') summaryTitle = obj.summary
    if (firstUserText === undefined && obj.type === 'user') {
      const text = userText(obj)
      if (text !== undefined) firstUserText = text
    }
  }
  return {
    ...(customTitle === undefined ? {} : { customTitle }),
    ...(summaryTitle === undefined ? {} : { summaryTitle }),
    ...(firstUserText === undefined ? {} : { firstUserText }),
  }
}

export function extractClaudeDetails(
  filePath: string,
  wantSummary: boolean,
  options: ExtractOptions = {},
): ClaudeTranscriptDetails {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const maxHeadBytes = Math.max(chunkBytes, options.maxHeadBytes ?? DEFAULT_MAX_HEAD_BYTES)

  let fd: number
  try {
    fd = openSync(filePath, 'r')
  }
  catch {
    return {}
  }

  try {
    const size = fstatSync(fd).size

    // 头部：够用就停，不够用按 4 倍往上长，封顶 maxHeadBytes 或文件本身大小。
    // "够用"＝找到了 custom-title/summary 行，或者一条能读出文字的 user 消息——
    // 常规会话第一轮就命中，只有大附件开场（贴图撑大第一行）才会往上长。
    let headBytes = Math.min(chunkBytes, size)
    let headScan: HeadScan = {}
    let headText = ''
    for (;;) {
      headText = readChunk(fd, 0, headBytes)
      headScan = scanForTitle(headText)
      if (headScan.customTitle !== undefined || headScan.summaryTitle !== undefined || headScan.firstUserText !== undefined) break
      if (headBytes >= size || headBytes >= maxHeadBytes) break
      headBytes = Math.min(headBytes * HEAD_GROWTH_FACTOR, maxHeadBytes, size)
    }
    const headLines = splitLines(headText)

    const tailLen = Math.min(chunkBytes, size)
    const tail = readChunk(fd, Math.max(0, size - tailLen), tailLen)
    const tailLines = splitLines(tail)

    // custom-title / summary 都取"窗口内最后一条"：尾部比头部"更晚"，尾部里找到的覆盖头部的。
    let customTitle = headScan.customTitle
    let summaryTitle = headScan.summaryTitle
    for (const line of tailLines) {
      const obj = tryParseLine(line)
      if (obj === undefined) continue
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle !== '') {
        customTitle = obj.customTitle
      }
      if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary !== '') summaryTitle = obj.summary
    }

    // 优先级：custom-title（Claude Code 的正式会话名，用户在 UI 里改过/系统生成过）
    // > summary（旧的压缩摘要）> 第一条能读出文字的 user 消息。
    const titleSource = customTitle ?? summaryTitle ?? headScan.firstUserText
    const title = titleSource === undefined ? undefined : truncate(titleSource, TITLE_MAX)

    if (!wantSummary) return title === undefined ? {} : { title }

    let lastAssistant: string | undefined
    for (const line of tailLines) {
      const obj = tryParseLine(line)
      if (obj === undefined || obj.type !== 'assistant') continue
      const text = assistantText(obj)
      if (text !== undefined && text !== '') lastAssistant = text
    }
    if (lastAssistant === undefined) {
      // 对话很短、整段都落在头部里的情况（尾部与头部重叠时也会走到这）。
      for (const line of headLines) {
        const obj = tryParseLine(line)
        if (obj === undefined || obj.type !== 'assistant') continue
        const text = assistantText(obj)
        if (text !== undefined && text !== '') lastAssistant = text
      }
    }
    const summary = lastAssistant === undefined ? undefined : truncate(lastAssistant, SUMMARY_MAX)

    return {
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
    }
  }
  catch {
    return {}
  }
  finally {
    closeSync(fd)
  }
}
