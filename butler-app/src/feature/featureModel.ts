/**
 * 手机上需求卡页的**纯算**那一半(2026-09-23)。
 *
 * 与电脑端 `workbench-plugin/src/client/FeatureDeckModel.ts` + `DeckModel.ts` 说的是同一件事,
 * 函数名也照着起 —— 两边同名同行为,改一处时另一处会被一眼看见。
 * 界面那一半在 `FeatureDeckPage.tsx`;这里一个 DOM 都不碰,所以这几条判断单独钉得住。
 */
import {
  DEFAULT_FEATURE_STAGE, FEATURE_DOC_TABS, FEATURE_STAGE_TABS, FEATURE_STAGES,
  type DeckDiffRow, type DeckDocView, type DeckReviewEntry, type DeckRunBadge,
  type FeatureDocTab, type FeatureStage,
} from './deckProtocol';
import type { TaskClientDispatchView, TaskDispatchView, TaskView } from '../api/protocol';

/** 这条需求此刻算哪一态。**认不出的归「梳理」**(不抛):老数据里可能是任意字符串。 */
export function featureStageOf(stage: string | undefined): FeatureStage {
  return stage !== undefined && (FEATURE_STAGES as readonly string[]).includes(stage)
    ? stage as FeatureStage
    : DEFAULT_FEATURE_STAGE;
}

/** 这张卡是不是需求卡。**只认 `kind`**,不靠标题猜。 */
export function isFeatureTask(task: TaskView | undefined): boolean {
  return task?.kind === 'feature';
}

/** 卡上那行「现在:第 n/4 态「梳理」」。 */
export function featureStageView(stage: string | undefined): { stage: FeatureStage; index: number; total: number } {
  const one = featureStageOf(stage);
  return { stage: one, index: FEATURE_STAGES.indexOf(one) + 1, total: FEATURE_STAGES.length };
}

/** 页签排序:这一态要铺开的排在前面,其余跟在后面。**不删不藏**。 */
export function orderedFeatureTabs(stage: string | undefined): readonly FeatureDocTab[] {
  const front = FEATURE_STAGE_TABS[featureStageOf(stage)];
  return [...front, ...FEATURE_DOC_TABS.filter((tab) => !front.includes(tab))];
}

/** 这一态默认先打开哪一个页签。**取铺开的第一个**。 */
export function defaultFeatureTab(stage: string | undefined): FeatureDocTab {
  return orderedFeatureTabs(stage)[0] ?? '需求';
}

/** 找一个页签此刻的那一份。取不到回 undefined —— 界面据此说「还没读到」,不画一份空的。 */
export function featureDocOf(docs: readonly DeckDocView[], tab: FeatureDocTab): DeckDocView | undefined {
  return docs.find((one) => one.tab === tab);
}

/** 一份产物上最近一次把关(不含 `run` / `record`)。卡上写「你上次说:…」。 */
export function lastFeatureReviewOf(reviews: readonly DeckReviewEntry[], tab: string): DeckReviewEntry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i];
    if (one?.tab === tab && one.action !== 'run' && one.action !== 'record') return one;
  }
  return undefined;
}

/** 最后一次「让事务官推进这一步」那一条留痕。 */
export function lastDeckRun(reviews: readonly DeckReviewEntry[]): DeckReviewEntry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i];
    if (one?.action === 'run') return one;
  }
  return undefined;
}

/** 最近一次「写进决策记录」。有了就在卡上写清楚,不让他去猜落没落下。 */
export function lastRecord(reviews: readonly DeckReviewEntry[]): DeckReviewEntry | undefined {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const one = reviews[i];
    if (one?.action === 'record') return one;
  }
  return undefined;
}

const AGENT_BADGE: Readonly<Record<'running' | 'done' | 'failed', DeckRunBadge>> = {
  running: '在做',
  done: '回来了',
  failed: '失败',
};

/**
 * 派活小标的四档(算法与电脑端 `deckRunBadge` 逐字相同)。
 *
 * 「排队」是唯一一个光看卡算不出来的:它要**他点按钮那一刻的留痕**(`审核记录.jsonl`
 * 里那条 `run`)与卡上的派活记录放在一起才算得出 —— 「交出去了,那头还没报任何进度」。
 * 一条都没有 → `undefined`,**整段不画**:没派过活的卡不该写「没派给谁」。
 */
