/**
 * 爆款拆解那条**转写 → 繁简**的一次真跑(2026-09-21)。
 *
 * 真的东西:**真的 whisper.cpp**(命令与参数与 `xhsBreakdown.ts` 里那一条一模一样)、
 * 真的 ffmpeg、真的 `parseSrt` / `simplifyCues` / `renderTranscriptMd`、真的落盘。
 *
 * 打桩的只有两样,都与这张卡无关,**并且在下面的输出里逐行标明**:
 * - **下载**:不走网,直接用 `--audio` 给的本机文件(线上那一步是从笔记页的直链 GET);
 * - **模型**:不调,这一跑不产出 `拆解.md`(这张卡改的是逐字稿那一半)。
 *
 * 它也顺带把「参数能不能直接出简体」那一组对比跑一遍(`--params`),
 * 结论表在 `docs/交接-0922-转写简繁.md` 第二节。
 *
 * ```bash
 * cd workbench-plugin
 * node dev/whisper-简繁-realrun.ts --whisper <whisper-cli 的路径> --model <ggml-base.bin> --audio <一段中文音频>
 * node dev/whisper-简繁-realrun.ts ... --params    # 多跑一组提示词对比
 * ```
 *
 * `whisper-cli` 这台机器上**没有装**(打包是另一张卡的事),真跑时是从源码编了一份放在临时目录里,
 * 所以路径要自己给。一个字节都不写 `~/.dsh`。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSrt, renderTranscriptMd } from '../src/server/xhsBreakdownText.ts'
import { measureTraditional, percentOf, simplifyCues } from '../src/server/zhSimplify.ts'

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

async function run(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args])
    let err = ''
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => { code === 0 ? resolve() : reject(new Error(`${file} 回了 ${code}:${err.slice(-400)}`)) })
  })
}

const whisper = arg('whisper')
const model = arg('model')
const audio = arg('audio')
if (whisper === undefined || model === undefined || audio === undefined) {
  console.error('要三个:--whisper <whisper-cli> --model <ggml-base.bin> --audio <音频>')
  process.exit(2)
}

const dir = arg('out') ?? await mkdtemp(join(tmpdir(), 'wb-简繁-'))
const wav = join(dir, '音轨.wav')

console.log(`产物落在 ${dir}`)
console.log('【桩】下载:不走网,直接用 --audio 给的本机文件')
console.log('【桩】模型:不调,这一跑不产出 拆解.md')

// ── 转音频(与 xhsBreakdown.ts 同一条 ffmpeg)──
await run('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-i', audio, '-ar', '16000', '-ac', '1', wav])

// ── 转写(与 xhsBreakdown.ts 同一条命令,参数一个字没改)──
const srtBase = join(dir, '字幕')
const t0 = Date.now()
await run(whisper, ['-m', model, '-f', wav, '-l', 'zh', '-osrt', '-of', srtBase, '-ml', '40', '-np'])
const 墙钟 = (Date.now() - t0) / 1000

const cues = parseSrt(await readFile(`${srtBase}.srt`, 'utf8'))
const 原文 = cues.map(c => c.text).join('')
const 量 = measureTraditional(原文)
console.log(`\n转写:${cues.length} 段,墙钟 ${墙钟.toFixed(2)} 秒`)
console.log(`原始转写:${量.han} 个汉字,其中 ${量.traditional} 个是繁体 → ${percentOf(量.ratio)}`)
console.log(`  ${原文.slice(0, 60)}…`)

const 转完 = simplifyCues(cues)
console.log(`\n判定:${转完.converted ? '过线 → 转成简体' : '不到线 → 一个字都不动'}`)
if (转完.converted) {
  const 后 = 转完.cues.map(c => c.text).join('')
  console.log(`  ${后.slice(0, 60)}…`)
  console.log(`  转完再量一次:${percentOf(measureTraditional(后).ratio)}(应当是 0%)`)
}

const md = renderTranscriptMd(转完.cues, {
  at: new Date().toISOString(),
  url: '(真跑,没有真实笔记链接)',
  model: '(见 --model)',
  simplify: { converted: 转完.converted, measure: 转完.measure },
})
await writeFile(join(dir, '逐字稿.md'), md, 'utf8')
console.log(`\n逐字稿.md 落在 ${join(dir, '逐字稿.md')}`)

// ── 顺带:参数那一组对比(交接第二节那张表)──
if (process.argv.includes('--params')) {
  const 试 = [
    ['裸(现在的写法)', []],
    ['--prompt 请使用简体中文', ['--prompt', '以下是简体中文普通话的转写,请使用简体中文。']],
    ['同上 + carry', ['--prompt', '以下是简体中文普通话的转写,请使用简体中文。', '--carry-initial-prompt']],
    ['--prompt 简体中文。 + carry', ['--prompt', '简体中文。', '--carry-initial-prompt']],
    ['--prompt 请用简体中文输出。 + carry', ['--prompt', '请用简体中文输出。', '--carry-initial-prompt']],
  ] as const
  console.log('\n── 参数对比(同一段音频、同一个模型)──')
  for (const [名, 额外] of 试) {
    const 前缀 = join(dir, `参数-${名.replace(/[^\w一-鿿]+/g, '_')}`)
    await run(whisper, ['-m', model, '-f', wav, '-l', 'zh', '-osrt', '-of', 前缀, '-ml', '40', '-np', ...额外])
    const 文 = parseSrt(await readFile(`${前缀}.srt`, 'utf8')).map(c => c.text).join('')
    console.log(`${名}\n  繁体占比 ${percentOf(measureTraditional(文).ratio)} | ${文.slice(0, 48)}…`)
  }
}
