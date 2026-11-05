/** 1a /butler/say 专项同源能力真实隔离探针(2026-10-24):feedback/会/发布计划/今日视图四句话打真实例,核信封。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const out = join(HERE, `run-1a-special-probe-${Date.now()}`)
mkdirSync(out, { recursive: true })
const base = 'http://127.0.0.1:8993'
const origin = 'http://127.0.0.1:3193'
const records: Record<string, unknown>[] = []
const persist = () => writeFileSync(join(out, 'evidence-special.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
function record(name: string, data: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data))
}
async function say(text: string) {
  const res = await fetch(`${base}/butler/say`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ text, entrance: 'phone' }), signal: AbortSignal.timeout(90_000) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}
const state = async () => (await (await fetch(`${base}/state`, { headers: { origin } })).json()) as { tasks?: { tasks?: { id: string }[] } }
const t0 = (await state()).tasks?.tasks?.length ?? 0

const fb = await say('发布计划那里没有标记今天是哪一天,这个不方便')
record('special-feedback', { passed: fb.status === 200 && fb.body.feedback !== undefined && fb.body.say !== undefined, status: fb.status, keys: Object.keys(fb.body) })

const mt = await say('下午三点跟 B 客户谈下季度合作')
record('special-meeting', { passed: mt.status === 200 && mt.body.meeting_plan !== undefined && mt.body.say !== undefined, status: mt.status, keys: Object.keys(mt.body) })

const pp = await say('计划 18 号发一个关于秋季穿搭的视频')
record('special-publish', { passed: pp.status === 200 && pp.body.publish_plan !== undefined && pp.body.say !== undefined, status: pp.status, keys: Object.keys(pp.body) })

const tv = await say('把待办改成按日期汇总')
record('special-today-view', { passed: tv.status === 200 && tv.body.today_view !== undefined && tv.body.say !== undefined, status: tv.status, keys: Object.keys(tv.body) })

// 说不清的发布计划:400 + 问句,一张卡不建。
const vague = await say('计划发一个视频')
record('special-publish-vague', { passed: vague.status === 400 && typeof vague.body.error === 'string', status: vague.status })

// file_ask:配一台假手机,带设备令牌问文件 → 回包带 file_ask 与 say。
const pairStart = await (await fetch(`${base}/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })).json() as { pairing?: { code?: string } }
const code = pairStart.pairing?.code
let fileAskPassed = false
if (typeof code === 'string') {
  const claimed = await (await fetch(`${base}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code, device_name: 'QA 读回假手机', platform: 'android' }) })).json() as { token?: string }
  if (typeof claimed.token === 'string') {
    const fa = await fetch(`${base}/butler/say`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${claimed.token}`, origin }, body: JSON.stringify({ text: '把 README 发到我手机上', entrance: 'phone_text' }), signal: AbortSignal.timeout(60_000) })
    const faBody = await fa.json().catch(() => ({})) as Record<string, unknown>
    fileAskPassed = fa.status === 200 && faBody.file_ask !== undefined && faBody.say !== undefined
    record('special-file-ask', { passed: fileAskPassed, status: fa.status, keys: Object.keys(faBody) })
  }
}
if (!fileAskPassed) record('special-file-ask', { passed: false, note: '配对没成' })

const t1 = (await state()).tasks?.tasks?.length ?? 0
record('special-end', { checksFailed: records.filter(r => r.passed === false).map(r => r.name), cardsCreated: t1 - t0 })
console.log('EVIDENCE_DIR', out)
