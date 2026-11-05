/**
 * 一台**假的接话模型**:OpenAI 兼容的 `/v1/chat/completions`,流式,会调工具。
 *
 * 为什么要它:本机没有 DeepSeek 的 key(工作台设置里那一格没填,环境变量也没有),
 * 但「进房 → VAD → ASR → 模型 → TTS → 回房」这一整条链路除了模型的脑子以外都是真的。
 * 把 `WORKBENCH_CHANNEL_LLM_BASE_URL` 指到这里,链路上**每一段真代码都会跑到**:
 * 真的 openai 插件、真的工具调用、真的火山 TTS、真的房间音频。测出来的延迟里
 * 唯一不真的就是「模型想了多久」—— 这一条在交接文档里写清楚。
 *
 * 它的「智能」只有两条规则:
 *   ① 听见「记」或者「帮我」就调 wb_remember_item;
 *   ② **手上有 `scan_projects` 这件工具就先调它**(2026-09-20:引导②′「授权一到就扫」那条要验)。
 * 别的都回一句短话。
 *
 * 用法:node dev/stub-llm.mjs [端口]
 * 环境变量:
 *   STUB_LLM_DELAY_MS   第一个字之前先卡这么久(默认 0)。验缓冲语要把它调到 700 以上 ——
 *                       那正是「模型首字超过 700ms 就垫一句『我想想』」要触发的条件。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8796)
const MODEL = 'deepseek-v4-flash'
/** 第一个字之前先卡这么久。验缓冲语用(见文件头)。 */
const DELAY_MS = Number(process.env.STUB_LLM_DELAY_MS ?? 0)

/** 听见这几个字就当成「他在交代一件事」。 */
const TASK_HINTS = ['记一下', '记下', '帮我', '提醒我', '安排']

/** 听见这几个字就当成「他要我去找个文件发过来」(2026-09-21,设备间传文件那张卡)。 */
const FILE_HINTS = ['发我', '发给我', '传我', '发到', '传到', '发过来', '找出来', '找一下', '在哪']

/** 听见这几个字就当成「他点头了」(复述确认之后的那一句)。 */
const YES_HINTS = ['对', '是的', '发吧', '好的', '没错']

/**
 * 从他那句话里抠出要搜的词。抠不出来就用整句 —— 反正搜不到会如实回。
 *
 * 2026-09-25(卡 J):**像一个真模型那样把项目名也带上**(「工作台 README」)——
 * 工具描述里就是这么教它的,8791 会先认出是哪个仓库。句子里带着文件名(有扩展名的那一段)就整段用。
 */
function queryOf(said) {
  const project = /(工作台|事务官|官网|展示台)/.exec(said)?.[1]
  const withExt = /([^\s把发给我的请帮找一下传在哪里「」]+\.[A-Za-z0-9]{2,5})/.exec(said)?.[1]
  const ascii = /([A-Za-z][A-Za-z0-9_\-]{2,})/.exec(said)?.[1]
  const word = withExt ?? ascii
  if (word !== undefined) return project === undefined ? word : `${project} ${word}`
  return said.replace(/[把发给我的请帮找一下传在哪到手机上]/g, '').trim() || said
}

/** 上一条工具结果(模型看到的那段文字)。 */
function lastToolText(messages) {
  const last = [...messages].reverse().find(m => m.role === 'tool')
  return typeof last?.content === 'string' ? last.content : ''
}

/**
 * 从搜索结果那段文字里挑第一条「设备 + 路径」。格式见 files/deviceTools.ts 的 spokenSearchResults。
 *
 * 工具结果到模型手上时是**被 JSON 转义过的**(整段带引号、换行是字面的 \n)——
 * 第一遍没处理,抠出来的设备名带着引号、路径尾巴上挂着下一行,工具如实回了
 * 「没有哪一台在线设备叫『"书房 Mac』」。先还原再抠。
 */
