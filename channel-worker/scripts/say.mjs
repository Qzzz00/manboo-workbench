#!/usr/bin/env node
/**
 * 「当成他说的话」跑一回合(2026-09-27,卡 TT)。给**统筹本机**用,不是给用户用的。
 *
 *   node scripts/say.mjs "给 minus 发个信息问国庆放几天"
 *   node scripts/say.mjs --file 今晚那几句.txt        # 一行一句,顺着跑完一整通
 *   node scripts/say.mjs --hangup                    # 收尾(走真挂断那条路)
 *
 * 前提:工人那边开着测试口(`WORKBENCH_CHANNEL_TEXT_TURN=1`,默认关)。
 * 口令从口令文件里读(默认 `$TMPDIR/workbench-channel-text-turn.token`,600),
 * **不打印口令**,也不接受从命令行传口令 —— 传上去就会留在 shell 历史里。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.WORKBENCH_CHANNEL_TEXT_TURN_PORT?.trim() || '8797'
const TOKEN_FILE = process.env.WORKBENCH_CHANNEL_TEXT_TURN_TOKEN_FILE?.trim()
  || join(tmpdir(), 'workbench-channel-text-turn.token')

function usage() {
  console.log('用法:node scripts/say.mjs "一句话"  |  --file 一行一句.txt  |  --hangup')
}

function token() {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim() }
  catch {
    console.error(`读不到口令文件 ${TOKEN_FILE} —— 工人那边开着测试口吗(WORKBENCH_CHANNEL_TEXT_TURN=1)?`)
    process.exit(2)
  }
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-text-turn': token() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { error: text } }
  return { status: res.status, body: parsed }
}

/** 一回合的结果打成人看的几行。**原样打**,不加工、不补一个数。 */
function printTurn(said, result) {
  console.log(`\n他说:${said}`)
  if (result.status !== 200) {
    console.log(`没跑成(HTTP ${result.status}):${result.body?.error ?? '没说原因'}`)
    return false
  }
  const { said: lines = [], tools = [], ms, latency, timedOut } = result.body
  if (lines.length === 0) console.log('她说:(一个字都没有)')
  else lines.forEach((line, i) => console.log(`她说${lines.length > 1 ? `(第 ${i + 1} 段)` : ''}:${line}`))
  if (tools.length === 0) console.log('工具:一件都没调')
  else for (const tool of tools) console.log(`工具:${tool.name}${tool.result === undefined ? '(没有输出)' : ` → ${tool.result}`}`)
  console.log(`这一回合:${ms}ms${timedOut === true ? '(等到超时才收,上面这些是收到的那部分)' : ''}`)
  if (latency !== undefined) {
    console.log(`回合计时:提交→首字 ${latency.llm_first_ms ?? '没量到'}ms,首句合成 ${latency.tts_first_ms ?? '没量到'}ms,总 ${latency.total_ms ?? '没量到'}ms`)
  }
  return true
}

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') { usage(); process.exit(0) }

if (args[0] === '--hangup') {
  const done = await post('/hangup')
  console.log(done.status === 200 && done.body?.ok === true ? '挂了(走的是真挂断那条收尾)' : `没挂成:${done.body?.error ?? `HTTP ${done.status}`}`)
  process.exit(done.status === 200 ? 0 : 1)
}

const sentences = args[0] === '--file'
  ? readFileSync(args[1], 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  : [args.join(' ')]

if (sentences.length === 0) { console.error('这份文件里一句话都没有'); process.exit(2) }

let allOk = true
for (const sentence of sentences) {
  const result = await post('/say', { text: sentence })
  if (!printTurn(sentence, result)) allOk = false
}
console.log(`\n跑完 ${sentences.length} 句${allOk ? '' :'(有没跑成的,见上面)'}。挂断:node scripts/say.mjs --hangup`)
process.exit(allOk ? 0 : 1)
