/**
 * 本机验收:**工人经中转接话**,全程不碰真的 api.deepseek.com,也不碰真的 ~/.dsh。
 *
 *   node dev/relay-smoke.ts
 *
 * 它按真实顺序把整条链路串一遍:
 *
 *   ① 起假上游(relay/dev/fakeUpstream.cjs,会说 OpenAI 方言的最小服务器);
 *   ② 起中转(relay/server/app.cjs),上游指向 ①,用一个临时的内存库;
 *   ③ 走 /admin/tokens 发一个中转令牌;
 *   ④ 在**临时 HOME** 里写一份 model.json(mode=relay),模拟用户在设置里选了
 *      「用工作台提供的服务」;
 *   ⑤ 让工人自己的 resolveChannelModel() 去读那份文件,得出 base URL 与 key;
 *   ⑥ 用工人真正用的那个 LLM 客户端(@livekit/agents-plugin-openai 的
 *      `LLM.withDeepSeek`,agent.ts 里就是它)流式要一段回话;
 *   ⑦ 回头看中转的 /admin/usage —— 这一次的 token 有没有真的记在那个令牌名下。
 *
 * 少的只有音频那一段(VAD / ASR / TTS 与 LiveKit 房间):那几件与「模型往哪儿发」无关,
 * 而要把它们拉起来就得有 livekit-server 与麦克风。接话模型是假的,这是**故意的**——
 * 这里验的是线有没有接对,不是模型说得好不好。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeLogger, llm as llmNs } from '@livekit/agents'
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai'
import { resolveChannelModel } from '../src/modelChoice.ts'
import { CHANNEL_DEFAULTS } from '../src/config.ts'

const require_ = createRequire(import.meta.url)
const relayDir = join(import.meta.dirname, '..', '..', 'relay')
const { startFakeUpstream } = require_(join(relayDir, 'dev', 'fakeUpstream.cjs'))
const { createApp } = require_(join(relayDir, 'server', 'app.cjs'))
const { relayConfigOf } = require_(join(relayDir, 'server', 'config.cjs'))
const { openRelayDb } = require_(join(relayDir, 'server', 'db.cjs'))

const UPSTREAM_KEY = 'sk-fake-upstream-smoke'
const REPLY = '好的,这件事我记下了,忙完告诉你。'

function step(n: number, line: string): void {
  console.log(`\n[${n}] ${line}`)
}

async function main(): Promise<void> {
  // agents 的 LLM 客户端在构造 stream 时就要 logger,main.ts 里第一行做的也是这件事。
  initializeLogger({ pretty: true, level: 'warn' })
  const home = mkdtempSync(join(tmpdir(), 'wb-relay-smoke-'))
  let upstream: { url: string, close: () => Promise<unknown> } | undefined
  let server: { close: (cb: () => void) => void, address: () => { port: number } } | undefined

  try {
    step(1, '起假上游……')
    upstream = await startFakeUpstream({ expectedKey: UPSTREAM_KEY, reply: REPLY })
    console.log(`    假上游 ${upstream!.url}`)

    step(2, '起中转,上游指向假上游……')
    const db = openRelayDb(':memory:')
    const config = {
      ...relayConfigOf({}),
      upstreamUrl: upstream!.url,
      upstreamKey: UPSTREAM_KEY,
      dailyTokenLimit: 1000,
    }
    const app = createApp({ db, config, log: (line: string) => console.log(`    [relay] ${line}`) })
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const relayUrl = `http://127.0.0.1:${server!.address().port}`
    console.log(`    中转 ${relayUrl}`)

    step(3, '走管理接口发一个中转令牌……')
    const issued = await (await fetch(`${relayUrl}/admin/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'ben', device_id: 'smoke-mac' }),
    })).json() as { token: string, prefix: string }
    console.log(`    领到令牌 ${issued.prefix}…(整串不打印)`)

    step(4, '在临时 HOME 里写 model.json —— 等于用户在设置里选了「用工作台提供的服务」')
    mkdirSync(join(home, '.dsh', 'workbench'), { recursive: true })
    writeFileSync(
      join(home, '.dsh', 'workbench', 'model.json'),
      `${JSON.stringify({ mode: 'relay', relay_url: relayUrl, relay_token: issued.token, device_id: 'smoke-mac' }, null, 2)}\n`,
      { mode: 0o600 },
    )
    console.log(`    ${join(home, '.dsh', 'workbench', 'model.json')}`)

    step(5, '工人自己去读那份文件……')
    const target = await resolveChannelModel({
      env: {}, home, fallbackBaseUrl: CHANNEL_DEFAULTS.llmBaseUrl,
    })
    console.log(`    ${target.note};地址 ${target.baseUrl};来源 ${target.source};能用 ${target.ready}`)
    if (target.source !== 'relay') throw new Error(`本该走中转,实际是 ${target.source}`)

    step(6, '用工人真正用的那个 LLM 客户端要一段回话(流式)……')
    const llm = OpenAILLM.withDeepSeek({
      model: CHANNEL_DEFAULTS.llmModel,
      apiKey: target.key as string,
      baseURL: target.baseUrl,
    })
    const chatCtx = llmNs.ChatContext.empty()
    chatCtx.addMessage({ role: 'user', content: '帮我记一下:明天下午三点跟客户对一次方案。' })
    const stream = llm.chat({ chatCtx })
    let said = ''
    for await (const chunk of stream) {
      said += chunk.delta?.content ?? ''
    }
    console.log(`    模型说:${said}`)
    if (said !== REPLY) throw new Error(`回话对不上:期望「${REPLY}」,实际「${said}」`)

    step(7, '回头看中转记的账……')
    const usage = await (await fetch(`${relayUrl}/admin/usage`)).json() as {
      day: string
      rows: { prefix: string, account: string, requests: number, total_tokens: number }[]
    }
    const row = usage.rows.find(r => r.prefix === issued.prefix)
    console.log(`    ${usage.day} · ${row?.account} · ${row?.prefix} · ${row?.requests} 次 · ${row?.total_tokens} token`)
    if ((row?.requests ?? 0) < 1) throw new Error('中转没记上这一次请求')
    if ((row?.total_tokens ?? 0) < 1) throw new Error('中转没记上 token —— 流式的 include_usage 那一步没生效')

    console.log('\n✅ 整条链路通了:工人 → 中转 → (假)上游,而且用量记在了那个令牌名下。')
  }
  finally {
    server?.close(() => {})
    await upstream?.close()
    rmSync(home, { recursive: true, force: true })
  }
}

await main()
