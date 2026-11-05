/**
 * ★ **1a 的@候选与 running 事实**(2026-10-24,卡 `t-1fc4c898`;持久需求 `collab-a-next-1a-butler-page-seams.md`):
 * - @候选 = 协作区同一张**名片**,稳定 card id,同家多卡**不合并**;客户端只拿显示必要字段
 *  (id/name/家/running 格),执行配置/指令/技能由 host 按 card id 解析与既有权限门核 —— 不把
 *  内部指令/仓库配置塞进候选列表。
 * - `running` 只由**真实开工/活动/终态/过旧**证据投影:不是 `status==='doing'`、不是 PID、
 *  不是任何「看着像在办」。证据只有派活账那一支(dispatch.status/started/ended)+ 会话活动;
 *  取不到 = `unknown`(AGY 等未支持来源如实列未纳管,不伪称纳管)。
 */
import type { AgentCard, TaskView } from '../protocol.ts'

/** 客户端能看到的@候选最小格(不暴露内部指令/仓库配置)。 */
export interface SayCardView {
  /** 稳定 card id(`agent:…`);点名/改派都按它。 */
  id: string
  name: string
  /** 实际干活的家(运行族),host 解析;取不到缺席。 */
  family?: string
  /** 这会儿真在办吗:只按真实证据;取不到 = unknown,不编。 */
  running: 'running' | 'unknown'
}

const RUNNING_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 一张卡「在跑」的证据:只有派活账说它在跑(没收场、没过期)才算;终态/过旧/没有账一律不跑。
 * 不用 doing、不用 PID(接缝需求原话)。「running 但已有 ended_at」是重启没收拾的僵尸态,不算。
 */
export function runningEvidenceOf(task: Pick<TaskView, 'dispatch'> | undefined, nowMs: number): 'running' | 'unknown' {
  const dispatch = task?.dispatch
  if (dispatch === undefined) return 'unknown'
  if (dispatch.status !== 'running') return 'unknown'
  if (dispatch.ended_at !== undefined && dispatch.ended_at !== '') return 'unknown'
  const started = Date.parse(dispatch.started_at)
  if (!Number.isFinite(started)) return 'unknown'
  if (nowMs - started > RUNNING_WINDOW_MS) return 'unknown'
  return 'running'
}

/** @候选清单:一张名片一格,同家多卡各自一条;running 从这张卡挂着的事里取真实证据。 */
export function sayCardsOf(cards: readonly AgentCard[], tasks: readonly TaskView[], nowMs: number): SayCardView[] {
  return cards.map(card => {
    const mine = tasks.filter(one => one.assignee === card.id)
    const running = mine.some(one => runningEvidenceOf(one, nowMs) === 'running') ? 'running' as const : 'unknown' as const
    return {
      id: card.id,
      name: card.name,
      ...(card.runtime?.family === undefined ? {} : { family: card.runtime.family }),
      running,
    }
  })
}

export type SayWhoResolution = { ok: true, family: string, cardId?: string } | { ok: false, why: string }

/**
 * 名片标题归一:id 对不上时按标题认的那一档用 —— 全半角归一(NFKC:Ｋ→K、(→()、
 * 大小写折叠、去所有空白。真机 0.4.161 红例:真实模型把名片写成标题的小写变体
 * 「小k(重生版)」而不是名片 id(2026-10-27,t-a244fee0)。
 */
