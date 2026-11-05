/**
 * 理解中枢的执行器(设计第四、五节):一张工具表,每条命令接到现有的手(派活层、卡与目标的账、用户层、规矩、反馈)。
 *
 * 这里不判断「她想干什么」—— 那是模型的事;这里只管:那只手此刻能不能用(派前核手)、办成了没有、
 * 没办成为什么、下一步建议什么。点名的手不行不自动换人(照她的);换手只在派发口一处 ——
 * 中枢只派一下、失败如实说并建议下一只,真换手由派发口按执行记录里的候选表兜底(起跑失败异步发生,
 * 中枢看不见,替不了)。改派永不改名;补话先落卡再捎;一条失败不拖累其余。手的实现在 http 适配层(`HubHands`),这里不碰 IO。
 */
import { canTransition, STATUS_TITLES, statusPathTo, TASK_STATUSES, type TaskStatus } from '../../protocol.ts'
import { VERIFY_NO_ACCEPTANCE } from '../dispatchVerify.ts'
import type { HubCommand, HubResult } from './commands.ts'
import { jobKindOf } from '../dispatchChoice.ts'
import { handUsable, type HubCardFact, type HubContext, type HubHand } from './context.ts'

/**
 * ★ **补话里像验收条件的句子**(2026-10-28,卡「重派派发词带补话与轮次」):退修要求里
 * 「以 … 为准 / 只 …(再/才/并/不许/别)/ 合 main 后 …」这类句子,落评论的同时追加到卡上的
 * `acceptance`(原句,一字不改)—— 下一轮重派的派发词本来就带验收条件,这样退修要求里像条件的
 * 那部分也一并进去了。不像条件的补话只落评论,不碰验收。
 */
const ACCEPTANCE_LIKE = /以[^,。;!?\n]{1,60}为准|只[^,。;!?\n]{0,80}(?:再|才|并|不许|别)|合\s*(?:main|master)\s*后/i
export function supplementAcceptanceLine(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || !ACCEPTANCE_LIKE.test(trimmed)) return undefined
  return trimmed
}

/** 执行器调得到的手(全部是既有能力的薄封装;契约不变)。 */
export interface HubHands {
  createCard: (input: { title: string, said: string, status: 'backlog' | 'todo', goalId?: string, acceptance?: readonly string[], assignee?: string, note?: string }) => Promise<{ ok: boolean, id?: string, why?: string }>
  updateCard: (id: string, patch: { title?: string, titleFrom?: 'custom', assignee?: string, goalId?: string | null, acceptance?: readonly string[], note?: string }) => Promise<boolean>
  moveCard: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }>
  /** 回话同源写卡(卡上的 say_note:手机等卡回来时摆同一句);没接这只手就不写。 */
  sayNote?: (id: string, text: string) => Promise<void>
  /** 补话落卡(卡上留一条她说的)。 */
  comment: (id: string, text: string) => Promise<{ ok: boolean }>
  /** 补话往在跑的会话里捎(捎不进不算失败:卡上已经有了)。 */
  carry: (id: string, text: string) => Promise<{ ok: boolean, why?: string }>
  /** 改派落地的那一只手(http 的 applyReassignDispatch):旧派发收场 → 换负责人 → 同卡重派,标题不动;note 是现成的回话。 */
  reassign: (id: string, input: { to: string, family: string }) => Promise<{ ok: boolean, note: string }>
  /** 派这一张给那只手(家名或名片 id);text 缺席 = 按卡上的说明。`named` = 这一下是她点名的(pickHand 的 named 原样传,2026-10-29 任务书③)。 */
  dispatch: (id: string, input: { to: string, text?: string, named?: boolean }) => Promise<{ ok: boolean, note?: string }>
  createGoal: (input: { title: string, due?: string }) => Promise<{ ok: boolean, id?: string, why?: string }>
  updateGoal: (id: string, patch: { status?: 'open' | 'reached' | 'dropped', due?: string | null }) => Promise<boolean>
  /** 改用户层那一格:派给 to 那只手;cardId = 上一只没派成时复用同一张卡。`named` = 她点名的那只(pickHand 原样传)。 */
  userLayerFix: (input: { said: string, to: string, cardId?: string, named?: boolean }) => Promise<{ ok: boolean, id?: string, note?: string }>
  remember: (input: { text: string, scope: 'global' | 'dispatch' | 'content', said: string }) => Promise<{ ok: boolean, why?: string }>
  feedback: (text: string) => Promise<{ ok: boolean, id?: string, why?: string }>
  /** 换音色(语音后端那一换)。 */
  voice: (gender: 'female' | 'male') => Promise<{ ok: boolean, note: string }>
  /**
   * 按卡上条件核一遍已交回的卡(任务书 1029「中枢核一遍已交回的卡」):这里只管 confirm 卡与
   * 条件在不在(上下文包里有),真正调 verifyAcceptance、按产物核、过了挪「完成」/ 不过退修重派,
   * 全在这一只手里(http 的 verifyCardOnDemand)—— 与交回那一刻的核验同一套判法,不另写一份。
   * 没接这只手(老工作台 / 用例替身)就如实说核不了。execute 已把卡上没有、她这句带的条件落卡。
   */
  verifyAcceptance?: (id: string, input: { acceptance: readonly string[] }) => Promise<{ verdict: 'pass' | 'fail' | 'unknown', text: string }>
  /**
   * 本人明说「按通过 / 算通过 / 直接结掉」→ move_status done 那一下:记「人判通过」、执行记录终态
   * (第 4 步⑤;她已判通过,不是再核验一遍)。没接这只手(老工作台 / 用例替身)= 只挪状态不记。
   */
  humanSettled?: (id: string) => Promise<void>
}

