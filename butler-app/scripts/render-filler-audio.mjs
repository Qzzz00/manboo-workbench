#!/usr/bin/env node
// 缓冲语音频:用事务官**当前的音色**把那一小组固定短句**预先合成一次**,打进手机包。
//
// 为什么有这个脚本(2026-09-20,Ben:「缓冲语可以存到手机里啊,不能每次都去 TTS 合成吧」):
// 「我想想」「稍等一下」这几句是**定死的**。每一轮电话都去火山合成一遍,既花几百毫秒、
// 又占一次并发配额(09-20 那次 502 的真因就是并发撞配额),换回来的还是同样那几句话。
// 所以合成在**这里**发生一次,结果提交进仓库,运行时一个字节都不合成。
//
// 2026-09-22 起这个脚本产出的是**兜底那一份**,不再是电话里唯一会听到的那一份:
// 运行期手机会按当前音色现合成并缓存在本地(butler-app/src/call/fillerVoiceCache.ts)。
// 所以「换了音色要重跑这个脚本」这条**作废**了 —— 只有**改了句子**才要重跑它
// (兜底那七句得和 fillerLines.json 对得上)。
//
// 重跑(改了句子之后):
//   cd butler-app && node scripts/render-filler-audio.mjs
// 会覆盖写:
//   public/filler/<id>.m4a        那几句的音频(AAC-LC,单声道 24kHz;minSdk 24 上 m4a 最稳)
//   public/filler/manifest.json   谁是谁、多大、多长、哪一天用哪个音色合的(给人看与给用例看)
// 句子本身在 src/call/fillerLines.json —— **那是唯一的源**,手机端也读它。
//
// 三条纪律:
//   1. **串行**。09-20 的账:同一瞬间几条 /api/tts 会撞火山的并发配额(HTTP 429 code=3001)。
//      这里一条一条来,句与句之间还歇一下 —— 一次构建慢几秒,换不打扰任何人。
//   2. **不出口凭据**。回环调 8792 压根不用令牌(adminAuth 对回环放行);真要走非回环地址,
//      令牌从 BUTLER_TOKEN 环境变量或 ~/.dsh/workbench/butler.json 读,**不打印、不写进 manifest**。
//   3. **合不出来就停**,不写一个半截的包。宁可仓库里还是上一版音频,也不能有一句是哑的。
//
// 参数(都能用环境变量给):
//   --url        8792 的地址(缺省 http://127.0.0.1:8792,也可用 BUTLER_URL)
//   --scene      TTS 场景(缺省照 fillerLines.json 里的 scene,今天是 chat —— 和工人一样)
//   --voice      指定音色 id。**平时不要给**:8792 自己会解析「形象在该场景绑定的音色」,
//                那才保证「电话里听到的」和「Mac 上试听的」是同一个嗓子。
//   --out        输出目录(缺省 public/filler)
//   --keep-mp3   把 8792 原样给的 mp3 也留一份(排查音质时用),不提交
//   --dry-run    只打印要合哪几句,不发请求
//   --only       只合某几类(逗号分隔的 kind,例如 `--only ack`)。2026-10-02 加的:
//                应声那几声(`ack`)是新加的,把老那七句一起重合会把**兜底那一份**换成另一个嗓子
//                —— 兜底存在的理由就是「第一次进房 / 离线时有东西可放」,没必要跟着动。
//                带 `--only` 时:只合这几类、**manifest 按表的顺序与原有条目合并**、
//                只清掉表外的多余音频(表内别的类照样留着)。

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')

/** 一句和下一句之间歇多久。见上面第 1 条 —— 这不是保险,是不去挤别人的门。 */
const GAP_MS = 250

/**
 * 转码参数。**AAC-LC in m4a**,不是 opus/ogg:android/variables.gradle 里 minSdkVersion = 24,
 * 而 Opus-in-Ogg 要 Android 10(API 29)才保证能解。m4a/AAC 从 Android 3.1 起一路都在。
 * 48kbps 单声道 24kHz:一句一秒多 ≈ 8KB,七句加起来几十 KB。
 */