export function normalizeCardName(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/**
 * 点名解析:模型/用户给的 who 可能是家名(`kimi`)或名片 id(`agent:k1`)。
 * 名片 id 必须真在板上(已删/非法/不支持的,明确拒,不静默改成未点名或同家另一张)。
 * 家名多张名片(同家多卡)不静默挑一张:恰有一张在跑选那张;多张都没跑 → 明确拒,请她指名片 id。
 */
export function resolveSayWho(who: string,
  cards: readonly (Pick<AgentCard, 'id' | 'runtime'> & { name?: string })[],
  tasks: readonly Pick<TaskView, 'assignee' | 'dispatch'>[] = [],
  nowMs: number = 0): SayWhoResolution {
  let id = who.trim()
  if (id === '') return { ok: false, why: '没说是谁' }
  // 模型/用户可能把名片写成「名字(agent:…)」——抽出 agent: 那一段再认(不静默改成未点名)。
  const embedded = /agent:[A-Za-z0-9:_-]{1,96}/u.exec(id)
  if (embedded !== null) id = embedded[0]
  const card = cards.find(one => one.id === id)
  if (card !== undefined) {
    const family = card.runtime?.family
    if (typeof family !== 'string' || family === '') return { ok: false, why: `名片「${id}」没有能干活的那一家` }
    return { ok: true, family, cardId: card.id }
  }
  // id 对不上:按**名片标题**认(大小写/空白/全半角归一)。唯一才用;多张同名如实拒,不替她挑。
  const wantedName = normalizeCardName(id)
  if (wantedName !== '') {
    const titled = cards.filter(one => typeof one.name === 'string' && normalizeCardName(one.name) === wantedName)
    if (titled.length === 1) {
      const hit = titled[0] as (typeof titled)[number] & { runtime: AgentCard['runtime'] }
      const family = hit.runtime?.family
      if (typeof family !== 'string' || family === '') return { ok: false, why: `名片「${String((hit as { name?: string }).name ?? id)}」没有能干活的那一家` }
      return { ok: true, family, cardId: hit.id }
    }
    if (titled.length > 1) return { ok: false, why: `板上有 ${titled.length} 张叫「${id}」的名片,你指一张(名片 id),我不替你挑` }
    // 前缀认名(2026-10-28 机制退修任务书):她说「小K」,板上唯一一张「小K(重生版)」就是她指的那张。
    // 只认**唯一**前缀(长的往短的认:全名是名的前缀),两张以上如实拒。
    const prefixed = cards.filter(one => typeof one.name === 'string'
      && (normalizeCardName(one.name).startsWith(wantedName) || wantedName.startsWith(normalizeCardName(one.name))))
    if (prefixed.length === 1 && prefixed[0] !== undefined) {
      const hit = prefixed[0]
      const family = hit.runtime?.family
      if (typeof family !== 'string' || family === '') return { ok: false, why: `名片「${String(hit.name ?? id)}」没有能干活的那一家` }
      return { ok: true, family, cardId: hit.id }
    }
    if (prefixed.length > 1) return { ok: false, why: `「${id}」对上了 ${prefixed.length} 张名片,你指一张(名片 id),我不替你挑` }
  }
  // 不是名片 id:按家名认。登记过这一家的名片来算张数——多张不静默挑。
  if (/^[a-z][a-z0-9._-]{1,40}$/u.test(id) && !id.includes(':')) {
    const ofFamily = cards.filter(one => one.runtime?.family === id)
    if (ofFamily.length === 1) return { ok: true, family: id, cardId: ofFamily[0]!.id }
    if (ofFamily.length > 1) {
      const running = ofFamily.find(one =>
        runningEvidenceOf(tasks.find(t => t.assignee === one.id), nowMs) === 'running')
      if (running !== undefined) return { ok: true, family: id, cardId: running.id }
      return { ok: false, why: `板上有两张 ${id} 的名片,你指一张(名片 id),我不替你挑` }
    }
    // 没有名片也认家名(登记表可能只有家没有名片;派活那一层照样按家解析)。
    return { ok: true, family: id }
  }
  return { ok: false, why: `不认识这张名片(${id}):删了、没接上,或不是一家` }
}

/**
 * 这句话里**点了名**(2026-10-28,卡「机制退修任务书-接续对题与改派语义」第 4 条):
 * 认得出哪一家 / 哪张名片被点到了 = 点名的那家(标题、标题括号前的那一段、家名 / 名片 id,
 * 全半角与大小写归一)。**抱怨句式不压过点名** —— 「让小K把事务官窗里…的问题修了」是交代,
 * 不是产品反馈;命中才回那家,没点名回 undefined。
 */
export function namesDispatchable(text: string, entries: readonly { id: string, title: string }[]): string | undefined {
  const normText = normalizeCardName(text)
  if (normText === '') return undefined
  for (const entry of entries) {
    const keys = [entry.id, entry.title, entry.title.split(/[（(]/u)[0] ?? '']
    for (const key of keys) {
      const normKey = normalizeCardName(key ?? '')
      // ≥2 字才认:单字太泛,会把普通句子里碰巧带的一个字当成点名。
      if (normKey.length < 2) continue
      if (normText.includes(normKey)) return entry.title
    }
  }
  return undefined
}
