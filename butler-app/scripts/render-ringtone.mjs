#!/usr/bin/env node
// 座机铃声(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」)。
//
// **来源:这一段是本脚本用 ffmpeg 现合成的正弦波,不是任何现成录音。**
// 没有版权问题可讲 —— 它压根不是谁的作品,是两个正弦频率按一个节奏开关。
// 用的是北美 Precise Ring Tone 那一组参数(**参数是公开的技术规格,不是录音**):
//   440 Hz + 480 Hz 同时响,响 2 秒、歇 4 秒,如此一个周期 6 秒。
// 之所以选它而不是随便一个「叮咚」:人耳对这一组的反应就是「电话在响」——
// 这台机器要当座机用,响起来就该像座机,而不像一条微信消息。
//
// 重跑(改了频率 / 节奏 / 响度才需要):
//   cd butler-app && node scripts/render-ringtone.mjs
// 会覆盖写:
//   public/ring/ringtone.m4a   一个完整周期(2 秒响 + 4 秒静),界面上 loop 播放
//   public/ring/manifest.json  多大、多长、哪天生成的、什么参数(给人看与给用例看)
//
// 三条纪律(照抄 render-filler-audio.mjs):
//   1. **格式是 m4a(AAC-LC)**。android/variables.gradle 里 minSdkVersion = 24,
//      而 Opus-in-Ogg 要 API 29 才保证解得了;m4a/AAC 从 Android 3.1 起一路都在。
//   2. **合不出来就停**,不写一个半截的包 —— 宁可仓库里还是上一版。
//   3. **不连网、不要凭据**。这一段和火山没有任何关系,它不经过 8792。

import { execFile } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')

/** 两个频率同时响 = 那种「电话铃」的音色。单独一个正弦听起来像闹钟。 */
const TONE_HZ = [440, 480]
/** 响多久、歇多久(秒)。一个周期 6 秒,`<audio loop>` 接着放就是连续的铃声。 */
const ON_SECONDS = 2
const OFF_SECONDS = 4
/**
 * 响度。−6dBFS:两个正弦叠起来已经很扎耳朵,再大就会削顶(而削顶的正弦听起来是「刺啦」)。
 * 真正的音量由系统媒体音量决定 —— 和缓冲语同一条规矩(交接-0920 第九条)。
 */
const GAIN_DB = -6
const AAC_BITRATE = '64k'
const SAMPLE_RATE = 24000

const outDir = resolve(app, 'public/ring')
const outFile = join(outDir, 'ringtone.m4a')

async function main() {
  mkdirSync(outDir, { recursive: true })
  const tones = TONE_HZ.map(hz => `sine=frequency=${hz}:duration=${ON_SECONDS}:sample_rate=${SAMPLE_RATE}`)
  // amix 把两个正弦叠起来;apad 在后面补一段静音凑够一个周期;volume 压到 −6dB。
  const filter = [
    ...tones.map((tone, i) => `${tone}[t${i}]`),
    `[t0][t1]amix=inputs=2:duration=longest[mixed]`,
    `[mixed]volume=${GAIN_DB}dB,apad=pad_dur=${OFF_SECONDS}[out]`,
  ].join(';')
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-filter_complex', filter,
    '-map', '[out]',
    '-t', String(ON_SECONDS + OFF_SECONDS),
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-c:a', 'aac', '-b:a', AAC_BITRATE,
    outFile,
  ])
  const { size } = statSync(outFile)
  if (size < 1024) throw new Error(`合出来的铃声只有 ${size} 字节,不对劲 —— 不写这一版`)
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({
    file: 'ringtone.m4a',
    bytes: size,
    seconds: ON_SECONDS + OFF_SECONDS,
    来源: '本脚本用 ffmpeg 现合成的正弦波,不是任何现成录音;参数照北美 Precise Ring Tone 的公开技术规格',
    参数: { tone_hz: TONE_HZ, on_seconds: ON_SECONDS, off_seconds: OFF_SECONDS, gain_db: GAIN_DB, bitrate: AAC_BITRATE, sample_rate: SAMPLE_RATE },
    生成于: new Date().toISOString().slice(0, 10),
    脚本: 'scripts/render-ringtone.mjs',
  }, null, 2)}\n`, 'utf8')
  console.log(`[铃声] 写好了:${outFile}(${size} 字节,一个周期 ${ON_SECONDS + OFF_SECONDS} 秒)`)
}

main().catch((error) => {
  console.error(`[铃声] 没合出来:${error?.message ?? error}`)
  process.exit(1)
})
