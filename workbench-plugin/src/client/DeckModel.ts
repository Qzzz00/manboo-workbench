/**
 * 指挥台的**纯算**那一半里,**两种卡共用**的部分(2026-09-22)。
 *
 * 选题卡(`TopicDeckModel.ts`)与需求卡(`FeatureDeckModel.ts`)之间,
 * 「派活小标该写哪两个字」「页签怎么排」「这一份有没有改动」这几件事一字不差 ——
 * 所以它们在这里,那两个文件只留各自的态 / 页签定义与措辞。
 *
 * 分出界面那一半的理由与 `boardModel.ts` 一样:这类判断要能单独钉住,
 * 不必渲染一整棵 DOM 才测得了。
 */
import type {
  DeckDiffRow, DeckDocView, DeckReviewEntry, DeckRunBadge,
  TaskClientDispatch, TaskDispatch,
} from '../protocol.ts'

/**
 * 派活小标的四档(设计第一节「看得见进度」)。
 *
 * ★ 「排队」是这四档里**唯一一个卡上原来算不出来的**:`TaskDispatch` 故意没有这一档
 * (protocol.ts:「命令要么起来了,要么没起来」)。它要靠**她点按钮那一刻的留痕**
 * (`审核记录.jsonl` 里那条 `run`)与卡上的派活记录一起才算得出来 ——
 * 「交出去了,那头还没报任何进度」。
 *
 * 一条都没有 → `undefined`,**整段不画**:没派过活的卡不该写「没派给谁」(D13)。
 */
export function deckRunBadge(input: {
  dispatch?: TaskDispatch | undefined
  clientDispatch?: TaskClientDispatch | undefined
  /** 最后一次「让事务官推进这一步」的时刻(ISO)。 */
  lastRunAt?: string | undefined
}): DeckRunBadge | undefined {
  // 她取消、已收场的那一次(2026-10-28 任务书)没有「在做」这一档可画 —— 卡上已是「取消」,小标整段不出现。
  const fromAgent = input.dispatch === undefined || input.dispatch.status === 'canceled'
    ? undefined
    : { at: input.dispatch.started_at, badge: AGENT_BADGE[input.dispatch.status] }
  const fromWindow = input.clientDispatch === undefined
    ? undefined
    : { at: input.clientDispatch.at, badge: input.clientDispatch.status === 'failed' ? '失败' as const : '在做' as const }

  // 两条记录都在时以**晚的那条**为准:同一张卡上先走窗口再走接口是常事。
  const newest = fromAgent === undefined
    ? fromWindow
    : fromWindow === undefined
      ? fromAgent
      : (fromWindow.at > fromAgent.at ? fromWindow : fromAgent)

  if (input.lastRunAt === undefined) return newest?.badge
  // 她刚点完按钮,那头还没报任何比这一刻更新的进度 = 排队。
  if (newest === undefined || newest.at < input.lastRunAt) return '排队'
  return newest.badge
}

const AGENT_BADGE: Readonly<Record<'running' | 'done' | 'failed', DeckRunBadge>> = {
  running: '在做',
  done: '回来了',
  failed: '失败',
}

/** 最后一次「让事务官推进」那一条留痕。没有回 undefined。 */
export function lastDeckRun<Entry extends DeckReviewEntry>(reviews: readonly Entry[]): Entry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i]
    if (one?.action === 'run') return one
  }
  return undefined
}

/**
 * 页签的排序:**这一态要铺开的那几个排在前面**,其余按固定顺序跟在后面。
 *
 * 不删不藏 —— 页签一直都在。一个因为"现在不该看"而消失的定稿只会让她去文件夹里找,
 * 那正是这一版要省掉的事(设计第〇节第 1 条)。
 */
export function orderDeckTabs<Tab extends string>(
  all: readonly Tab[], front: readonly Tab[],
): readonly Tab[] {
  return [...front, ...all.filter(tab => !front.includes(tab))]
}

/** 这一份产物有没有真改动(diff 里除了 `same` 还有别的)。 */
export function deckHasChange(rows: readonly DeckDiffRow[] | undefined): boolean {
  return rows !== undefined && rows.some(row => row.kind !== 'same')
}

/** 找一个页签此刻的那一份。取不到回 undefined —— 界面据此说「还没读到」,不画一份空的。 */
export function deckDocOf<Tab extends string>(
  docs: readonly DeckDocView<Tab>[], tab: Tab,
): DeckDocView<Tab> | undefined {
  return docs.find(one => one.tab === tab)
}

/** 一份产物上最近一次把关(不含 `run` / `record`)。卡上写「你上次说:…」。 */
export function lastDeckReviewOf<Entry extends DeckReviewEntry>(
  reviews: readonly Entry[], tab: string,
): Entry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i]
    if (one?.tab === tab && one.action !== 'run' && one.action !== 'record') return one
  }
  return undefined
}