const AAC_BITRATE = '48k'
const SAMPLE_RATE = 24000

/**
 * 掐掉头尾的静音。火山给回来的 mp3 前面常有一小段空白 —— 那一小段会**原样变成延迟**,
 * 而这几句话存在的理由就是快。阈值 -45dB、留 20ms:再狠就会啃掉第一个字的辅音。
 */
const SILENCE_FILTER = [
  'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-45dB:detection=peak',
  'areverse',
  'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB:detection=peak',
  'areverse',
].join(',')

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  if (at >= 0 && process.argv[at + 1] !== undefined && !process.argv[at + 1].startsWith('--')) return process.argv[at + 1]
  return fallback
}
const flag = name => process.argv.includes(`--${name}`)

/** 只在**非回环**地址时才去找令牌。回环由 adminAuth 放行,根本不用读他的文件。 */
function tokenFor(url) {
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url)) return undefined
  const fromEnv = process.env.BUTLER_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.dsh/workbench/butler.json'), 'utf8'))
    const token = raw?.token
    return typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined
  } catch { return undefined }
}

async function ffmpegVersion() {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'])
    return (stdout.split('\n')[0] ?? '').trim()
  } catch {
    throw new Error(
      'ffmpeg 没找到。这个脚本要拿它把 8792 给的 mp3 转成 m4a 并掐掉头尾静音。\n'
      + '  macOS:brew install ffmpeg',
    )
  }
}

/** 一句 → mp3 字节。失败就抛,**带上 8792 的原话**(它从 09-20 起会在 detail 里给上游原因)。 */
async function synth({ url, token, text, scene, voice }) {
  const res = await fetch(`${url}/api/tts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { 'x-workbench-token': token }),
    },
    body: JSON.stringify({ text, scene, encoding: 'mp3', ...(voice === undefined ? {} : { voiceId: voice }) }),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = [body?.error, body?.detail].filter(x => typeof x === 'string' && x !== '').join(';')
    } catch { /* 读不懂就只报状态码,不编一个原因 */ }
    throw new Error(`8792 /api/tts 回了 ${res.status}${detail === '' ? '' : `:${detail}`}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) throw new Error('8792 /api/tts 回了 200 但一个字节都没有')
  return buffer
}

async function durationOf(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
  ])
  const seconds = Number.parseFloat(stdout.trim())
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined
}

// ── 跑 ─────────────────────────────────────────────────────────────────────
const url = (arg('url', process.env.BUTLER_URL ?? 'http://127.0.0.1:8792')).replace(/\/+$/, '')
const outDir = resolve(app, arg('out', 'public/filler'))
const source = resolve(app, 'src/call/fillerLines.json')
const table = JSON.parse(readFileSync(source, 'utf8'))
const scene = arg('scene', table.scene ?? 'chat')
const voice = arg('voice', undefined)
const allLines = Array.isArray(table.lines) ? table.lines : []
/** `--only ack,tool` → 只合这几类。不给就全合(与 09-20 逐字同行为)。 */
const onlyKinds = (arg('only', '') || '').split(',').map(one => one.trim()).filter(one => one !== '')
const lines = onlyKinds.length === 0 ? allLines : allLines.filter(line => onlyKinds.includes(line.kind))

if (allLines.length === 0) {
  console.error(`${source} 里一句话都没有,不知道要合什么。`)
  process.exit(1)
}
if (lines.length === 0) {
  console.error(`${source} 里没有 ${onlyKinds.join(' / ')} 这几类,一句都合不了。`)
  process.exit(1)
}

console.log(`缓冲语:${lines.length} 句${onlyKinds.length === 0 ? '' : `(只合 ${onlyKinds.join(' / ')};表里一共 ${allLines.length} 句)`},场景 ${scene}${voice === undefined ? '(音色由 8792 按形象绑定解析)' : `,音色 ${voice}`}`)
for (const line of lines) console.log(`  ${line.id.padEnd(20)} ${line.text}`)
if (flag('dry-run')) process.exit(0)

