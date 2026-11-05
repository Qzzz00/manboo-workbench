/**
 * 给他看的字只有一个出口(2026-09-25,卡 M 补;统筹真壳:事项对话里她回的「**B**」,电脑「在工作台里看」、
 * 手机事项页里原样露出了 `**`)。
 *
 * 维护者规矩第 3 条:不露内部的东西(星号这类记号、英文键名……)。事务官和别家 AI 说话爱带 markdown
 * (`**加粗**`、反引号、`#` 标题、`*` 列表),以前哪一处想起来哪一处自己去掉一点(电脑事项里那段洗了、字幕没洗、
 * 事项页的「回答」没洗),漏一处就露一处。现在:
 *   - `plainForHim`:一段话 → 给他看的纯文字。记号去掉、字留着(代码块里的内容也留着,只去掉围栏);
 *   - `stateForHim`:工作台发出去的那一份 /state 里**她和别家说的话**都过一遍(会话最近一句、事项的回答、
 *     派给别家收回来的回答、收件箱里抄的那一句)—— 电脑、手机、展示台读的都是洗过的,各端不用再各洗各的;
 *   - 事项对话(`GET /butler/item/:id/turns`)、她问他的话、要他批的理由也走 `plainForHim`。
 * 落盘的原话不动(派活回读、给别家的指令还要用原样的),只在「交给他看」这一步洗。
 *
 * 放在 src/ 根上:服务端和电脑页面都用(同 waiting.ts、protocol.ts)。手机只读服务端洗好的。
 */
import type { WorkbenchState } from './protocol.ts'

export function plainForHim(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    // 代码块:围栏去掉,里面的字留着。
    .replace(/^[ \t]*```[^\n]*\n?/gm, '')
    // 行内代码 / 加粗 / 下划线加粗 / 删除线:记号去掉,字留着。
    .replace(/`{1,3}([^`\n]+?)`{1,3}/g, '$1')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/__([^_\n][\s\S]*?)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    // 单星号的强调:只认两边挨着空白 / 标点 / 行头行尾的(「2*3*4」这种不动)。
    .replace(/(^|[\s(（「『,，。:：;;!！?？])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?=$|[\s)）」』,，。:：;;!！?？])/gm, '$1$2')
    // 图片、链接:留说明文字,不留地址。
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    // 行首的标题井号、引用号;星号 / 加号列表换成「·」;分隔线整行去掉。
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^([ \t]*)[*+][ \t]+/gm, '$1· ')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    // 落单的加粗记号(没配上对的)。
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 可缺的一句:有就洗,洗完空了就当没有。 */
function cleanOpt(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const out = plainForHim(text)
  return out === '' ? undefined : out
}

/**
 * 发给各端的那一份 /state 里,她和别家说的话都过一遍 {@link plainForHim}。只碰这几格:
 *   - `sessions[].summary`(会话最近一句;手机字幕念的就是它);
 *   - `tasks.tasks[].deliverables[]` 里 `reply` 那一种的 `ref`(事项上的「回答」);
 *   - `tasks.tasks[].dispatch.reply` / `client_dispatch.reply`(派给别家收回来的回答);
 *   - `butler_inbox.items[].summary`(收件箱抄的会话最近一句)。
 * 别的字(标题、他自己说的话、路径、会议纪要这种本来就按 markdown 摆的)不动。原对象不改。
 */
export function stateForHim(state: WorkbenchState): WorkbenchState {
  const sessions = state.sessions.map(session => session.summary === undefined
    ? session
    : withOpt(session, 'summary', cleanOpt(session.summary)))
  const tasks = state.tasks === undefined ? undefined : {
    ...state.tasks,
    tasks: state.tasks.tasks.map((task) => {
      let next = task
      if (task.deliverables !== undefined && task.deliverables.some(one => one.kind === 'reply')) {
        next = { ...next, deliverables: task.deliverables.map(one => (one.kind === 'reply' ? { ...one, ref: plainForHim(one.ref) } : one)) }
      }
      if (task.dispatch?.reply !== undefined) next = { ...next, dispatch: withOpt(task.dispatch, 'reply', cleanOpt(task.dispatch.reply)) }
      if (task.client_dispatch?.reply !== undefined) next = { ...next, client_dispatch: withOpt(task.client_dispatch, 'reply', cleanOpt(task.client_dispatch.reply)) }
      return next
    }),
  }
  const inbox = state.butler_inbox === undefined ? undefined : {
    ...state.butler_inbox,
    items: state.butler_inbox.items.map(item => (item.summary === undefined ? item : withOpt(item, 'summary', cleanOpt(item.summary)))),
  }
  return {
    ...state,
    sessions,
    ...(tasks === undefined ? {} : { tasks }),
    ...(inbox === undefined ? {} : { butler_inbox: inbox }),
  }
}

/** 换掉一格可缺的字:洗完没了就去掉那一格(exactOptionalPropertyTypes 下不写 undefined)。 */
function withOpt<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const copy = { ...value }
  if (next === undefined) delete copy[key]
  else copy[key] = next
  return copy
}
