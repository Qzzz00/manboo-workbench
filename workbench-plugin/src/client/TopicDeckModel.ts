/**
 * 选题指挥台的**纯算**那一半(2026-09-22)。
 *
 * 界面那一半在 `TopicDeck.tsx`。分开的理由与 `boardModel.ts` 一样:
 * 「这条选题此刻算哪一态」「派活小标该写哪两个字」这类判断要能单独钉住,
 * 而不必渲染一整棵 DOM 才测得了。
 */
import type {
  TaskClientDispatch, TaskDispatch, TopicDiffRow, TopicDocTab, TopicDocView,
  TopicPhase, TopicReviewEntry, TopicRunBadge, TopicStage,
} from '../protocol.ts'
import { TOPIC_DOC_TABS, TOPIC_PHASE_TABS, TOPIC_STAGES, topicPhaseOf } from '../protocol.ts'

import {
  deckDocOf, deckHasChange, deckRunBadge, lastDeckReviewOf, lastDeckRun, orderDeckTabs,
} from './DeckModel.ts'

/**
 * 下面这几个 2026-09-22 夜搬进了 `DeckModel.ts`(需求卡要的是**同一份**,
 * 审视第三节:「两条模板要的是同一个东西」)。这里的名字、签名与行为**一个字没变**,
 * 只是实现换成了调用通用那一份 —— 复制一份平行实现才是两份一定会漂的那条老路。
 */

/** 派活小标的四档。实现在 `DeckModel.ts` 的 `deckRunBadge`。 */
export const topicRunBadge = deckRunBadge

/** 最后一次「让事务官推进」那一条留痕。没有回 undefined。 */
export function lastRun(reviews: readonly TopicReviewEntry[]): TopicReviewEntry | undefined {
  return lastDeckRun(reviews)
}

/**
 * 这条选题此刻在四态的哪一格、是第几段。
 *
 * 「第几段」要显示出来:四态是粗刻度,她在「制作」里待的时间最长,
 * 只写「制作」她看不出自己走到哪了(设计第〇节:主次关系比模块全不全重要,但**不能糊**)。
 */
export function topicPhaseView(stage: TopicStage): { phase: TopicPhase, stageIndex: number, stageTotal: number } {
  return {
    phase: topicPhaseOf(stage),
    stageIndex: TOPIC_STAGES.indexOf(stage) + 1,
    stageTotal: TOPIC_STAGES.length,
  }
}

/**
 * 页签的排序:**这一态要铺开的那几个排在前面**,其余按固定顺序跟在后面。
 *
 * 不删不藏 —— 七个页签一直都在。一个因为"现在不该看"而消失的定稿只会让她去文件夹里找,
 * 那正是这一版要省掉的事(设计第〇节第 1 条)。
 */
export function orderedTabs(phase: TopicPhase): readonly TopicDocTab[] {
  return orderDeckTabs(TOPIC_DOC_TABS, TOPIC_PHASE_TABS[phase])
}

/** 这一态默认先打开哪一个页签。**取铺开的第一个**;那一态一个都没配就取第一个页签。 */
export function defaultTab(phase: TopicPhase): TopicDocTab {
  return orderedTabs(phase)[0] ?? '框架'
}

/** 卡上那几块「在场 / 收起」的东西。`open` = 这一态铺开,其余收进可点开的折叠块。 */
export type DeckSection = '随手记' | '素材清单' | '日历' | '数据与对标'

export const DECK_SECTIONS: readonly DeckSection[] = ['随手记', '素材清单', '日历', '数据与对标']

/**
 * 每一态铺开哪几块(设计第〇节逐字:「构思态只留框架与随手记;制作态定稿编辑与素材清单
 * 占主位、数据收起;发布态只剩包装与日历;复盘态数据与对标铺开」)。
 */
export const PHASE_SECTIONS: Readonly<Record<TopicPhase, readonly DeckSection[]>> = {
  构思: ['随手记'],
  制作: ['素材清单'],
  发布: ['日历'],
  复盘: ['数据与对标'],
}

export function sectionOpen(phase: TopicPhase, section: DeckSection): boolean {
  return PHASE_SECTIONS[phase].includes(section)
}

/** 这一态那颗按钮底下那行小字:她按下去之前该知道会发生什么。 */
export const PHASE_RUN_HINT: Readonly<Record<TopicPhase, string>> = {
  构思: '接着你说过的想法,问你三个问题、梳出内容框架',
  制作: '按框架出初稿、你填完我润成定稿,再列素材清单、查一遍违禁词',
  发布: '按定稿出标题 / 短文案 / 标签 / 封面建议,三组备选',
  复盘: '先让你打分,再结合数据总结这一篇',
}

/** 这一份产物有没有真改动(diff 里除了 `same` 还有别的)。 */
export function hasChange(rows: readonly TopicDiffRow[] | undefined): boolean {
  return deckHasChange(rows)
}

/** 找一个页签此刻的那一份。取不到回 undefined —— 界面据此说「还没读到」,不画一份空的。 */
export function docOf(docs: readonly TopicDocView[], tab: TopicDocTab): TopicDocView | undefined {
  return deckDocOf(docs, tab)
}

/** 一份产物上最近一次把关(不含 `run`)。卡上写「你上次说:…」。 */
export function lastReviewOf(reviews: readonly TopicReviewEntry[], tab: TopicDocTab): TopicReviewEntry | undefined {
  return lastDeckReviewOf(reviews, tab)
}
