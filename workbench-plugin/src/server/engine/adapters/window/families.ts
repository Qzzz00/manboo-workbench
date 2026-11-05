/**
 * **窗口型那几家的差异表**(2026-10-02,卡 AW-窗口适配器;`docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节)。
 *
 * 维护者 10-02:「嘴上说着不打补丁,结果全是打补丁」。打补丁的样子是:同一件事(送一句话进别家窗口)
 * 在 `sessionAnswer` 的六只手、`dispatchClient.sendOnce`、`dispatchRun.checkWindow`、`relayWatch.pump`
 * 里各写一遍,每撞一次真机就在**那一条**上加一层。
 *
 * 这一份是反过来的做法:**逻辑只有一份**(`../window.ts`),家与家的差别收成这张表里**每家几行**。
 * 新接上一家(Grok Bot、Antigravity 这种运行时发现的)**一行都不用加** —— 表外的一家走
 * {@link WINDOW_FAMILY_DEFAULT},那才是「不写死」。
 *
 * ## 查实之后,真正的差别只剩一样:能不能开到**某一段**对话
 *
 * 10-02 逐条读了那四个文件,原来以为的「每家一套」大半不是家的差别:
 *
 * | 以为的差别 | 查实 | 落在哪 |
 * |---|---|---|
 * | 豆包要先开新对话 | **不是豆包的事,是「派活」这一种的事**:卡 DB 在豆包上撞见,但 `dispatchRun` 对**每一家**都发 `new_conversation:true`(不然会打进她正开着的那条对话);壳不会这件本事就不送 | 按 `JobKind` 判,不进这张表 |
 * | 豆包办公读回话要读两次 | 真的,但那一份判断已经在 `readRelayEvidence` 一处(`com.work.pc.doubao` 认不出就再读整扇窗) | 复用那一个函数 |
 * | Kimi 自绘输入框 | 真的,但**不是 Kimi 一家的事**(Compose / Flutter / 自画 canvas 那一类都长这样):`judgeStructure` 现查出 `mode:'paste_only'`,送话走壳内部那条粘贴的退路,按名字找键的那几下一律说不行 | `agentJudge.judgeStructure` 现查,不进这张表 |
 * | Manus 侧栏点行 | 没有深链的**每一家**都这样(`agent_pick`),不是 Manus 一家 | 缺省行 |
 * | Codex 深链 / Claude 深链 | **真的是家的差别**:链的写法不同,而且 Claude 那条要桌面 App 里的编号(`local_…`),读不到就没有深链 | 这张表的 {@link WindowFamilyRow.deepLink} |
 * | 一家多包(豆包三个) | 真的,但挑哪一个由 `agentSources.pickFamilyPackage` 一处说了算 | 复用那一个函数 |
 *
 * 所以这张表里只有 `deepLink` 一格是**会执行的**差别;`note` 那一格不执行,它回答
 * 「这一家到底差在哪、出处在哪」——以前这句话散在四个文件的注释里,查一家要翻四处。
 */

/** 一家几行。`deepLink` 之外都是**说明**:执行的差别只有那一格。 */
export interface WindowFamilyRow {
  /** 家名(登记表 id)。运行时发现的那几家家名就是包标识。 */
  family: string
  /**
   * **开到某一段对话的深链**。回 `undefined` = 这一次开不了(要的那个编号读不到)——
   * 那就退回「侧栏点一下 / 叫到台前」,不假装开到了那一段。
   */
  deepLink?: (target: { sessionId: string, hostId?: string }) => string | undefined
  /** 这一家差在哪(真机出处;给交接与新接手的人看,不参与判断)。 */
  note: string
}

/**
 * **表外的一家**(Grok Bot `com.anysphere.sand`、Antigravity `com.google.antigravity`、
 * 以及下一家运行时接上的):没有深链 → 开到某一段只能在侧栏里点那一行(`agent_pick`),
 * 叫到台前兜底。**这不是退化,这是窗口型的常态** —— 有深链的才是特例(两家)。
 */
