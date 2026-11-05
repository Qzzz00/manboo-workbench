/**
 * ★ **三入口验收:一条命令**(2026-10-22,第 0 步「验收成制度」)。
 *
 * 起一台隔离实例(临时 HOME、自己的端口、假 launchctl,不碰真 `~/.dsh`、不停 8791)→ 绑一个中转测试账号 →
 * 配一台假手机 → 同一组句子(`sentences.json`)打三个入口:电脑对话框、手机文字、电话 → 判定(judge.ts)→
 * 出一张「句 × 入口」的表落到 `docs/验收-三入口同一组句子-<日期>.md`,原始观察落到同名 `.json` → 停实例、删临时目录。
 *
 *   node dev/acceptance-three-entrances/run.ts [选项]
 *
 *   --only desk,phone,call     只跑这几个入口(缺省三个都跑)
 *   --sentences s1,s4          只跑这几句(缺省全部)
 *   --call audio|text|both     电话那一列怎么打:audio = 假手机进房说 TTS 的话(缺省);text = 工人的文字回合测试口;
 *                              both = 两样都打,表里多一列「电话·文字口」(分得清是听错了还是办错了)
 *   --noisy                    电话那一列的音频底下垫一层噪声(「嘈杂」那一遍)
 *   --keep                     跑完不停实例、不删临时目录(看现场用)
 *   --root <目录>              临时目录放哪(缺省系统临时目录下新建)
 *   --out <文件>               报告写到哪(缺省 docs/验收-三入口同一组句子-<日期>.md)
 *   --no-build                 不重打插件,用 workbench-plugin/lib 现有的产物
 *   --attach <目录>            接上 --keep 留下的那台实例(不重起;调脚本用,不当正式结果)
 *   --rejudge <json>           不跑,拿上一次落下的原始观察按现在的判法重出报告(判法改了用;报告抬头写明)
 *
 * 退出码:0 = 每一格都过(n/a 不算);1 = 有不过的;2 = 跑不起来。详见同目录 README。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  type Column, type Entrance, type Observation, type RunResult, type Sentence, type TurnFact,
  ENTRANCES, entranceOf, judge, loadSentences, renderReport,
} from './judge.ts'
import {
  cardFactOf, cleanup, diffState, hangupTextTurn, loadPhoneModel, phoneBubble,
  sayAtDesk, sayOnPhone, sayToTextTurn, settle, settleSessions,
} from './entrances.ts'
import { type FakeCall, noisyWav, spliceWav, startFakeCall, synthWav } from './fakePhone.ts'
import { type Instance, attachInstance, startInstance } from './instance.ts'
import { installTsResolve } from './tsResolve.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const only = (arg('only')?.split(',') ?? [...ENTRANCES]) as Entrance[]
const pick = arg('sentences')?.split(',')
const callMode = (arg('call') ?? 'audio') as 'audio' | 'text' | 'both'
const noisy = flag('noisy')
const keep = flag('keep')
const attach = arg('attach')

/**
 * 重判:原始观察(上一次的 `.json`)不动,只按现在的 judge.ts 重出那张表。报告抬头照旧(从 json 里的 meta,
 * 老的 json 没有就从同名 .md 的抬头读),再加一行「哪一版判法重判的」。
 */