/** 一次最多换几只手(没点名时)。 */
const MAX_TRIES = 3

/**
 * ★ **要进仓库的活只挑能改本机文件的手**(2026-10-29,任务书「中枢派到窗口手不按发送」第 4 条):
 * 「查 t-xxx 为什么…」这类根因活(`jobKindOf` 认成 code)窗口手拿不到仓库,派出去只会把字贴进
 * 输入框等不到结果。desk(在电脑上动手)那一类照旧走窗口,不在这道之内。
 */
function needCodeHand(text: string): boolean {
  return jobKindOf(text).kind === 'code'
}

const GOAL_STATUS_WORD = { open: '重新打开', reached: '达成', dropped: '不要了' } as const

function cardLabel(card: HubCardFact | undefined, id: string): string {
  return card === undefined ? id : `${id}「${card.title}」`
}

function handTitle(ctx: HubContext, id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  return ctx.hands.find(one => one.id === id)?.title ?? id
}

/** 挑手:点名的只看它;没点名的按「默认推荐 → 在跑少」挑能用的。 */
export function pickHand(ctx: HubContext, opts: { named?: string, needCode?: boolean, exclude?: readonly string[] }):
  | { ok: true, hand: HubHand, named: boolean }
  | { ok: false, why: string, next?: string } {
  const exclude = new Set(opts.exclude ?? [])
  const usable = (hand: HubHand): boolean => handUsable(hand).ok && (opts.needCode !== true || hand.code) && !exclude.has(hand.id)
  const others = [...ctx.hands]
    .filter(usable)
    .sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true) || a.running - b.running || Number(a.card) - Number(b.card))
  if (opts.named !== undefined) {
    const hand = ctx.hands.find(one => one.id === opts.named)
    if (hand === undefined) return { ok: false, why: `不认识 ${opts.named} 这只手` }
    const state = handUsable(hand)
    if (!state.ok) {
      const alt = others.find(one => one.id !== hand.id)
      return { ok: false, why: state.why, ...(alt === undefined ? {} : { next: `换${alt.title}?` }) }
    }
    if (opts.needCode === true && !hand.code) {
      const alt = others.find(one => one.id !== hand.id)
      return { ok: false, why: `${hand.title} 改不了本机文件`, ...(alt === undefined ? {} : { next: `换${alt.title}?` }) }
    }
    return { ok: true, hand, named: true }
  }
  const hand = others[0]
  if (hand === undefined) return { ok: false, why: opts.needCode === true ? '没有一只能改本机文件的手这会儿接得了' : '没有一只手这会儿接得了', next: '在设置里接上一家,或等额度恢复' }
  return { ok: true, hand, named: false }
}

async function safely(command: HubCommand, fn: () => Promise<HubResult>): Promise<HubResult> {
  try { return await fn() }
  catch (error) {
    return { command: command.name, ok: false, did: '这一条没办成', why: error instanceof Error ? error.message.slice(0, 120) : '执行出错' }
  }
}