function firstHit(text) {
  const clean = text.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '')
  // 新格式(2026-09-25):结果里只有编号,没有路径。
  const numbered = /编号 (\d+)/.exec(clean)
  if (numbered !== null) return { file: numbered[1] }
  const device = /^(.+?)\((?:电脑|手机)\):找到/m.exec(clean)
  const path = /路径 ([^\s"]+)/.exec(clean)
  if (device === null || path === null) return null
  return { device: device[1].trim(), path: path[1] }
}

/** 会话里最后一次 wb_send_file 的参数(复述确认之后要照原样再调一次)。 */
function lastSendArgs(messages) {
  for (const message of [...messages].reverse()) {
    for (const call of message?.tool_calls ?? []) {
      if (call?.function?.name !== 'wb_send_file') continue
      try { return JSON.parse(call.function.arguments ?? '{}') } catch { return null }
    }
  }
  return null
}

/** 这一轮给了我们哪几件工具(OpenAI 的 tools 数组)。 */
function toolNames(request) {
  return (Array.isArray(request.tools) ? request.tools : [])
    .map(tool => tool?.function?.name)
    .filter(name => typeof name === 'string')
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunk(delta, finish = null) {
  return {
    id: 'stub-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (!(req.url ?? '').includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'stub 只认 /v1/chat/completions' }))
    return
  }
  const body = []
  req.on('data', c => body.push(c))
  req.on('end', async () => {
    let request = {}
    try { request = JSON.parse(Buffer.concat(body).toString()) } catch { /* 空请求也照答 */ }
    const messages = Array.isArray(request.messages) ? request.messages : []
    const last = [...messages].reverse().find(m => m.role === 'user')
    const said = typeof last?.content === 'string' ? last.content : ''
    /**
     * **看最后一条是什么**(2026-09-21 修):以前用的是「会话里出现过 tool 消息」,
     * 那是个一旦为真就再也不变的标志 —— 引导里第一轮扫过一次仓库之后,后面每一轮都被它拦住,
     * 于是「把 README 发我」永远走不到查找文件那件工具。真跑那一遍逐字印证了这个顺序。
     */
    const lastMessage = messages[messages.length - 1]
    const lastIsTool = lastMessage?.role === 'tool'
    const alreadyCalled = lastIsTool
    const wantsTask = !lastIsTool && TASK_HINTS.some(hint => said.includes(hint))
    const tools = toolNames(request)
    const toolText = lastToolText(messages)
    /**
     * 设备间传文件那条链(2026-09-21),三步走:
     *   ① 他说「把 X 发我」→ 先去 wb_search_files 找;
     *   ② 拿到搜索结果 → 调 wb_send_file(**不带 confirmed**),换回来一句复述;
     *   ③ 他说「对」→ 照原样再调一次,这次 confirmed: true。
     * 这三步里模型是假的,**工具那两道闸(白名单、复述确认)是真的**。
     */
    const wantsFind = !lastIsTool && tools.includes('wb_search_files') && FILE_HINTS.some(hint => said.includes(hint))
    const hit = lastIsTool && tools.includes('wb_send_file') && (toolText.includes('路径 ') || toolText.includes('编号 ')) ? firstHit(toolText) : null
    const confirmPending = lastIsTool && toolText.includes('还没传。先照着这句问他一遍')
    const saidYes = YES_HINTS.some(hint => said.trim().startsWith(hint))
    // 他点头了:把上一次那条 wb_send_file 的参数原样再调一次,这次带 confirmed。
    const resend = !lastIsTool && saidYes ? lastSendArgs(messages) : null
    // 引导②′:手上有 scan_projects 就先去扫,不凭空问(2026-09-20)。
    const scannedBefore = messages.some(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('扫到'))
    const wantsScan = !lastIsTool && !wantsTask && !scannedBefore && toolNames(request).includes('scan_projects')

    console.log(`[stub-llm] 听到:「${said}」→ ${wantsTask ? '调工具 wb_remember_item' : wantsScan ? '调工具 scan_projects' : '直接答'}`)

    // 第一个字之前先卡一会儿(验缓冲语:>700ms 就该听见一句「我想想」)。
    if (DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, DELAY_MS))

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    /** 一条工具调用的 SSE。 */
    const emitTool = (name, args) => {
      sse(res, chunk({
        role: 'assistant',
        tool_calls: [{ index: 0, id: `call_stub_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      }))
      sse(res, chunk({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
    }

    if (wantsFind) {
      const query = queryOf(said)
      console.log(`[stub-llm] → 调工具 wb_search_files{query:${query}}`)
      emitTool('wb_search_files', { query })
      return
    }
    if (hit !== null && !confirmPending) {
      // 搜到了 → 提一次传输请求(故意不带 confirmed,要的就是那句复述)。
      // 「to」照真模型最常见的填法:他说「发到我手机上」,它就填「我的手机」(2026-09-25 以前这里会撞「没有哪台叫『我』」)。
      const to = process.env.STUB_LLM_SEND_TO ?? '我的手机'
      if (hit.file !== undefined) {
        console.log(`[stub-llm] → 调工具 wb_send_file{file:${hit.file},to:${to}}(不带 confirmed)`)
        emitTool('wb_send_file', { file: hit.file, to })
        return
      }
      console.log(`[stub-llm] → 调工具 wb_send_file{device:${hit.device},path:${hit.path}}(不带 confirmed)`)
      emitTool('wb_send_file', { device: hit.device, path: hit.path, to })
      return
    }
    if (confirmPending) {
      // 复述那一句原样念出去,然后闭嘴等他点头。
      // 取**外层**那一对「」里的整句(里面还套着文件名的「」,非贪婪会在文件名那儿截断)。
      const clean = toolText.replace(/\\n/g, '\n')
      const line = /先照着这句问他一遍:「(.+)」他明确/.exec(clean)?.[1] ?? /「(.+?)」/.exec(clean)?.[1] ?? '我确认一下,这个发过去可以吗?'
      sse(res, chunk({ role: 'assistant', content: '' }))
      sse(res, chunk({ content: line }))
      sse(res, chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (resend !== null) {
      console.log('[stub-llm] → 他点头了,再调一次 wb_send_file{confirmed:true}')
      emitTool('wb_send_file', { ...resend, confirmed: true })
      return
    }

    if (wantsScan) {
      sse(res, chunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_stub_scan',
          type: 'function',
          function: { name: 'scan_projects', arguments: '{}' },
        }],
      }))
      sse(res, chunk({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (wantsTask) {
      sse(res, chunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_stub_1',
          type: 'function',
          function: { name: 'wb_remember_item', arguments: JSON.stringify({ text: said }) },
        }],
      }))
      sse(res, chunk({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // 一句短话,分两片吐出来 —— 这样 TTS 的按句切分也走到了。
    // 上一轮是扫仓库的话,把清单里的名字念回去(证明她真拿到了那份清单)。
    const lastTool = [...messages].reverse().find(m => m.role === 'tool')
    const scanned = typeof lastTool?.content === 'string' && lastTool.content.includes('扫到')
    const toolSaid = typeof lastTool?.content === 'string' ? lastTool.content : ''
    const reply = scanned
      ? [`${(/扫到 \d+ 个仓库/.exec(lastTool.content) ?? ['我看了一眼你的仓库'])[0]}。`, '先从哪个说起?']
      : alreadyCalled && toolSaid.includes('发过去了')
        ? ['发过去了,', '你看一下手机。']
        : alreadyCalled && toolSaid.includes('开始传了')
          ? ['在传了,', '传完手机上会提示。']
          : alreadyCalled
        ? ['好,记下了。', '我让事务官去办,办完告诉你。']
        : ['我在。', '你说。']
    sse(res, chunk({ role: 'assistant', content: '' }))
    for (const piece of reply) sse(res, chunk({ content: piece }))
    sse(res, chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`[stub-llm] 假接话模型:http://127.0.0.1:${port}/v1`)
})