export function deckRunBadge(input: {
  dispatch?: TaskDispatchView | undefined;
  clientDispatch?: TaskClientDispatchView | undefined;
  lastRunAt?: string | undefined;
}): DeckRunBadge | undefined {
  const fromAgent = input.dispatch === undefined
    ? undefined
    : { at: input.dispatch.started_at, badge: AGENT_BADGE[input.dispatch.status] };
  const fromWindow = input.clientDispatch === undefined
    ? undefined
    : { at: input.clientDispatch.at, badge: input.clientDispatch.status === 'failed' ? '失败' as const : '在做' as const };

  const newest = fromAgent === undefined
    ? fromWindow
    : fromWindow === undefined
      ? fromAgent
      : (fromWindow.at > fromAgent.at ? fromWindow : fromAgent);

  if (input.lastRunAt === undefined) return newest?.badge;
  if (newest === undefined || newest.at < input.lastRunAt) return '排队';
  return newest.badge;
}

/**
 * 这一态那颗按钮底下那行小字:**他按下去之前该知道会发生什么**。
 * 与电脑端 `FEATURE_RUN_HINT` 逐字相同(那边也是对他说的第二人称)。
 */
export const FEATURE_RUN_HINT: Readonly<Record<FeatureStage, string>> = {
  梳理: '把你那一句话问清楚(最多两问),写成需求:目标 / 边界 / 验收标准',
  拆解与派活: '拆成几件事,标好哪件给 Codex、哪件给 Claude,然后一键派出去',
  验收: '把每件回来的结果收成一段摘要,等你说通过还是打回',
  记录: '把这件事的结论写成一条,你点一下就进项目的决策记录',
};

/** 那颗大按钮上写的字。四态同一句 —— 一颗按钮 = 推一态,做完等他把关。 */
export const FEATURE_RUN_BUTTON = '让事务官推进这一步';

/** 「记录」那一态多出来的那一颗。 */
export const FEATURE_RECORD_BUTTON = '写进决策记录';

/**
 * ★ **发版**那一颗(2026-09-23,「同一个事务官」+ 中秋目标第一节第 5 步)。
 *
 * 一颗键 = 全量测试 → ff 合并 main → 跑发版脚本 → 触发热更新。
 * **这是手机上最重的一下**,所以它是这一页唯一一颗**要按两次**的键:
 * 第一次只把那句话摆出来,第二次才真发。
 *
 * 为什么用二次确认而不是"手机上不给按":Ben 2026-09-23 的原话是
 * 「不是两个人,更不是两个权限不同的人」—— 重的动作靠**她看清楚了再点一下**,
 * 不靠端口把她自己挡在外面(docs/设计-同一个事务官-2026-09-23.md 第四节)。
 */
export const FEATURE_SHIP_BUTTON = '发版';

/** 二次确认上那句话。**把会发生的事说全**:合并、发版,两件都写出来。 */
export const FEATURE_SHIP_CONFIRM = '会合并并发一版,确定?';

/** 确认之后那颗真发的键。 */
export const FEATURE_SHIP_GO = '确定,发版';

/**
 * 「打回」**必须带一句话**,而且在手机这一侧就拦住。
 *
 * 服务端那边也拦(400,一个字节都不送出去),这里再拦一道的理由只有一个:
 * 手机在外面可能正走着房间代理那条路,一次白跑的往返要等好几秒 ——
 * 而「你还没写那一句」是手机自己就知道的事。
 */
export function reviewBlocked(action: 'pass' | 'revise' | 'self', text: string): string | undefined {
  return action === 'revise' && text.trim() === '' ? '打回要带一句话:哪儿不对' : undefined;
}

/** 一份产物没有时说哪句话。**「没有这份」与「这份是空的」是两件事**,分开说。 */
export function docNote(doc: DeckDocView | undefined): string | undefined {
  if (doc === undefined) return '还没读到这一份';
  if (doc.error !== undefined) return doc.error;
  if (!doc.exists) return `还没有 ${doc.file} —— 这一步事务官还没做`;
  if ((doc.text ?? '') === '') return `${doc.file} 是空的`;
  return undefined;
}

/** 这一份这一轮有没有真改动(diff 里除了 `same` 还有别的)。 */
export function deckHasChange(rows: readonly DeckDiffRow[] | undefined): boolean {
  return rows !== undefined && rows.some((row) => row.kind !== 'same');
}

/**
 * 这一趟走的是哪条路,写给他看。
 *
 * 这一句**不是**状态,是上一次请求的事实:`routedClient` 的模式在每条请求之后才更新
 * (它拿真请求当探子,不另发心跳)。所以界面上写的是「刚才那一条走的是…」。
 */
export const ROUTE_TITLES: Readonly<Record<'direct' | 'remote' | 'offline', string>> = {
  direct: '局域网直连',
  remote: '经房间代理',
  offline: '够不到电脑',
};
