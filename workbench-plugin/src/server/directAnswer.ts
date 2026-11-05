/**
 * **「问一句」那本回答账**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 为什么要一本账,而不是让两端各自从看板上扒:
 * - 答案要送到**三个地方**(手机字幕、电脑事务官页、一条通知),而「送过没有 / 她看过没有」
 *   是**一件事实**,只能有一处记。两端各记一份的下场是 10-03 那几次「手机看过了、电脑那张还亮着」。
 * - 「她看过了」要**两端同步**(卡里写明),所以它在服务端,不在任一端的 localStorage 里。
 *
 * 这个文件里**一行 I/O 都没有**(同 `fileDelivery.ts` 的纪律:那是它能被单测整条跑完的理由)。
 * 读写落盘在 `directAnswerFile.ts`;投影到 `/state.answers` 在 `src/answerCell.ts`。
 *
 * **不经模型**:记的是事务官原样说出来的那段话、她问的那句原话、两个时刻。
 * 没有一处是「把答案总结一下」—— 总结一次就不是答案了,而她要的正是「信息准确」那一半。
 */
import type { AnswerView, ButlerRuleChannel } from '../protocol.ts'
import { ANSWER_KEEP } from '../answerCell.ts'

/** 一条回答在账上留多久(**24 小时**;同交付回执台账那一本,见 `answerCell.ts` 那一段)。 */
export const ANSWER_TTL_MS = 24 * 60 * 60 * 1000

/** 落盘文件的样子。版本号留着:将来格式变了读得出老的。 */
export interface DirectAnswerFile {
  version: 1
  answers: readonly AnswerView[]
}

/** 落盘 / 读回那两下(实现在 `directAnswerFile.ts`;不传 = 照旧只在内存里)。 */
export interface DirectAnswerPersist {
  /** 启动时读一次。读不出来 / 看不懂就回 undefined,账从空的开始。 */
  load: () => readonly AnswerView[] | undefined
  /** 账一动就写一次。**绝不抛**。 */
  save: (answers: readonly AnswerView[]) => void
}

export interface RecordAnswerInput {
  /** 那张卡的 id(= 这一条的 id;一张卡一条回答,她再问一句是新的一张卡)。 */
  itemId: string
  /** 她问的那一句。 */
  question: string
  /** 答案原文。**不截**。 */
  answer: string
  sessionId?: string
  /** 她在哪问的。认不出来就不传(那时两端都摆、都推通知 —— 宁可多摆一处,不能让答案没去处)。 */
  where?: ButlerRuleChannel
  /**
   * 这一条**没有卡可点**(2026-10-13,固定流程直接办掉的那几件不建卡,见 `understoodTrace.ts`)。
   * 缺席 = 照旧指回 `itemId` 那张卡(与这一格出现之前逐字相同);给了 `true` 就不写 `task_id` ——
   * 指不回去的就不给点,不画一个点了没反应的条目(D13)。
   */
  cardless?: boolean
}

export interface DirectAnswerStore {
  /**
   * 记一条回答。同一张卡再记一次 = 覆盖(事务官又说了一句,算同一问的新答案,
   * 而且 `seen_at` **跟着擦掉** —— 她看过的是上一句)。
   *
   * 答案是空白(拿不到那段话)时**什么都不记、回 undefined**:
   * 「取不到就缺席,不编一个」。那时那张卡照旧留在盘上,她点开能看整段对话。
   */
  record: (input: RecordAnswerInput) => AnswerView | undefined
  /** 她看过某一条了(两端同一处)。认不出那条 id 就什么都不做、回 undefined。 */
  markSeen: (id: string, atIso: string) => AnswerView | undefined
  /** 账上全部(新的在前)。投影成 `/state.answers` 由 `answerCell.answersCellOf` 做。 */
  list: () => readonly AnswerView[]
  /** 这张卡的那一条。 */
  get: (id: string) => AnswerView | undefined
  /** 不再留这一条(她把那张卡从「完成」拖回「进行中」= 她说它是一件事)。 */
  forget: (id: string) => void
}

export function createDirectAnswerStore(
  deps: { now?: () => number, ttlMs?: number, keep?: number, persist?: DirectAnswerPersist, onChange?: () => void } = {},
): DirectAnswerStore {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? ANSWER_TTL_MS
  const keep = deps.keep ?? ANSWER_KEEP
  /** id → 那一条。插入顺序 = 记下来的先后(`prune` 按它丢最老的)。 */
  const answers = new Map<string, AnswerView>()

  const loaded = deps.persist?.load()
  if (loaded !== undefined) {
    const t = now()
    for (const one of loaded) {
      const at = Date.parse(one.at)
      if (Number.isFinite(at) && t - at > ttlMs) continue
      answers.set(one.id, one)
    }
  }

  /** 账一动就写一次。**写不下去只是没落盘**,账照旧在内存里管事。 */
  function flush(): void {
    if (deps.persist !== undefined) {
      try { deps.persist.save([...answers.values()]) }
      catch { /* 落盘失败不该把答案送不到她面前 */ }
    }
    deps.onChange?.()
  }

  function prune(): void {
    const t = now()
    for (const [id, one] of answers) {
      const at = Date.parse(one.at)
      if (Number.isFinite(at) && t - at > ttlMs) answers.delete(id)
    }
    while (answers.size > keep) {
      const oldest = answers.keys().next().value
      if (oldest === undefined) break
      answers.delete(oldest)
    }
  }

  return {
    record(input) {
      const answer = input.answer.trim()
      const question = input.question.trim()
      if (answer === '') return undefined
      prune()
      const one: AnswerView = {
        id: input.itemId,
        question,
        answer,
        at: new Date(now()).toISOString(),
        ...(input.cardless === true ? {} : { task_id: input.itemId }),
        ...(input.sessionId === undefined || input.sessionId === '' ? {} : { session_id: input.sessionId }),
        ...(input.where === undefined ? {} : { where: input.where }),
      }
      // 覆盖时连 seen_at 一起擦掉:她看过的是上一句。重新插一遍(插入顺序 = 新鲜度)。
      answers.delete(one.id)
      answers.set(one.id, one)
      flush()
      return one
    },
    markSeen(id, atIso) {
      const one = answers.get(id)
      if (one === undefined) return undefined
      // 已经看过的再点一次不改时刻(第一次看过那一刻才是事实)。
      if (one.seen_at !== undefined) return one
      const next: AnswerView = { ...one, seen_at: atIso }
      answers.set(id, next)
      flush()
      return next
    },
    list() {
      prune()
      return [...answers.values()].reverse()
    },
    get(id) {
      return answers.get(id)
    },
    forget(id) {
      if (answers.delete(id)) flush()
    },
  }
}