const rejudge = arg('rejudge')
if (rejudge !== undefined) {
  const raw = JSON.parse(readFileSync(rejudge, 'utf8')) as { meta?: string[], results: (Observation & { column?: Column })[] }
  const all = loadSentences()
  const md = arg('out') ?? rejudge.replace(/\.json$/, '.md')
  const headLines = (): string[] => {
    const lines = existsSync(md) ? readFileSync(md, 'utf8').split('\n') : []
    const table = lines.findIndex(l => l.startsWith('|'))
    return lines.slice(1, table < 0 ? lines.length : table).filter(l => l.startsWith('- ')).map(l => l.slice(2))
  }
  const meta = (raw.meta ?? headLines()).filter(l => !l.startsWith('判法按 '))
  const head = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const results: RunResult[] = raw.results.flatMap((o) => {
    const sentence = all.find(one => one.id === o.sentence)
    return sentence === undefined ? [] : [{ sentence, entrance: o.entrance, column: o.column ?? o.entrance, observation: o }]
  })
  const title = (existsSync(md) ? readFileSync(md, 'utf8').split('\n')[0]?.replace(/^# /, '') : undefined) ?? '验收 · 三入口同一组句子'
  writeFileSync(md, renderReport({ title, meta: [...meta, `判法按 \`${head}\` 的 judge.ts 重判(原始观察没动)`], sentences: all.filter(s => results.some(r => r.sentence.id === s.id)), results }))
  console.log(`重判完:${md}`)
  process.exit(0)
}
const root = attach ?? arg('root') ?? mkdtempSync(join(tmpdir(), 'wb-accept-'))
mkdirSync(root, { recursive: true })
const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const out = arg('out') ?? join(REPO, 'docs', `验收-三入口同一组句子-${day}.md`)

const t0 = Date.now()
const loadAtStart = loadavg()[0]!.toFixed(1)
const log = (line: string): void => {
  const text = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`
  console.log(text)
  appendFileSync(join(root, 'run.log'), `${text}\n`)
}

// 手机的 chatModel.ts 不带后缀 import:挂一个补 `.ts` 的解析钩子(只对仓库里的相对路径生效)。
installTsResolve()

const sentences = loadSentences().filter(s => pick === undefined || pick.includes(s.id))
const results: RunResult[] = []
const notes: string[] = []

const head = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const branch = execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'workbench-plugin/src', 'channel-worker/src', 'butler-app/src'], { encoding: 'utf8' }).trim() !== ''

let instance: Instance | undefined
let exitCode = 0
try {
  instance = attach === undefined
    ? await startInstance({ root, repo: REPO, build: !flag('no-build'), textTurn: true, log })
    : attachInstance(attach, log)
  const base = instance.base
  const phoneModelNote = await loadPhoneModel(REPO)
  if (phoneModelNote !== undefined) notes.push(phoneModelNote)
  notes.push(...instance.notes)

  /** 音色(s4 要看换没换):隔离实例自己那台语音后端的「当前音色」,拿不到就缺席。 */
  const voiceNow = async (): Promise<string | undefined> => {
    if (instance?.butlerBase === undefined) return undefined
    try {
      const res = await fetch(`${instance.butlerBase}/api/voices`)
      const body = await res.json() as { current?: { id?: string, name?: string, gender?: string } | null }
      const v = body.current
      return v === null || v === undefined ? undefined : `${v.name ?? '?'}·${v.gender ?? '?'}·${v.id ?? '?'}`
    }
    catch { return undefined }
  }
  /**
   * 第 4 句之前换成一个男声,才看得出「换个女声」换没换。男声在这时现挑:实例刚起来那一刻语音钥匙还没从中转取回,
   * 音色单拿不到(10-22 基线第二遍就是这样,前后都是缺省的女声)。挑不到 / 换不成回一句原因进细节。
   */
  let maleVoice = instance.maleVoice
  const resetVoice = async (): Promise<string | undefined> => {
    if (instance?.butlerBase === undefined) return '隔离实例没有自己的语音后端,第 4 句之前没法先换成男声'
    try {
      if (maleVoice === undefined) {
        const res = await fetch(`${instance.butlerBase}/api/voices`)
        if (!res.ok) return `音色单拿不到(语音后端回 ${res.status},多半是语音钥匙还没从中转取回),第 4 句之前没先换成男声`
        const list = await res.json() as { voices?: { id?: string, gender?: string, speaks_chinese?: boolean }[] }
        maleVoice = (list.voices ?? []).find(v => v.gender === '男' && v.speaks_chinese === true)?.id
      }
      if (maleVoice === undefined) return '音色单里挑不到会说中文的男声,第 4 句之前没先换成男声'
      const res = await fetch(`${instance.butlerBase}/api/voices/current`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice_id: maleVoice }) })
      return res.ok ? undefined : `第 4 句之前换男声没成(${res.status})`
    }
    catch (err) { return `第 4 句之前换男声没成:${(err as Error).message}` }
  }

  /** 一句在一个入口上跑一遍。前后各取一份 `/state`,多出来的卡就是这一句建的;跑完删掉。 */
  const runOne = async (s: Sentence, entrance: Entrance, speak: (text: string, i: number) => Promise<TurnFact>): Promise<Observation> => {
    const voiceSetup = s.expect.voice === undefined ? undefined : await resetVoice()
    const voiceBefore = s.expect.voice === undefined ? undefined : await voiceNow()
    const before = await settle(base, {}, 1500, 8000)
    const turns: TurnFact[] = []
    let last = before
    for (const [i, text] of s.turns.entries()) {
      const turn = await speak(text, i)
      const now = await settle(base, {}, entrance === 'call' ? 2000 : 3000, 25_000)
      const { asksAdded } = diffState(last, now)
      if (asksAdded > 0) turn.approvalsAdded = asksAdded
      turns.push(turn)
      last = now
    }
    const { state: after, waitedMs, stillRunning } = await settleSessions(base, before)
    const { newTasks } = diffState(before, after)
    const sessionNote = stillRunning > 0
      ? `这一句开出的事务官会话等了 ${Math.round(waitedMs / 1000)} 秒还有 ${stillRunning} 条在跑,之后它再建的卡没算进来`
      : waitedMs > 10_000 ? `等这一句开出的事务官会话收住用了 ${Math.round(waitedMs / 1000)} 秒,期间它建的卡算这一句的` : undefined
    const voiceAfter = s.expect.voice === undefined ? undefined : await voiceNow()
    await cleanup(base, after, newTasks.map(t => t.id))
    return {
      sentence: s.id,
      entrance,
      turns,
      newCards: newTasks.map(cardFactOf),
      ...(sessionNote === undefined && voiceSetup === undefined ? {} : { notes: [sessionNote, voiceSetup].filter((n): n is string => n !== undefined) }),
      ...(s.expect.voice === undefined ? {} : { voice: { ...(voiceBefore === undefined ? {} : { before: voiceBefore }), ...(voiceAfter === undefined ? {} : { after: voiceAfter }) } }),
    }
  }

  /** 这一趟打哪几列:三个入口照 `--only`;电话按 `--call` 打真音频、文字口或两样都打。 */
  const columns: Column[] = ENTRANCES.flatMap((e): Column[] => {
    if (!only.includes(e)) return []
    if (e !== 'call') return [e]
    return callMode === 'both' ? ['call', 'callText'] : callMode === 'text' ? ['callText'] : ['call']
  })
  for (const column of columns) {
    const entrance = entranceOf(column)
    log(`—— ${column} ——`)
    let callReady: string | undefined
    if (entrance === 'call') callReady = await instance.waitWorker(column === 'callText' ? 'text' : 'audio')
    for (const s of sentences) {
      if (!s.entrances.includes(entrance)) { results.push({ sentence: s, entrance, column, observation: { sentence: s.id, entrance, turns: [], newCards: [] } }); continue }
      log(`${s.id} · ${column}:${s.turns.join(' / ')}`)
      let observation: Observation
      try {
        if (column === 'desk') {
          observation = await runOne(s, entrance, async text => (await sayAtDesk(base, text)).turn)
        }
        else if (column === 'phone') {
          observation = await runOne(s, entrance, async (text) => {
            const sent = await sayOnPhone(base, instance!.phoneToken, text)
            const state = await settle(base, {}, 3000, 25_000)
            return { said: text, reply: phoneBubble(sent.answer, sent.ok, state), ...(sent.answer.note === undefined ? {} : { raw: sent.answer.note }), ms: sent.ms }
          })
          observation.notes = [instance.phoneNote, ...(observation.notes ?? [])]
        }
        else if (callReady !== undefined) {
          observation = { sentence: s.id, entrance, turns: [], newCards: [], skipped: callReady }
        }
        else if (column === 'callText') {
          const tt = instance.textTurn!
          observation = await runOne(s, entrance, async (text) => {
            const said = s.bystander === undefined ? text : s.bystander.asrMixed
            const got = await sayToTextTurn(tt.port, tt.token, said)
            return { said, reply: got.said.join(''), tools: got.tools, ms: got.ms, ...(got.error === undefined ? {} : { raw: `出错:${got.error}` }) }
          })
          await hangupTextTurn(tt.port, tt.token)
          observation.notes = ['文字回合测试口:字塞在识别定稿那一格,识别 / 收音那一段没走', ...(s.bystander === undefined ? [] : ['旁人插话按「识别把两段拼成一句」的样子塞进去']), ...(observation.notes ?? [])]
        }
        else {
          let call: FakeCall | undefined
          const heard: string[] = []
          try {
            call = await startFakeCall({ base, deviceToken: instance.phoneToken, log })
            observation = await runOne(s, entrance, async (text, i) => {
              let wav = await synthWav(text, join(root, `${s.id}-${i}.wav`))
              if (s.bystander !== undefined && i === 0) {
                const cut = text.indexOf(s.bystander.splitAfter) + s.bystander.splitAfter.length
                wav = await spliceWav([
                  await synthWav(text.slice(0, cut), join(root, `${s.id}-a.wav`)),
                  await synthWav(s.bystander.say, join(root, `${s.id}-by.wav`), 'Reed (Chinese (China mainland))'),
                  await synthWav(text.slice(cut), join(root, `${s.id}-b.wav`)),
                ], join(root, `${s.id}-spliced.wav`))
              }
              if (noisy) wav = await noisyWav(wav, join(root, `${s.id}-${i}-noisy.wav`))
              const mark = instance!.workerLogMark()
              const got = await call!.speak(wav)
              heard.push(`第 ${i + 1} 轮识别成「${got.heard.join('') || '(没识别出来)'}」${got.timedOut === true ? '(等到超时)' : ''}`)
              return { said: text, reply: got.said.join(''), tools: instance!.toolsSince(mark).map(name => ({ name })), ms: got.ms }
            })
          }
          finally { await call?.hangup().catch(() => undefined) }
          observation.notes = [`假手机进房说话(${noisy ? '垫了噪声' : '安静'};她的声音是 macOS 婷婷,旁人是 Reed)`, ...heard, ...(observation.notes ?? [])]
        }
      }
      catch (err) {
        observation = { sentence: s.id, entrance, turns: [], newCards: [], error: (err as Error).message }
      }
      const verdict = judge(s, observation)
      log(`  → ${verdict.status}${verdict.reasons.length > 0 ? `:${verdict.reasons.join(';')}` : ''}`)
      results.push({ sentence: s, entrance, column, observation })
    }
  }
}
catch (err) {
  log(`跑不起来:${(err as Error).stack ?? String(err)}`)
  notes.push(`跑不起来:${(err as Error).message}`)
  exitCode = 2
}
finally {
  if (instance !== undefined && !keep && attach === undefined) await instance.stop().catch(e => log(`停实例出错:${(e as Error).message}`))
}

const reportMeta = [
  `代码:\`${branch}@${head}\`${dirty ? '(工作区有没提交的改动)' : ''};跑于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })},用时 ${Math.round((Date.now() - t0) / 1000)} 秒`,
  `这台 Mac 的负载(1 分钟平均):开跑时 ${loadAtStart},跑完时 ${loadavg()[0]!.toFixed(1)}(同机还跑着别的卡;电话那一列的识别受负载影响)`,
  `电话那一列:假手机进房说 TTS 的话${noisy ? '(垫了噪声)' : '(安静)'}${callMode === 'audio' ? '' : `;「电话·文字口」那一列:工人文字回合测试口,字塞在识别定稿那一格(识别 / 收音那一段没走)`}`,
  '判法见 `workbench-plugin/dev/acceptance-three-entrances/judge.ts`,句子与期望见同目录 `sentences.json`',
  ...notes,
]
const report = renderReport({ title: `验收 · 三入口同一组句子 · ${day}`, meta: reportMeta, sentences, results })
writeFileSync(out, report)
writeFileSync(out.replace(/\.md$/, '.json'), `${JSON.stringify({ head, branch, callMode, noisy, meta: reportMeta, results: results.map(r => ({ column: r.column ?? r.entrance, ...r.observation })) }, null, 1)}\n`)
log(`报告:${out}`)
if (exitCode === 0) {
  const failed = results.some(r => ['fail', 'error', 'skipped'].includes(judge(r.sentence, r.observation).status))
  exitCode = failed ? 1 : 0
}
if (keep && instance !== undefined) log(`实例留着:${instance.base}(临时目录 ${root});停:node dev/acceptance-three-entrances/stop.ts ${root}`)
process.exit(exitCode)

