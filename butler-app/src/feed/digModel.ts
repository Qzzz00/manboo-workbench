/**
 * 「就这一条资讯深聊」的只读契约与纯函数(2026-10-13,卡「播客页重做」★3 / ★4)。
 *
 * 维护者原话:「我点击之后,可以打断正在播放的播客,我可以与事务官针对这条信息进行深入挖掘和
 * 交流,文字和语音两种选项,语音可以是按住说话的那种,也可以是通话,聊完之后的结论同步到电脑的
 * 随手记,如果需要形成待办的则做成事项卡出现在项目区的看板里,要带上来源于」。
 *
 * **文字与按住说话是同一条路**:按住说话转出来的字,和她打的字走同一个 `send` ——
 * 两条路各走一遍,迟早有一条长歪(交接-0917 把按住说话抽成 hook 时同一个理由)。
 *
 * **来源那一行不在这里拼**:随手记与事项卡上那一行由 8791 按 `protocol.ts` 的记号拼
 * (`feedNoteTextOf` / `feedTaskDescOf`),手机只发「哪条 + 一句话」。写与读只认一处记号。
 */

/** 深聊里的一个回合。`her` = 她说的,`butler` = 事务官答的。 */
export interface DigTurn {
  who: 'her' | 'butler';
  text: string;
  /** 这一句是**按住说话**转出来的(界面上标一下,她知道识别成了什么)。 */
  spoken?: true;
}

/** 面板上那条对话的状态。 */
export interface DigThread {
  /** 聊的是哪条资讯。 */
  item_id: string;
  turns: DigTurn[];
}

/** 一次最多把几个回合发上去。与服务端 `DIG_MAX_TURNS` 同一个数(那边也会再截一次)。 */
export const DIG_MAX_TURNS = 12;

/** 发给 8791 的那几轮(去掉界面自己的字段,只留 who / text)。 */
export function turnsForServer(turns: readonly DigTurn[]): { who: 'her' | 'butler'; text: string }[] {
  return turns.slice(-DIG_MAX_TURNS).map(one => ({ who: one.who, text: one.text }));
}

/**
 * 「存成随手记」那一栏里先摆什么。
 *
 * 顺序:模型收的那一句(`conclusion`)→ 事务官最后答的那一句 → 她最后说的那一句 → 空。
 * **不自己编**:一句都没聊过时就是空的,让她自己写 —— 摆一句我们编的「结论」比空着更坏。
 */
export function conclusionDraft(turns: readonly DigTurn[], conclusion?: string): string {
  const said = (conclusion ?? '').trim();
  if (said !== '') return said;
  const butler = [...turns].reverse().find(one => one.who === 'butler');
  if (butler !== undefined) return butler.text.trim();
  const her = [...turns].reverse().find(one => one.who === 'her');
  return her === undefined ? '' : her.text.trim();
}

/** 面板顶上那一行副标题:来源 · 项目。两样都没有就空串(不占位)。 */
export function digMetaLine(input: { source?: string; project_name?: string }): string {
  return [input.source, input.project_name]
    .filter((one): one is string => one !== undefined && one.trim() !== '')
    .join(' · ');
}
