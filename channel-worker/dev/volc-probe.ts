/**
 * **问一句火山流式 ASR:你还活着吗、你回的是什么。**(2026-09-18,交接-0918-引导通话不理人)
 *
 * 为什么要它:「她听不见我」有好几种长相 —— 手机没发麦克风、声音没到 Mac、
 * 火山报错、火山有中间结果却不给判停。前两种看 appops 与工人日志就知道,
 * 后两种以前只能靠猜。这条命令把**回包一帧一帧原样打出来**,一眼分得清。
 *
 *   node dev/volc-probe.ts [一段16k单声道的.wav]
 *
 * 不给 wav 就推两秒静音(只验「连得上、鉴权过、开场帧对」)。
 * 凭证从 `~/.dsh/workbench/channel.json` 读(`volc_asr_app_id` / `volc_asr_access_token`),
 * **只进请求头,一个字符都不打印**。
 *
 * 一段能用的 wav 怎么来:
 *   curl -s -X POST http://127.0.0.1:8792/api/tts -H 'content-type: application/json' \
 *     -d '{"text":"你就叫我本吧。","scene":"chat","encoding":"wav"}' -o /tmp/raw.wav
 *   ffmpeg -y -i /tmp/raw.wav -ar 16000 -ac 1 -sample_fmt s16 /tmp/answer.wav
 *
 * 要看的:`definite=true` 的那一条出没出来 —— **那一条就是「这句说完了」**,
 * 没有它,LiveKit Agents 那边永远不接话(根因见交接文档第一节)。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { buildStartFrame, buildAudioFrame, parseFrame, errorMessageOf, transcriptOf, PCM_CHUNK_BYTES, MSG_SERVER_ERROR } from '../src/asr/volcProtocol.ts'

const file = JSON.parse(readFileSync(process.env.HOME + '/.dsh/workbench/channel.json', 'utf8'))
const headers = {
  'X-Api-App-Key': String(file.volc_asr_app_id),
  'X-Api-Access-Key': String(file.volc_asr_access_token),
  'X-Api-Resource-Id': String(file.volc_asr_resource_id ?? 'volc.bigasr.sauc.duration'),
  'X-Api-Request-Id': randomUUID(),
  'X-Api-Connect-Id': randomUUID(),
}
const wavPath = process.argv[2]
const pcm = wavPath ? readFileSync(wavPath).subarray(44) : Buffer.alloc(16000 * 2 * 2)
console.log('PCM 字节:', pcm.length, '来源:', wavPath ?? '静音')

const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel', { headers })
let seq = 1
ws.on('upgrade', (res) => {
  console.log('HTTP', res.statusCode, 'logid=', res.headers['x-tt-logid'], 'X-Api-Status-Code=', res.headers['x-api-status-code'], 'X-Api-Message=', res.headers['x-api-message'])
})
ws.on('open', () => {
  console.log('[open] 发开场帧')
  ws.send(buildStartFrame([]))
  let off = 0
  const timer = setInterval(() => {
    const last = off + PCM_CHUNK_BYTES >= pcm.length
    seq += 1
    ws.send(buildAudioFrame(pcm.subarray(off, off + PCM_CHUNK_BYTES), seq, last))
    off += PCM_CHUNK_BYTES
    if (last) { clearInterval(timer); console.log('[推完]') }
  }, 200)
})
ws.on('message', (data: Buffer) => {
  const f = parseFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
  console.log('[msg] type=0x' + f.messageType.toString(16), 'flags=0x' + f.flags.toString(16), 'code=', f.code, 'text=', JSON.stringify(transcriptOf(f)), f.messageType === MSG_SERVER_ERROR ? errorMessageOf(f) : '', JSON.stringify(f.json)?.slice(0, 300))
})
ws.on('error', (e) => console.log('[ws error]', e.message))
ws.on('close', (c, r) => { console.log('[close]', c, String(r)); process.exit(0) })
setTimeout(() => { console.log('超时'); process.exit(1) }, 40000)