async function runDispatch(command: Extract<HubCommand, { name: 'dispatch' }>, ctx: HubContext, hands: HubHands, said: string): Promise<HubResult> {
  const existing = command.card_id === undefined ? undefined : ctx.cards.find(one => one.id === command.card_id)
  // 同一张卡不开第二路(同树两路写,10-26 那一次):在跑就不派,换人走改派,加话走补一句。
  if (existing !== undefined && existing.dispatch?.status === 'running') {
    const who = handTitle(ctx, existing.assignee) ?? existing.dispatch.family ?? '别人'
    const same = command.to === undefined || existing.assignee === command.to
    return { command: 'dispatch', ok: false, card_id: existing.id, did: `没再派 ${cardLabel(existing, existing.id)}`, why: `这张卡 ${who} 正在做`, next: same ? '要加要求就说「给它补一句」' : `要换人就说「改派给 X」,我先停掉 ${who} 那次` }
  }
  let picked = pickHand(ctx, { ...(command.to === undefined ? {} : { named: command.to }), ...(needCodeHand(command.text) ? { needCode: true } : {}) })
  // 卡:已有的照用;新活先建(核手不过也建 —— 话不丢,卡上写为什么没派)。
  let cardId = existing?.id
  const title = existing?.title ?? command.new?.title ?? command.text.slice(0, 60)
  if (cardId === undefined) {
    const made = await hands.createCard({
      title, said, status: 'todo',
      ...(command.new?.goal_id === undefined ? {} : { goalId: command.new.goal_id }),
      ...(command.acceptance === undefined ? {} : { acceptance: command.acceptance }),
      ...(picked.ok ? { assignee: picked.hand.id } : { note: `没派:${picked.why}` }),
    })
    if (!made.ok || made.id === undefined) return { command: 'dispatch', ok: false, did: `「${title}」没建成卡`, why: made.why ?? '卡没建上' }
    cardId = made.id
  }
  else if (command.acceptance !== undefined && existing?.acceptance === undefined) {
    await hands.updateCard(cardId, { acceptance: command.acceptance })
  }
  const label = `${cardId}「${title}」`
  if (!picked.ok) return { command: 'dispatch', ok: false, card_id: cardId, did: existing === undefined ? `建了 ${label},没派` : `${label}没派`, why: picked.why, ...(picked.next === undefined ? {} : { next: picked.next }) }
  const tried: string[] = []
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const hand: HubHand = picked.hand
    tried.push(hand.id)
    if (existing !== undefined || attempt > 0) await hands.updateCard(cardId, { assignee: hand.id })
    const ran = await hands.dispatch(cardId, { to: hand.id, text: command.text, named: picked.named })
    if (ran.ok) {
      const switched = tried.length > 1 ? `(${tried.slice(0, -1).map(id => handTitle(ctx, id)).join('、')} 没派成,换了 ${hand.title})` : ''
      return { command: 'dispatch', ok: true, card_id: cardId, who: hand.title, did: `${label}派给 ${hand.title} 了${switched}` }
    }
    if (picked.named) {
      const alt = pickHand(ctx, { ...(needCodeHand(command.text) ? { needCode: true } : {}), exclude: [hand.id] })
      return { command: 'dispatch', ok: false, card_id: cardId, did: `${label}没派成`, why: ran.note ?? `${hand.title} 没接住`, ...(alt.ok ? { next: `换${alt.hand.title}?` } : {}) }
    }
    const next = pickHand(ctx, { ...(needCodeHand(command.text) ? { needCode: true } : {}), exclude: tried })
    if (!next.ok) return { command: 'dispatch', ok: false, card_id: cardId, did: `${label}没派成`, why: `${hand.title}:${ran.note ?? '没接住'};${next.why}` }
    picked = next
  }
  return { command: 'dispatch', ok: false, card_id: cardId, did: `${label}没派成`, why: `换了 ${tried.length} 只手都没接住` }
}

