/**
 * 1a 验收驱动(2026-10-24,卡 t-1fc4c898):对隔离真实例(serve.mts,8993)跑三入口句子的桌面列
 * (POST /butler/say),断言 items/title 清洗/risk/say 回话;再跑一件真 Kimi 派活(办→真开工回执)。
 * 证据:./run-1a-<ts>/evidence-1a.json。用法:实例起着(node dev/collab-a-acceptance/serve.mts)时
 * `node dev/collab-a-acceptance/run-1a.mts`。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const out = join(HERE, `run-1a-${Date.now()}`)
mkdirSync(out, { recursive: true })
const base = 'http://127.0.0.1:8993'
const origin = 'http://127.0.0.1:3193'
const records: Record<string, unknown>[] = []
const persist = () => writeFileSync(join(out, 'evidence-1a.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
const record = (name: string, data: Record<string, unknown>): void => { records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data)) }

async function say(text: string) {
  const res = await fetch(`${base}/butler/say`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ text, entrance: 'desktop' }), signal: AbortSignal.timeout(60_000) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}
const itemsOf = (body: Record<string, unknown>) => body.items as { kind: string, title: string, status: string, risk?: string, detail?: string }[]

async function main(): Promise<void> {
  // s1/s2:记一件事 —— 标题清洗(壳去掉、事发给客户留着)、一张卡、不派、回话一句。
  const s1 = await say('帮我记一件事:周四下午把样片发给客户')
  const s1Items = itemsOf(s1.body)
  record('1a-s1-record', { passed: s1Items[0]?.kind === '记' && s1Items[0]?.title === '周四下午把样片发给客户' && s1Items[0]?.status === 'done', items: s1Items, say: s1.body.say })

  // s8:「发给客户」只在内容里 → 风险 none,没有 hold,不问她。
  const s8 = await say('记个待办:下周二把合同发给客户')
  const s8Items = itemsOf(s8.body)
  record('1a-s8-content-not-risk', { passed: s8.body.hold === undefined && s8Items[0]?.status === 'done' && s8Items[0]?.title === '下周二把合同发给客户', hold: s8.body.hold ?? null, items: s8Items, say: (s8.body.say as { screen: string }).screen })

  // s5:一句三件同类 → 三张卡,各自清洗,回话一句汇总。
  const s5 = await say('记三条:周四发样片、周五交发票、下周一约 B 客户')
  const s5Items = itemsOf(s5.body)
  record('1a-s5-three-notes', { passed: s5Items.length === 3 && s5Items.every(one => one.kind === '记' && one.status === 'done'), titles: s5Items.map(one => one.title), say: (s5.body.say as { screen: string }).screen })

  // s4:一句三件不同类:记 + 办(派给 Claude) + 改(换个女声→如实 failed 或 done,不许冒称)。
  const s4 = await say('帮我建一个待办:周四下午给客户发样片,再把样片派给 Claude 剪一版,然后换个女声')
  const s4Items = itemsOf(s4.body)
  record('1a-s4-mixed-three', { passed: s4Items.length === 3 && s4Items[0]?.kind === '记' && s4Items[1]?.kind === '办', items: s4Items.map(one => [one.kind, one.status, one.title, one.detail ?? '']), say: (s4.body.say as { screen: string }).screen })

  // s7:旁人插话 → 不办,问一句,一张卡都不建。
  const s7 = await say('哎你帮我把那个文件递一下')
  record('1a-s7-addressed', { passed: s7.body.addressed === false && (itemsOf(s7.body) ?? []).length === 0, say: (s7.body.say as { screen: string }).screen })

  // 真实 Kimi 派活回执(1a 的办):项目目录已在(scan 修过);派给 kimi,等 done 回执。
  const proj = (await (await fetch(`${base}/state`, { headers: { origin } })).json() as { projects?: { projects?: { id?: string, path?: string }[] } }).projects?.projects?.find(one => typeof one.path === 'string' && one.path !== '')
  const made = await (await fetch(`${base}/task/create`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ title: 'QA 1a 真实派活', project_id: proj?.id }) })).json() as { id?: string }
  const said = await say(`派给 kimi 把 QA 1a 真实派活做完后回复 QA_1A_DONE`)
  const saidItems = itemsOf(said.body)
  record('1a-say-dispatch-kimi', { passed: saidItems.some(one => one.kind === '办'), items: saidItems.map(one => [one.kind, one.status, one.detail ?? '']) })
  // 真 Kimi 开工回执:带项目的那张卡走 /dispatch/run(say 建的卡没归项目,命令行那只手如实要目录 —— 这条本身也是诚实边界)。
  await fetch(`${base}/dispatch/run`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ item_id: made.id, app: 'kimi', kind: 'code', text: '请只回复 QA_1A_DONE 后结束,不要改任何文件。' }) })
  const targetId = made.id
  if (typeof targetId === 'string') {
    const end = Date.now() + 240_000
    let dispatch: Record<string, unknown> | undefined
    while (Date.now() < end) {
      const state = await (await fetch(`${base}/state`, { headers: { origin } })).json() as { tasks?: { tasks?: { id?: string, dispatch?: Record<string, unknown> }[] } }
      const task = state.tasks?.tasks?.find(one => one.id === targetId)
      const d = task?.dispatch
      if (d !== undefined && ['done', 'failed', 'stopped'].includes(String(d.status))) { dispatch = d; break }
      await new Promise(r => setTimeout(r, 3000))
    }
    record('1a-kimi-dispatch-receipt', { passed: dispatch?.status === 'done', dispatch: dispatch ?? null })
  }
  const failed = records.filter(one => one.passed === false).map(one => one.name)
  record('run-1a-end', { checksFailed: failed, limitation: '假上游钉 say 清单行为;真实模型轮与真手机未验(见报告);电话列是 1b' })
  process.exit(failed.length === 0 ? 0 : 2)
}

main().catch((e) => { record('run-1a-error', { error: String((e as Error).message ?? e) }); process.exit(1) })
