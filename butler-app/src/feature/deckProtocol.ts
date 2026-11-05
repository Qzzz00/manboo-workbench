/**
 * 指挥台那几样的**只读子集**(2026-09-23,中秋断点 A)。
 *
 * 权威定义在 `workbench-plugin/src/protocol.ts`(`FeatureStage` / `FEATURE_DOC_TABS` /
 * `DeckReviewEntry` / `DeckDocView` …),这里是手机用得到的那一小块,**字段名一字不改**。
 * 与 `src/api/protocol.ts` 同一条规矩:手机不认识的字段一律忽略,服务端多给不会坏。
 *
 * 为什么抄一份而不是 import:两个顶层子目录各自独立的技术栈、互不 import(AGENTS.md
 * 「仓库结构」那一节)。抄的代价是"两份会漂",所以抄的只有**值域与名字**,
 * 一条判断都不抄 —— 判断都在工作台(C2)。
 */

/** 一条需求走的四态。与工作台 `FEATURE_STAGES` 逐字相同。 */
export type FeatureStage = '梳理' | '拆解与派活' | '验收' | '记录';

export const FEATURE_STAGES: readonly FeatureStage[] = ['梳理', '拆解与派活', '验收', '记录'];

export const DEFAULT_FEATURE_STAGE: FeatureStage = '梳理';

/** 卡里那一排产物页签。四个,与四态一一对应。 */
export type FeatureDocTab = '需求' | '子事项' | '验收' | '记录';

export const FEATURE_DOC_TABS: readonly FeatureDocTab[] = ['需求', '子事项', '验收', '记录'];

/**
 * 每一态**先铺开**哪几个页签。
 * 与电脑端同一条分寸:只决定"先翻到哪个",不决定"能看哪个" —— 四个页签一直都在。
 */
export const FEATURE_STAGE_TABS: Readonly<Record<FeatureStage, readonly FeatureDocTab[]>> = {
  梳理: ['需求'],
  拆解与派活: ['子事项'],
  验收: ['验收'],
  记录: ['记录'],
};

/** 把关三键 + 另外两件也写进同一份留痕的事(`run` / `record`)。 */
export type DeckReviewAction = 'pass' | 'revise' | 'self' | 'run' | 'record';

/** 卡上真正画出来的那**三颗**。 */
export const DECK_REVIEW_ACTIONS: readonly DeckReviewAction[] = ['pass', 'revise', 'self'];

/**
 * 三键在手机上写什么。**存的是英文 id、显示的是中文**(同电脑端)。
 *
 * ★ 措辞与电脑端有一处**故意不同**:电脑上第二颗叫「改一改」,手机上叫「打回」——
 * 任务书第 2 条逐字要求的是「通过 / 打回(带一句话)/ 我自己改」。
 * 盘上写下去的仍然是 `revise` 那个 id,所以两边看到的是同一条历史。
 */
export const DECK_ACTION_TITLES: Readonly<Record<DeckReviewAction, string>> = {
  pass: '通过',
  revise: '打回',
  self: '我自己改',
  run: '让事务官推进',
  record: '写进决策记录',
};

/** `审核记录.jsonl` 里的一行。一行一条,追加,永不改写。 */
export interface DeckReviewEntry {
  at: string;
  tab: string;
  action: DeckReviewAction;
  /** 「打回」时他说的那一句;`run` 时额外补的那一句(可缺)。 */
  text?: string;
  stage?: string;
  /** 这一次是不是事务官代做的(只有 `run` 那一条有意义)。 */
  standin?: boolean;
}

/** 段落级 diff 的一行。手机只读,拿它画「这一轮改了什么」。 */
export interface DeckDiffRow {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** 一个页签此刻的现状。 */
export interface DeckDocView {
  tab: FeatureDocTab;
  /** 文件名(`需求.md`)。**始终有**:他要知道东西落在哪个名字上。 */
  file: string;
  /** 文件在不在。**不在不是错**:那一段还没做而已。 */
  exists: boolean;
  /** 全文。文件不在时缺席(**不给空字符串**)。 */
  text?: string;
  updated_at?: string;
  diff?: readonly DeckDiffRow[];
  error?: string;
}

/** 派活小标的四档。 */
export type DeckRunBadge = '排队' | '在做' | '回来了' | '失败';

/** `POST /feature/docs` 的回包。 */
export interface FeatureDocsBody {
  ok: true;
  /** 需求目录(她仓库里的绝对路径)。手机上只显示,不据此做任何判断。 */
  dir: string;
  stage: FeatureStage;
  project: string;
  project_path: string;
  docs: readonly DeckDocView[];
  reviews: readonly DeckReviewEntry[];
}