async function runReassign(command: Extract<HubCommand, { name: 'reassign' }>, ctx: HubContext, hands: HubHands): Promise<HubResult> {
  const card = ctx.cards.find(one => one.id === command.card_id)
  const label = cardLabel(card, command.card_id)
  // 进仓库的活(restart 会同卡重派)同样只挑能改本机文件的手(与 runDispatch 同一判据)。
  const picked = pickHand(ctx, { named: command.to, ...(needCodeHand([card?.title, card?.desc_head].filter(one => one !== undefined).join(' ')) ? { needCode: true } : {}) })
  if (!picked.ok) return { command: 'reassign', ok: false, card_id: command.card_id, did: `${label}没改派`, why: picked.why, ...(picked.next === undefined ? {} : { next: picked.next }) }
  if (card?.dispatch?.status === 'running' && card.assignee === picked.hand.id) return { command: 'reassign', ok: true, card_id: command.card_id, who: picked.hand.title, did: `${label}本来就是 ${picked.hand.title} 在做` }
  // 只换负责人、不重派:标题照样不动。
  if (!command.restart) {
    await hands.updateCard(command.card_id, { assignee: picked.hand.id })
    return { command: 'reassign', ok: true, card_id: command.card_id, who: picked.hand.title, did: `${label}负责人换成 ${picked.hand.title}(没重派)` }
  }
  // 改派落地只此一只手(收场旧派发 + 换负责人 + 同卡重派);它的回话是现成的。
  const ran = await hands.reassign(command.card_id, { to: picked.hand.id, family: picked.hand.family })
  if (!ran.ok) {
    const alt = pickHand(ctx, { ...(needCodeHand([card?.title, card?.desc_head].filter(one => one !== undefined).join(' ')) ? { needCode: true } : {}), exclude: [picked.hand.id] })
    return { command: 'reassign', ok: false, card_id: command.card_id, who: picked.hand.title, did: `${label}改派没办完`, why: ran.note, ...(alt.ok ? { next: `换${alt.hand.title}?` } : {}) }
  }
  return { command: 'reassign', ok: true, card_id: command.card_id, who: picked.hand.title, did: ran.note }
}

async function runUserLayerFix(command: Extract<HubCommand, { name: 'user_layer_fix' }>, ctx: HubContext, hands: HubHands): Promise<HubResult> {
  /*
   * ★ 换手只在派发口一处(2026-10-29,可靠执行闭环第一批第 3 步②;B#4/5/8/9/10/11):
   * 这里**只派一下、不自己循环换人** —— 中枢的换手只看得见同步回包,起跑那一下失败是异步的,
   * 它替不了派发口。没派成如实说为什么、给下一只的建议;真换手由派发口按执行记录里的候选表兜底
   * (起跑失败 → 候选里换下一只;严格点名 → 等她,不伪称她点了替代者)。
   */
  const picked = pickHand(ctx, { needCode: true, ...(command.to === undefined ? {} : { named: command.to }) })
  const what = command.widget === undefined ? '用户层那一格' : `用户层「${ctx.user_layer.find(one => one.id === command.widget)?.name ?? command.widget}」`
  if (!picked.ok) return { command: 'user_layer_fix', ok: false, did: `${what}没改`, why: picked.why, ...(picked.next === undefined ? {} : { next: picked.next }) }
  const ran = await hands.userLayerFix({ said: command.said, to: picked.hand.id, named: picked.named })
  if (ran.ok) {
    return { command: 'user_layer_fix', ok: true, who: picked.hand.title, ...(ran.id === undefined ? {} : { card_id: ran.id }), did: `${what}交给 ${picked.hand.title} 改了${ran.id === undefined ? '' : `(${ran.id})`},只改用户层目录` }
  }
  const alt = pickHand(ctx, { needCode: true, ...(command.to === undefined ? {} : { named: command.to }), exclude: [picked.hand.id] })
  return {
    command: 'user_layer_fix', ok: false, ...(ran.id === undefined ? {} : { card_id: ran.id }),
    did: `${what}没改成`, why: ran.note ?? `${picked.hand.title} 没接住`,
    ...(alt.ok ? { next: `换${alt.hand.title}?` } : {}),
  }
}

