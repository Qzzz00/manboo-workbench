/**
 * 需求指挥台的**纯算**那一半(2026-09-22)。
 *
 * 界面那一半在 `FeatureDeck.tsx`;两种卡共用的那几件(四档小标、页签排序、diff 有没有改动)
 * 在 `DeckModel.ts`。这里只有需求自己的四态与措辞。
 */
import type { FeatureDocTab, FeatureDocView, FeatureReviewEntry, FeatureStage } from '../protocol.ts'
import { FEATURE_DOC_TABS, FEATURE_STAGES, FEATURE_STAGE_TABS, featureStageOf } from '../protocol.ts'
import { deckDocOf, lastDeckReviewOf, orderDeckTabs } from './DeckModel.ts'

/** 这条需求此刻在第几态(卡上那行「现在:X · 第 n/4 态」)。 */
export function featureStageView(stage: FeatureStage): { stage: FeatureStage, index: number, total: number } {
  const one = featureStageOf(stage)
  return { stage: one, index: FEATURE_STAGES.indexOf(one) + 1, total: FEATURE_STAGES.length }
}

/** 页签排序:这一态要铺开的排在前面,其余跟在后面。**不删不藏**。 */
export function orderedFeatureTabs(stage: FeatureStage): readonly FeatureDocTab[] {
  return orderDeckTabs(FEATURE_DOC_TABS, FEATURE_STAGE_TABS[featureStageOf(stage)])
}

/** 这一态默认先打开哪一个页签。**取铺开的第一个**。 */
export function defaultFeatureTab(stage: FeatureStage): FeatureDocTab {
  return orderedFeatureTabs(stage)[0] ?? '需求'
}

/** 找一个页签此刻的那一份。 */
export function featureDocOf(docs: readonly FeatureDocView[], tab: FeatureDocTab): FeatureDocView | undefined {
  return deckDocOf(docs, tab)
}

/** 一份产物上最近一次把关。 */
export function lastFeatureReviewOf(
  reviews: readonly FeatureReviewEntry[], tab: FeatureDocTab,
): FeatureReviewEntry | undefined {
  return lastDeckReviewOf(reviews, tab)
}

/**
 * 这一态那颗按钮底下那行小字:**她按下去之前该知道会发生什么**。
 *
 * 措辞与服务端 `FEATURE_STAGE_BRIEF` 说的是同一件事,但这里是对她说的(第二人称),
 * 那边是对事务官说的(祈使)。两份都短,各自读着顺 —— 不硬凑成一份。
 */
export const FEATURE_RUN_HINT: Readonly<Record<FeatureStage, string>> = {
  梳理: '把你那一句话问清楚(最多两问),写成需求:目标 / 边界 / 验收标准',
  拆解与派活: '拆成几件事,标好哪件给 Codex、哪件给 Claude,然后一键派出去',
  验收: '把每件回来的结果收成一段摘要,等你说通过还是打回',
  记录: '把这件事的结论写成一条,你点一下就进项目的决策记录',
}

/** 「记录」那一态那颗按钮:她只点一下,不用自己写。 */
export const FEATURE_RECORD_BUTTON = '写进决策记录'

/** 最近一次「写进决策记录」。有了就在卡上写清楚落到哪个文件 —— 不让她去猜。 */
export function lastRecord(reviews: readonly FeatureReviewEntry[]): FeatureReviewEntry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i]
    if (one?.action === 'record') return one
  }
  return undefined
}
