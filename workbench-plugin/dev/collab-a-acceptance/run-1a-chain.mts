/**
 * 1a 真实链路验收(2026-10-24 补轮,卡 t-1fc4c898 原范围):
 *   电脑输入框(/butler/item 兼容层)一句排三件(只记不派)→ 指定 Kimi 名片派一件(真开工回执:
 *   done + reply + 真 session_id)→ 产品可查询跟进(/butler/say 问 + /state)→ 原事项续说(同事项
 *   continue 到真 Kimi 会话,复述取证)。另跑:失败/重复/未知对象/删卡/同家多卡/重启过旧 如实探针。
 *
 * 前置:隔离实例已在跑(serve.mts SAY_REAL=1,3193/8993/19893)。证据 ./run-1a-chain-<ts>/evidence-chain.json。
 * 跑:`node dev/collab-a-acceptance/run-1a-chain.mts`(另开窗口;实例退出码与清理归 serve/run 管)。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const out = join(HERE, `run-1a-chain-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const base = 'http://127.0.0.1:8993'
const origin = 'http://127.0.0.1:3193'
const records: Record<string, unknown>[] = []
const persist = () => writeFileSync(join(out, 'evidence-chain.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
function record(name: string, data: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function api(path: string, body?: unknown, method?: string): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function main(): Promise<void> {
  // 0 环境与项目(真 Kimi 派活要项目目录,扫前已修过)
  const caps = await api('/agents/caps')
  record('caps', { body: JSON.stringify(caps.body).slice(0, 900) })
  const state0 = await api('/state')
  const projects = (state0.body.projects as { projects?: { id?: string, name?: string, path?: string }[] } | undefined)?.projects ?? []
  const withPath = projects.find(p => typeof p.path === 'string' && p.path !== '')
  record('project-picked', { project: withPath ?? null, all: projects.map(p => [p.id, p.name]) })
  // 精确名片:本卡自建一张受控 Kimi 名片(既有 /collab/agent/save 路,非个人账号设备),
  // 写明 runtime/项目/智能体文件/时长上限——host 按这张卡解析配置/权限/技能。
  const qaRepo = withPath?.path ?? ''
  const saved = await api('/collab/agent/save', {
    name: 'QA 1a 链路 Kimi',
    hand: 'kimi',
    runtime: { family: 'kimi' },
    ...(qaRepo === '' ? {} : { project: { repo: qaRepo } }),
    instructions: 'docs/卡/agents/kimi-coder.md',
    budget: { minutes: 5 },
  })
  const cardId = saved.body.id as string | undefined
  record('kimi-card-created', { ok: saved.body.ok === true && typeof cardId === 'string', id: cardId ?? null, status: saved.status, error: saved.body.error ?? null })
  const cardsNow = ((await api('/state')).body.tasks as { agent_cards?: { id: string, name: string, runtime?: { family?: string } }[] } | undefined)?.agent_cards ?? []
  const kimiCard = cardsNow.find(c => c.id === cardId)
  record('kimi-card', { card: kimiCard ?? null, cards: cardsNow.map(c => [c.id, c.name, c.runtime?.family]) })

  // 1 电脑输入框一句排三件(记,不派):兼容层 → 三张卡、无会话、回话一句(兼容回包是旧形状,没有 items 格——按 /state 的差集核)
  const stateBefore1 = await api('/state')
  const said3 = await api('/butler/item', { text: '记三条:周四发样片、周五交发票、下周一约 B 客户', orientation: 'portrait', can_meeting_plan: true })
  const stateAfter1 = await api('/state')
  const had1 = new Set(((stateBefore1.body.tasks as { tasks?: { id?: string }[] } | undefined)?.tasks ?? []).map(one => one.id))
  // serve.mts 启动会种浏览器种子卡;实例复用时同题卡可能已在板上——按标题计数(前后差=3),
  // 再对「本句新建的(id 不在前态)」核无会话无派活。
  const WANT1 = ['周四发样片', '周五交发票', '下周一约 B 客户']
  const match1 = (state: Record<string, unknown>) => (((state.tasks as { tasks?: { id?: string, title?: string, status?: string, conversation?: unknown, dispatch?: unknown }[] } | undefined)?.tasks ?? [])
    .filter(one => WANT1.includes(one.title ?? '')))
  const before1n = match1(stateBefore1.body).length
  const after1 = match1(stateAfter1.body)
  const newCards1 = after1.filter(one => one.id !== undefined && !had1.has(one.id))
  record('chain-1-three-notes', {
    passed: after1.length - before1n === 3 && newCards1.every(one => one.conversation === undefined && one.dispatch === undefined),
    note: said3.body.note,
    cards: newCards1.map(one => [one.title, one.status]),
    before: before1n, after: after1.length,
  })

  // 2 指定 Kimi 名片派一件(办,who=名片 id 或家名)→ 真开工回执
  const task = await api('/task/create', { title: 'QA 1a 链路面活', ...(withPath?.id === undefined ? {} : { project_id: withPath.id }) })
  const itemId = String(task.body.id)
  const who = typeof cardId === 'string' ? cardId : 'kimi'
  const said = await api('/butler/say', { text: `在 collab-a-qa 项目里,派给 ${who} 做 QA 1a 链路面活:只回复 QA_1A_CHAIN_OK 后结束;不要改任何文件,不要读写任何仓库、统筹状态或报告。` })
  let saidItems = (said.body.items ?? []) as { kind: string, status: string, card_id?: string, who?: string, detail?: string }[]
  record('chain-2-say-dispatch', { passed: saidItems.some(one => one.kind === '办'), items: saidItems.map(one => [one.kind, one.status, one.who, one.detail ?? '']) })
  // 硬护栏问了一句(模型把「回复」误判成外发)→ 她点头(真实用户会做同一件事),解冻再办。
  const askedItem = saidItems.find(one => one.status === 'asked')
  const askId = (said.body.ask as { ask_id?: string } | undefined)?.ask_id ?? (said.body.hold as { hold_id?: string } | undefined)?.hold_id
  if (askedItem !== undefined && typeof askId === 'string') {
    const ok = await api('/butler/say', { text: '好', ctx: { confirmed: { ask_id: askId, choice: 'yes' } } })
    saidItems = (ok.body.items ?? []) as typeof saidItems
    record('chain-2-confirmed-thaw', { passed: saidItems.some(one => one.kind === '办' && one.status === 'done'), items: saidItems.map(one => [one.kind, one.status, one.who, one.detail ?? '']) })
  }
  const dispatchItem = saidItems.find(one => one.kind === '办')
  const dispatchCardId = dispatchItem?.card_id
  // 真开工回执:真派出去了才等 done(真 Kimi CLI);没派成照实记原因,不空等。
  const t0 = Date.now()
  if (dispatchItem !== undefined && dispatchItem.status !== 'done') {
    record('chain-2-dispatch-receipt', { passed: false, skipped: '这一件没派出去', detail: dispatchItem.detail ?? '' })
    record('chain-end', { checksFailed: records.filter(r => r.passed === false).map(r => r.name), limitation: '派活未达,回执/查询/续说不再有意义' })
    console.log('EVIDENCE_DIR', out)
    return
  }
  let dispatch: Record<string, unknown> | undefined
  while (Date.now() - t0 < 300_000) {
    const s = await api('/state')
    const card = (s.body.tasks as { tasks?: { id?: string, dispatch?: Record<string, unknown> }[] } | undefined)?.tasks?.find(one => one.id === dispatchCardId)
    if (card?.dispatch !== undefined && ['done', 'failed', 'stopped'].includes(String(card.dispatch.status))) { dispatch = card.dispatch; break }
    await sleep(3000)
  }
  const cardAssignee = (await api('/state')).body.tasks as { tasks?: { id?: string, assignee?: string }[] } | undefined
  const dispatchedCard = cardAssignee?.tasks?.find(one => one.id === dispatchCardId)
  record('chain-2-card-assignee', { passed: typeof cardId !== 'string' || dispatchedCard?.assignee === cardId, assignee: dispatchedCard?.assignee ?? null, cardId: cardId ?? null })
  record('chain-2-dispatch-receipt', { passed: dispatch?.status === 'done', dispatch: dispatch ?? null, elapsedSec: Math.round((Date.now() - t0) / 1000) })

  // 3 产品可查询跟进:问一句(问档)→ 板上真状态答得出来
  const asked = await api('/butler/say', { text: 'QA 1a 链路面活到哪了' })
  record('chain-3-progress-ask', { passed: (asked.body.items as { kind?: string }[] | undefined)?.some(one => one.kind === '问'), say: asked.body.say })

  // 4 原事项续说:同事项 continue → 真 Kimi 原会话,复述取证
  if (dispatch?.session_id !== undefined && typeof dispatch.cwd === 'string') {
    const view = await api(`/butler/item/${dispatchCardId}/continue`)
    const sources = (view.body.sources as { key?: string, action?: { kind?: string } }[] | undefined) ?? []
    const target = sources.find(s => s.key === `kimi:${String(dispatch.session_id)}`)
    record('chain-4-source-view', { passed: target?.action?.kind === 'relay', sources: sources.map(s => [s.key, s.action?.kind]) })
    const cont = await api('/butler/item/continue', { id: dispatchCardId, text: '补一句:请只回复 QA_1A_CHAIN_CONT 后结束;不要改任何文件。', target: `kimi:${String(dispatch.session_id)}` })
    record('chain-4-continue-sent', { passed: cont.body.ok === true && cont.body.fact === 'sent', fact: cont.body.fact, note: cont.body.note })
    const probe = await new Promise<string>((resolve) => {
      // 动态 import 免得顶层依赖 node 类型在这儿打架
      import('node:child_process').then(({ execFile }) => {
        execFile('/opt/homebrew/bin/kimi', ['--session', String(dispatch!.session_id), '-p', '把你收到的上一条原话一字不差复述一遍,只回复那一句。', '--output-format', 'text'],
          { cwd: dispatch!.cwd as string, env: { ...process.env, KIMI_CODE_HOME: `${process.env.HOME}/.kimi-code`, KIMI_CLI_NO_AUTO_UPDATE: '1' }, timeout: 120_000, maxBuffer: 1 << 24 },
          (_e, stdout, stderr) => { resolve(`${stdout ?? ''}${stderr ?? ''}`) })
      })
    })
    record('chain-4-continue-landed', { passed: probe.includes('QA_1A_CHAIN_CONT'), echo: probe.slice(-160) })
  }

  // 5 如实探针:未知对象/删卡/同家多卡/重复
  const unknownWho = await api('/butler/say', { text: '派给 nope-xyz 把这件事做一下' })
  record('probe-unknown-who', { items: (unknownWho.body.items as { status?: string, detail?: string }[] | undefined)?.map(one => [one.status, one.detail]) })
  const made = await api('/task/create', { title: 'QA 1a 待删卡' })
  const madeId = String(made.body.id)
  await api('/task/delete', { id: madeId })
  const askDeleted = await api('/butler/say', { text: 'QA 1a 待删卡到哪了' })
  record('probe-deleted-card', { items: (askDeleted.body.items as { kind?: string, status?: string }[] | undefined)?.map(one => [one.kind, one.status]) })
  const replay1 = await api('/butler/say', { text: '记一下 QA 链路面活重放句', client_key: 'qa-chain-replay-1' })
  const replay2 = await api('/butler/say', { text: '记一下 QA 链路面活重放句', client_key: 'qa-chain-replay-1' })
  record('probe-say-replay', { passed: replay2.body.say_id === replay1.body.say_id, sameSayId: replay2.body.say_id === replay1.body.say_id })

  record('chain-end', { checksFailed: records.filter(r => r.passed === false).map(r => r.name), limitation: '真 Kimi=听懂桥+派活;真手机/真云模型未验' })
  console.log('EVIDENCE_DIR', out)
}

main().catch((e) => { record('run-error', { error: String((e as Error).message ?? e) }); process.exitCode = 1 })