async function runVerify(command: Extract<HubCommand, { name: 'verify' }>, ctx: HubContext, hands: HubHands): Promise<HubResult> {
  const card = ctx.cards.find(one => one.id === command.card_id)
  const label = cardLabel(card, command.card_id)
  if (card === undefined) return { command: 'verify', ok: false, card_id: command.card_id, did: `${command.card_id}没核成`, why: '卡不在板上' }
  // 只对「等你确认」的卡:别的一律拒,说清卡在哪个状态(她看得见的那句里卡的状态就是板上事实)。
  if (card.status === 'done') return { command: 'verify', ok: false, card_id: card.id, did: `${label}没核`, why: '这张卡已经完成结掉了,不用再核' }
  if (card.status === 'canceled') return { command: 'verify', ok: false, card_id: card.id, did: `${label}没核`, why: '这张卡已经取消了,没得核' }
  if (card.status !== 'confirm') {
    const where = (TASK_STATUSES as readonly string[]).includes(card.status) ? STATUS_TITLES[card.status as TaskStatus] : card.status
    return { command: 'verify', ok: false, card_id: card.id, did: `${label}没核`, why: `这张卡还在「${where}」,还没交回,没得核` }
  }
  if (hands.verifyAcceptance === undefined) return { command: 'verify', ok: false, card_id: card.id, did: `${label}没核成`, why: '核验的工具这会儿没接上' }
  const onCard = card.acceptance_lines ?? []
  let acceptance = onCard
  if (onCard.length === 0) {
    // 卡上没条件:她这句里带了(「像条件的补话追加 acceptance」那条的同款)就先落卡再核;
    // 没带不回 VERIFY_NO_ACCEPTANCE 干等 —— 问一句要按什么条件核。
    if (command.acceptance === undefined || command.acceptance.length === 0) {
      return { command: 'verify', ok: true, card_id: card.id, did: `${label}没核`, ask: { question: `${VERIFY_NO_ACCEPTANCE}\n要按什么条件核?把条件说给我,我先记到卡上再核。`, options: [] } }
    }
    acceptance = [...command.acceptance]
    await hands.updateCard(card.id, { acceptance }).catch(() => false)
  }
  const one = await hands.verifyAcceptance(card.id, { acceptance })
  // 核不了:如实说为什么,卡不动(他的规矩:判断不出来的一律按「需要再核」,不许自动放行)。
  if (one.verdict === 'unknown') return { command: 'verify', ok: false, card_id: card.id, did: `${label}没核成`, why: one.text }
  return { command: 'verify', ok: true, card_id: card.id, did: one.text }
}

