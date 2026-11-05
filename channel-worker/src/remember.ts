/**
 * 电话里「记下来」那一件的纯函数(2026-09-23,`fix/call-remember-direct`)。
 *
 * ## 由来
 *
 * 12:39 那一通里维护者说「用户可以给我提需求说希望这个声音沉稳一些,把这件事记下来」。
 * 她调了旧的 `wb_remember_item` —— 那一件走 `POST /butler/item`,**建卡 + 在 DSH 里开一条会话**。
 * 那条会话为了「记一句话」读了记忆索引、授权、决策记录、tasks.json,约 30 次工具调用,
 * 吃掉 35 万 token,把中转当天额度撞满,之后通话里她一句都回不了。
 *
 * ## 这一版的分工(工具名表达,不靠关键词猜)
 *
 *   wb_remember_item  **只记**:`POST /task/create` 建一张卡,**不开会话**,卡上标「未确认」;
 *   wb_dispatch_item  **交给事务官去办**:`POST /butler/item`(建卡 + 开会话),过确认点那道门。
 *
 * 「记」不过确认点那道门:维护者 09-23 13:05 定的是「他说『先记着』= 只建卡不派,卡上标未确认」,
 * 记下来正是那一支 —— 门拦的是**派活**,不是**记**。
 */
import { UNCONFIRMED_MARK, unconfirmedDesc } from './confirm.ts'

/**
 * ★ **「记到日历 / 记进发布计划」不是派活**(2026-10-13 下午,卡 B′)。
 *
 * 场景 4 那一通:她说「你帮我记到日历上面去啊?」—— 8791 没认出来,模型先编了一件不存在的
 * `wb_calendar_add`,再拿 `wb_dispatch_item` 建了张**没负责人**的卡说「我去办」,
 * 那张卡被电脑上的事务官自己接去跑了 6 分钟、51 步、¥0.51,而月历上一条都没多。
 *
 * 所以派活那件工具门口认一次这几个字:认出来就**当场拦回**,指到 `wb_publish_plan`
 * (打 8791 的 `POST /publish/plan`)。判字只认**明说**的那几种,宁可漏拦 ——
 * 拦错一句真要办的事,她那件事就没人办了。
 *
 * 工作台那头另有一道同样意思的门(`workbench-plugin/src/server/understand.ts` 的
 * `looksLikeNoteOnly`:没点名又明说记一笔的,卡照建、不开事务官那条会话)。
 * 这一张照抄源头那一份;顶层子目录互不 import(AGENTS.md),两边逐字相同由
 * `channel-worker/tests/calendar-note-sync.test.ts` 钉着(它读插件源码比对,漂了那条红)。
 */
export const CALENDAR_NOTE = /记(?:到|进|在|上)(?:我的)?(?:日历|月历|发布计划)|(?:加|排)(?:到|进)(?:我的)?(?:日历|月历|发布计划)|发布计划里?(?:记|加|排)/u

/** 她明说的是「把这条记到日历 / 记进发布计划」吗。 */
export function looksLikeCalendarNote(said: string): boolean {
  const text = (said ?? '').trim()
  return text !== '' && CALENDAR_NOTE.test(text)
}

/** 卡面标题的字数上限。与 8791 `butlerItemFields` 的 MAX_TITLE 同一个数(两边不互相 import)。 */
export const NOTE_TITLE_MAX = 40

/**
 * 一句原话 → 一张卡的标题与描述。
 *
 * 标题取第一行、超长截断;**全文一个字都不丢**,落在 desc 里,后面跟「未确认」那个记号。
 */
export function noteFields(text: string): { title: string, desc: string } {
  const full = text.trim()
  const firstLine = (full.split('\n')[0] ?? '').trim()
  const title = firstLine.length > NOTE_TITLE_MAX ? `${firstLine.slice(0, NOTE_TITLE_MAX)}…` : firstLine
  return { title, desc: unconfirmedDesc(full) }
}

/**
 * 记成了。回给模型的那一句。
 *
 * **不许说「我让事务官去办了」** —— 这一件压根没开会话,说了就是一件没发生的事(D13)。
 */
export function rememberedText(): string {
  // 2026-10-02:回给模型的这一句**不念系统词**(待办 / 卡 / 看板),也不把自己说成第三个人。
  return `记下了(还没动手办,标着「${UNCONFIRMED_MARK}」)。`
    + '跟她说一句「记下了」就收 —— **不要说「我去办了」**,也别念「看板」「待办」「卡」。'
    + '她要是接着说「那你去办」,再调 wb_dispatch。'
}

/**
 * 没记成。把底下那一层的原话带上,再钉死「如实说没记上」。
 *
 * 403 时底下那句里已经带着「去 `docs/记忆/授权.md` 改哪一行」,原样保留。
 */
export function notRememberedText(reason: string): string {
  return `没记上。${reason.trim()}\n**如实告诉他这条没记上**,不许说「记下了」,更不许说「我记在脑子里」。`
}