const ffmpeg = await ffmpegVersion()
const token = tokenFor(url)
console.log(`8792:${url}${token === undefined ? '(回环,不带令牌)' : '(带令牌)'}`)
console.log(ffmpeg)

mkdirSync(outDir, { recursive: true })
const tmp = resolve(app, 'node_modules/.tmp/filler-mp3')
mkdirSync(tmp, { recursive: true })

const entries = []
let index = 0
for (const line of lines) {
  index += 1
  if (index > 1) await new Promise(done => setTimeout(done, GAP_MS))
  let mp3
  try { mp3 = await synth({ url, token, text: line.text, scene, voice }) }
  catch (error) {
    // **合不出来就停**:半个包比没有包糟 —— 电话里一句有声一句没声,人只会以为她坏了。
    console.error(`\n「${line.text}」没合出来:${error.message}`)
    console.error('一个字节都没写。8792 好了再跑一遍;仓库里还是上一版音频,那是完整的。')
    process.exit(1)
  }
  const mp3Path = join(tmp, `${line.id}.mp3`)
  writeFileSync(mp3Path, mp3)
  const m4aPath = join(outDir, `${line.id}.m4a`)
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', mp3Path,
    '-af', SILENCE_FILTER,
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-c:a', 'aac', '-b:a', AAC_BITRATE,
    '-movflags', '+faststart',
    m4aPath,
  ])
  const rawMs = await durationOf(mp3Path)
  const ms = await durationOf(m4aPath)
  const bytes = readFileSync(m4aPath).length
  entries.push({
    id: line.id,
    kind: line.kind,
    ...(line.tool === undefined ? {} : { tool: line.tool }),
    text: line.text,
    file: `${line.id}.m4a`,
    bytes,
    ms,
    trimmed_ms: rawMs === undefined || ms === undefined ? undefined : rawMs - ms,
  })
  console.log(`  ✓ ${line.id.padEnd(20)} ${(bytes / 1024).toFixed(1)} KB  ${ms} ms(mp3 ${(mp3.length / 1024).toFixed(1)} KB / ${rawMs} ms,掐掉 ${rawMs - ms} ms 静音)`)
  if (!flag('keep-mp3')) rmSync(mp3Path, { force: true })
}

// 表里没有的旧音频要清掉:留着的话包里会多出一句谁也不会放的话。
// 认的是**整张表**,不是这一趟合的那几句 —— 不然 `--only ack` 会把别的类全删掉。
const wanted = new Set(allLines.map(line => `${line.id}.m4a`))
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.m4a')) continue
  if (wanted.has(name)) continue
  rmSync(join(outDir, name), { force: true })
  console.log(`  - 清掉不在表里的 ${name}`)
}

/**
 * manifest 的条目:**按表的顺序**排(用例按这个顺序比),这一趟合过的用新的,
 * 没合的沿用上一份里那一条。`--only` 那一趟缺哪条就缺哪条(如实,不编一个)。
 */
let previous = []
try { previous = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).lines ?? [] }
catch { /* 第一次跑、或者上一份坏了:就只有这一趟合的那几条 */ }
const fresh = new Map(entries.map(entry => [entry.id, entry]))
const old = new Map(previous.map(entry => [entry.id, entry]))
const merged = allLines
  .map(line => fresh.get(line.id) ?? old.get(line.id))
  .filter(entry => entry !== undefined)

const total = merged.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({
  note: '由 butler-app/scripts/render-filler-audio.mjs 生成,**别手改**。换了音色就重跑一遍那个脚本。',
  version: table.version ?? 1,
  scene,
  ...(voice === undefined ? {} : { voice }),
  generated_at: new Date().toISOString(),
  ...(onlyKinds.length === 0 ? {} : { only: onlyKinds }),
  total_bytes: total,
  lines: merged,
}, null, 2)}\n`)

console.log(`\n这一趟合了 ${entries.length} 句;包里一共 ${merged.length} 句、${(total / 1024).toFixed(1)} KB → ${outDir.replace(`${resolve(app, '..')}/`, '')}`)
console.log('记得把 public/filler/ 里生成的东西一起提交。')