async function runOne(command: HubCommand, ctx: HubContext, hands: HubHands, said: string): Promise<HubResult> {
  const card = 'card_id' in command && typeof command.card_id === 'string' ? ctx.cards.find(one => one.id === command.card_id) : undefined
  switch (command.name) {
    case 'dispatch': return runDispatch(command, ctx, hands, said)
    case 'reassign': return runReassign(command, ctx, hands)
    case 'user_layer_fix': return runUserLayerFix(command, ctx, hands)
    case 'verify': return runVerify(command, ctx, hands)
    case 'supplement': {
      const label = cardLabel(card, command.card_id)
      const put = await hands.comment(command.card_id, command.text)
      if (!put.ok) return { command: 'supplement', ok: false, card_id: command.card_id, did: `补话没落到 ${label}`, why: '卡上没写进去' }
      // 像条件的补话同时追加到验收(原句不改;已有的不重复加)。
      const acceptLine = supplementAcceptanceLine(command.text)
      let acceptanceAdded = false
      if (acceptLine !== undefined && card !== undefined && !(card.acceptance_lines ?? []).includes(acceptLine)) {
        acceptanceAdded = await hands.updateCard(command.card_id, { acceptance: [...(card.acceptance_lines ?? []), acceptLine] }).catch(() => false)
      }
      const carried = card?.dispatch?.status === 'running' ? await hands.carry(command.card_id, command.text).catch(() => ({ ok: false })) : { ok: false }
      return { command: 'supplement', ok: true, card_id: command.card_id, did: carried.ok ? `补话记在 ${label} 上了,也捎给了在做的那家` : `补话记在 ${label} 上了${acceptanceAdded ? ',像条件的那句也加进验收了' : ''},它下一轮(交回 / 续跑 / 重派)带上` }
    }
    case 'rename': {
      const did = await hands.updateCard(command.card_id, { title: command.title, titleFrom: 'custom' })
      return did
        ? { command: 'rename', ok: true, card_id: command.card_id, did: `${command.card_id} 改名为「${command.title}」` }
        : { command: 'rename', ok: false, card_id: command.card_id, did: `${cardLabel(card, command.card_id)}没改名`, why: '账没写进去' }
    }
    case 'cancel':
    case 'move_status': {
      const status: TaskStatus = command.name === 'cancel' ? 'canceled' : command.status
      const label = cardLabel(card, command.card_id)
      // ★ **照 statusPathTo 逐格走**(2026-10-28,卡「中枢挪状态按最短路走」):tasks.move 一次只走一格,
      // 「阻塞」的卡一句「按通过结掉」表上没路;仓库里 collabRelay / executionState / progress 早已照
      // statusPathTo 逐格走,中枢这一处对齐。表本身(TASK_TRANSITIONS)不动。
      const from = card !== undefined && (TASK_STATUSES as readonly string[]).includes(card.status) ? card.status as TaskStatus : undefined
      if (from === undefined) {
        // 卡不在上下文包里,不知道现状态:照旧只调一次,让账自己拒。
        const moved = await hands.moveCard(command.card_id, status)
        return moved.ok
          ? { command: command.name, ok: true, card_id: command.card_id, did: status === 'canceled' ? `${label}取消了` : `${label}挪到「${STATUS_TITLES[status]}」` }
          : { command: command.name, ok: false, card_id: command.card_id, did: `${label}没挪`, why: moved.reason ?? '卡不在了' }
      }
      const path = statusPathTo(from, status)
      // 离开「完成」只有「重开回进行中」一条(转换表注释 3):重开照旧按路办成;绕路
      // (done → doing → canceled 这类)会先擦掉完成时刻、作废那一轮,不是「取消」该有的样子 ——
      // 只拒绕路,拒的理由照旧用表里的(原地不动除外)。
      if (path === undefined || (from === 'done' && from !== status && status !== 'doing')) {
        const checked = canTransition(from, status)
        return { command: command.name, ok: false, card_id: command.card_id, did: `${label}没挪`, ...(checked.ok ? {} : { why: checked.reason }) }
      }
      let at = from
      for (const step of path) {
        const moved = await hands.moveCard(command.card_id, step)
        if (!moved.ok) {
          // 中途一格失败就停在那格:did 如实写停在哪,why 带 tasks.move 回的 reason。
          return {
            command: command.name, ok: false, card_id: command.card_id,
            did: at === from ? `${label}没挪` : `${label}挪到「${STATUS_TITLES[at]}」,没挪到「${STATUS_TITLES[status]}」`,
            why: moved.reason ?? '卡不在了',
          }
        }
        at = step
      }
      const via = path.length > 1 ? `(经${path.slice(0, -1).map(step => `「${STATUS_TITLES[step]}」`).join('、')})` : ''
      // ★ 人判通过(第 4 步⑤):她明说「按通过 / 直接结掉」→ confirm 直达 done = 人已判通过,
      // 记一笔「人判通过」、执行记录终态 —— 不是再走核验;「核一遍」才走 verify 命令。
      if (command.name === 'move_status' && status === 'done' && from === 'confirm' && hands.humanSettled !== undefined) {
        await hands.humanSettled(command.card_id).catch(() => undefined)
      }
      return { command: command.name, ok: true, card_id: command.card_id, did: status === 'canceled' ? `${label}取消了${via}` : `${label}挪到「${STATUS_TITLES[status]}」${via}` }
    }
    case 'set_goal': {
      const did = await hands.updateCard(command.card_id, { goalId: command.goal_id })
      const goal = command.goal_id === null ? undefined : ctx.goals.find(one => one.id === command.goal_id)
      return did
        ? { command: 'set_goal', ok: true, card_id: command.card_id, ...(command.goal_id === null ? {} : { goal_id: command.goal_id }), did: command.goal_id === null ? `${cardLabel(card, command.card_id)}移出了目标` : `${cardLabel(card, command.card_id)}归到目标「${goal?.title ?? command.goal_id}」` }
        : { command: 'set_goal', ok: false, card_id: command.card_id, did: `${cardLabel(card, command.card_id)}没归目标`, why: '账没写进去' }
    }
    case 'goal_status':
    case 'goal_due': {
      const goal = ctx.goals.find(one => one.id === command.goal_id)
      const name = `目标「${goal?.title ?? command.goal_id}」`
      const did = await hands.updateGoal(command.goal_id, command.name === 'goal_status' ? { status: command.status } : { due: command.due })
      if (!did) return { command: command.name, ok: false, goal_id: command.goal_id, did: `${name}没改`, why: '账没写进去' }
      return { command: command.name, ok: true, goal_id: command.goal_id, did: command.name === 'goal_status' ? `${name}标成「${GOAL_STATUS_WORD[command.status]}」` : command.due === null ? `${name}去掉了截止日` : `${name}截止改到 ${command.due}` }
    }
    case 'goal_create': {
      const made = await hands.createGoal({ title: command.title, ...(command.due === undefined ? {} : { due: command.due }) })
      return made.ok && made.id !== undefined
        ? { command: 'goal_create', ok: true, goal_id: made.id, did: `建了目标「${command.title}」${command.due === undefined ? '' : `(截止 ${command.due})`}` }
        : { command: 'goal_create', ok: false, did: `目标「${command.title}」没建成`, why: made.why ?? '账没写进去' }
    }
    case 'note': {
      const made = await hands.createCard({ title: command.title, said, status: command.status, ...(command.goal_id === undefined ? {} : { goalId: command.goal_id }), ...(command.acceptance === undefined ? {} : { acceptance: command.acceptance }) })
      return made.ok && made.id !== undefined
        ? { command: 'note', ok: true, card_id: made.id, did: `记下了 ${made.id}「${command.title}」(${STATUS_TITLES[command.status]})` }
        : { command: 'note', ok: false, did: `「${command.title}」没记上`, why: made.why ?? '卡没建上' }
    }
    case 'remember': {
      const done = await hands.remember({ text: command.text, scope: command.scope, said })
      return done.ok
        ? { command: 'remember', ok: true, did: `记住了这条规矩:「${command.text}」` }
        : { command: 'remember', ok: false, did: `规矩「${command.text}」没记上`, why: done.why ?? '规矩表没接上' }
    }
    case 'feedback': {
      const sent = await hands.feedback(command.text)
      return sent.ok
        ? { command: 'feedback', ok: true, did: `这是工作台本身的问题,反馈给开发者了${sent.id === undefined ? '' : `(${sent.id})`}` }
        : { command: 'feedback', ok: false, did: '反馈没发出去', why: sent.why ?? '反馈通道没接上' }
    }
    case 'voice': {
      const done = await hands.voice(command.gender)
      return done.ok
        ? { command: 'voice', ok: true, did: done.note }
        : { command: 'voice', ok: false, did: `音色没换成${command.gender === 'female' ? '女声' : '男声'}`, why: done.note }
    }
    case 'ask':
      return { command: 'ask', ok: true, did: command.question, ask: { question: command.question, options: command.options }, ...(command.about === undefined ? {} : { card_id: command.about }) }
    case 'chat':
      return { command: 'chat', ok: true, did: command.reply, reply: command.reply }
    // 到不了:confirm 答挂着的问,在 run.ts 的 runCommands 开头就被接走(走 answerPending);
    // 同句夹带在 parseCommands 那一层就拒了。漏到这里是流转错了,炸出来比静默吞掉好查。
    case 'confirm':
      throw new Error('confirm 不走执行器(答挂着的问在 runCommands 接走)')
  }
}

