/**
 * 一台**假的 8792**(butler-server),只为在本机把「语音后端出事」那几条路真跑一遍。
 *
 * 为什么要它(2026-09-20,Ben 真机第二轮「十分钟断线」):
 * 那一次的根因是 8792 回了 502(火山 429 并发超限),框架攒够三条 `tts_error` 就把
 * 整条 AgentSession 关掉。要验「以后不会关了」,就得能**按需造出那个 502** ——
 * 真的 8792 要么好好的、要么得去把人家的配额打爆,两样都不能当验收手段。
 *
 * 它认三条路:
 *   GET  /health   → 200(工人启动时探一次)
 *   POST /api/tts  → 正常模式回一段真 WAV(一段很轻的正弦,能进房、能播);
 *                    失败模式回 **502 + 与真 8792 一模一样的 body**(含 detail 那句上游原话)。
 *   POST /api/asr  → 回一句定死的转写(本机没有火山 ASR 凭证,这一段不是这次要验的东西)。
 * 外加两条给验收用的:
 *   POST /__mode { mode: 'ok' | 'fail' }  → 当场切换(不用重启,正好模拟「8792 中途出事」)
 *   GET  /__stats                         → 合成了几次、**同一时刻最多并到几条**(验并发闸)
 *
 * 用法:node dev/fake-butler.ts [--port 8892] [--mode ok|fail] [--asr '你就叫我本吧。'] [--speed 0.08]
 *
 * **它不碰任何凭据,也不连外网。**
 */
import { createServer } from 'node:http'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const port = Number(arg('port', '8892'))
let mode = arg('mode', 'ok') === 'fail' ? 'fail' : 'ok'
const asrText = arg('asr', '你就叫我本吧。')
/** 识别本身假装要多久(毫秒,2026-09-25 卡 S)。缺省 0:只量「经房间转」这一段多花的时间。 */
const asrDelayMs = Number(arg('asr-delay-ms', '0'))
/** `/api/asr` 收到过什么(字节数、类型、哪台设备)。`GET /__stats` 带出去,端到端据此核对录音原样到了。 */
const asrSeen: { bytes: number, type: string, device: string }[] = []
/**
 * 一个字念多久(秒)。真人与真 TTS 大约 0.2;这里**故意快**(0.08),
 * 好让一遍脚本化的验收不用干等她把一百字的开场白念完 —— 假手机是按固定节拍放录音的。
 * 要量「听起来像不像」就把它调到 0.2。
 */
const secondsPerChar = Number(arg('speed', '0.08'))

/** 真 8792 在火山并发超限时回的那一句(Ben 那台 `~/.dsh/logs/butler.stderr.log` 里逐字抄的)。 */
const UPSTREAM_429 = 'volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency'

const SAMPLE_RATE = 24000

let synthCount = 0
let active = 0
let peak = 0

/** 一段能播的 WAV。字数决定时长(见 secondsPerChar)。 */
function wavOf(text: string): Buffer {
  const seconds = Math.max(0.3, text.length * secondsPerChar)
  const samples = Math.round(SAMPLE_RATE * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    // 很轻的 220Hz 正弦:听得见有声音,又不会刺耳。
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 2000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (path === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ mode, synthCount, peak, asr: asrSeen }))
      return
    }
    if (path === '/__mode') {
      const body = await readBody(req)
      try { mode = (JSON.parse(body) as { mode?: string }).mode === 'fail' ? 'fail' : 'ok' }
      catch { /* 乱七八糟的 body 就当没改 */ }
      console.log(`[fake-8792] 切到 ${mode}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ mode }))
      return
    }
    if (path === '/api/asr') {
      // 2026-09-25(卡 S):记下收到了什么(字节数、类型、设备),`--asr-delay-ms` 模拟识别本身要的时间。
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      asrSeen.push({ bytes: Buffer.concat(chunks).length, type: String(req.headers['content-type'] ?? ''), device: String(req.headers['x-workbench-device'] ?? '') })
      if (asrDelayMs > 0) await new Promise(done => setTimeout(done, asrDelayMs))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: asrText }))
      return
    }
    if (path === '/api/tts') {
      const body = await readBody(req)
      let text = ''
      try { text = String((JSON.parse(body) as { text?: unknown }).text ?? '') } catch { /* 空的也照答 */ }
      synthCount += 1
      active += 1
      peak = Math.max(peak, active)
      // 合成要时间。150ms 与真火山同一个量级,也让「同一时刻并了几条」量得出来。
      await new Promise(resolve => setTimeout(resolve, 150))
      active -= 1
      if (mode === 'fail') {
        console.log(`[fake-8792] 502(并发超限)← 「${text.slice(0, 20)}」`)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 'tts_failed', error: '语音合成失败,请稍后再试', detail: UPSTREAM_429 }))
        return
      }
      const wav = wavOf(text)
      console.log(`[fake-8792] 出声 ${wav.length} 字节 ← 「${text.slice(0, 20)}」(此刻并发峰值 ${peak})`)
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      res.end(wav)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '假 8792 只认 /health、/api/tts、/api/asr、/__mode、/__stats' }))
  })()
}).listen(port, '127.0.0.1', () => {
  console.log(`[fake-8792] 起来了:http://127.0.0.1:${port}(mode=${mode},asr 回「${asrText}」)`)
})