export const WINDOW_FAMILY_DEFAULT: WindowFamilyRow = {
  family: '',
  note: '没有深链:开到某一段对话只能在侧栏里点那一行(agent_pick);送 / 读都按通用窗口型那一套',
}

export const WINDOW_FAMILIES: readonly WindowFamilyRow[] = [
  {
    family: 'claude',
    /*
     * Claude 桌面 App 自己「继续上一段 Code 会话」用的就是这条链,**它只认 `local_…`**
     * (桌面 App 里那个编号,从 `~/.claude/sessions/<pid>.json` 的 `hostSessionId` 读),
     * 不认会话文件的 id —— 读不到编号就回 undefined(2026-09-27 真机查实)。
     */
    deepLink: ({ hostId }) => (hostId === undefined || hostId.trim() === ''
      ? undefined
      : `claude://code/continue?session=${encodeURIComponent(hostId)}`),
    note: '有深链,但要桌面 App 里那个 local_… 编号;读不到编号就只剩侧栏点一下(真机上这棵辅助功能树一次都没认出过那段对话,所以认不出也照发)',
  },
  {
    family: 'codex',
    /** Codex 的会话 id 就是 threadId,不用另读编号。 */
    deepLink: ({ sessionId }) => (sessionId.trim() === ''
      ? undefined
      : `codex://threads/${encodeURIComponent(sessionId)}`),
    note: '有深链(会话 id 就是 threadId,不用另读编号)。窗口只是第二条路 —— 它真正的通道是 codex app-server 协议',
  },
  {
    family: 'doubao',
    note: '一家三个包(com.bot.pc.doubao / com.work.pc.doubao / com.bot.neotix.doubao):挑哪一个问 pickFamilyPackage,送不进去再换一个。没有会话记录文件 —— 证据只能读窗(豆包办公那一个 read_reply 常认不出,readRelayEvidence 里对它多读一次整扇窗)',
  },
  {
    family: 'kimi',
    /*
     * ★ 2026-10-02 卡「适配自绘界面的 Kimi」合进来之后,这一行**只剩一个指针**:
     * 「自绘界面」不是 Kimi 一家的事(Compose / Flutter / 自画 canvas 那一类都长这样),
     * 所以它**不写在这张表里**,而是 `agentJudge.judgeStructure` 现查出来的那一格
     * (`structure.mode === 'paste_only'`)—— 适配器用 `deps.structureMode` 问它。
     * 下一家自绘的 App 接上来,这张表一行都不用加。
     */
    note: '官网 kmp 版整个界面自绘(文字读得到、输入框与发送键画成 AXUnknown);这一档由 agentJudge.judgeStructure 现查(mode: paste_only),不写死在这张表里 —— 送话靠壳内部那条「点一下 + 粘贴 + 回车」,按名字找键的那几下一律说不行',
  },
  {
    family: 'manus',
    note: '没有深链,已有对话靠侧栏点行;没有会话记录文件,证据只能读窗',
  },
  {
    family: 'muse',
    note: '没有深链,已有对话靠侧栏点行;没有会话记录文件,证据只能读窗',
  },
]

/** 这一家那几行;表外的一家回缺省行(家名填上她自己的)。 */
export function windowFamilyRow(family: string): WindowFamilyRow {
  return WINDOW_FAMILIES.find(one => one.family === family) ?? { ...WINDOW_FAMILY_DEFAULT, family }
}

/**
 * 这一次开到那一段的深链。没有深链的家、或者要的编号这会儿读不到 → `undefined`
 * (**退回侧栏点一下 / 叫到台前**,不编一条链)。
 */
export function windowDeepLink(family: string, target: { sessionId: string, hostId?: string }): string | undefined {
  return windowFamilyRow(family).deepLink?.(target)
}