/**
 * ★ **同一句里,同一张卡的补话先于改派落卡**(2026-10-28,卡「重派派发词带补话与轮次」;
 * 0.4.170 真机第二句):中枢同一句出了 `reassign(restart)` + `supplement`,若按清单顺序先改派,
 * 重派拼派发词时那句退修要求还没落卡,派发词里一个字都没有 —— 执行者原样又报了一遍「可合并」。
 * 这里执行同一张卡的 `supplement` 一律先于 `reassign`;**回话顺序照旧按她说的清单排**
 * (结果数组与传入的 commands 一一对位)。
 */
export async function executeCommands(commands: readonly HubCommand[], ctx: HubContext, hands: HubHands, input: { said: string }): Promise<HubResult[]> {
  const results = new Array<HubResult | undefined>(commands.length)
  const ran = new Set<number>()
  const runAt = async (index: number): Promise<void> => {
    const command = commands[index] as HubCommand
    results[index] = await safely(command, () => runOne(command, ctx, hands, input.said))
    ran.add(index)
  }
  for (let i = 0; i < commands.length; i += 1) {
    if (ran.has(i)) continue
    const command = commands[i] as HubCommand
    if (command.name === 'reassign') {
      for (let j = i + 1; j < commands.length; j += 1) {
        const other = commands[j] as HubCommand
        if (ran.has(j) || other.name !== 'supplement' || other.card_id !== command.card_id) continue
        await runAt(j)
      }
    }
    await runAt(i)
  }
  return results as HubResult[]
}
