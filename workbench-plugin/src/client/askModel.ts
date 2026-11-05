/**
 * 她要问你的话、要你批的事 —— 电脑这一侧的几个纯函数(2026-09-25,卡 M)。
 *
 * 判断都在工作台服务端(文字已经收拾好、审批已经翻成人话);这里只管:
 *   1. **「等你 n」只有一个数**(维护者规矩:同一件事各处数字一致)—— 在 `src/waiting.ts`(`waitingOf`),这里转出去;
 *   2. 事项里「她说了什么」那一段:他说的话只留他的原话(后面我们替他交代给她的那几句不露)。
 */
/**
 * 「等你」那一堆与那几行字全在 `src/waiting.ts`(服务端也要算:手机只读服务端算好的那一格)。
 * 这里转出去,老的 import 不用改。
 */
export { approvalOptionName, approvalRowText, askSubject, clip, confirmRowText, dispatchApprovalFace, questionRowText, waitingOf, waitingOnHim } from '../waiting.ts'
import { plainForHim } from '../plainText.ts'
import type { HelperView } from '../protocol.ts'

/**
 * 事项里他说的那一句,只留他的原话。
 *
 * 工作台把他的话交给她时后面接了几句交代(「这件按「先问我」办……」「他附了文件……」「(工作台事项 t-…)要背景时……」)
 * —— 那是说给她听的,不是他说的,摆出来就是把底层露给他看(维护者规矩第 3 条)。从第一句交代起整段不要。
 */
const OUR_TAIL_MARKERS = ['这件按「', '他附了文件', '他引用了', '(工作台事项', '(工作台事项', '<system-reminder>', '要背景时再按', '他点名要']

export function hisWords(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const cut = lines.findIndex(line => OUR_TAIL_MARKERS.some(marker => line.trimStart().startsWith(marker)))
  const kept = (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim()
  return kept
}

/**
 * 她的话里那几种记号去掉 —— 同 /state 那一个出口(src/plainText.ts 的 plainForHim,卡 M 补):服务端发出来的已经洗过,
 * 这里再过一遍是给老服务兜底(洗过的再洗一遍不变)。
 */
export function plainTalk(text: string): string {
  return plainForHim(text)
}

/** 这件事此刻在哪一步(给事项里那一段的第一行)。 */
export function talkStatus(input: { questions: number, approvals: number, sessionStatus?: string, taskStatus?: string }): string {
  if (input.questions > 0) return '停下来在等你回答'
  if (input.approvals > 0) return '停下来在等你批一件事'
  if (input.taskStatus === 'confirm') return '办完了,等你看一眼'
  if (input.taskStatus === 'done') return '这件事已经收了'
  if (input.taskStatus === 'canceled') return '这件事取消了'
  if (input.sessionStatus === 'running') return '正在办'
  if (input.sessionStatus === 'error') return '这一轮出错停下了'
  if (input.sessionStatus === 'offline') return '这会儿不在线'
  return '在这件事上'
}

/**
 * 系统通知出了问题时事务官说的那一句(2026-09-25,卡 M 补;统筹:以前静默失败,维护者说点了「允许」却一条都没看到)。
 * 只在真出了问题时说(`/state.helper.notify`):
 *   - 系统那边没让发(没点允许 / 后来关了 / 系统没收下)→ 说去系统设置哪一页,给一键打开(`settings: true`);
 *   - 根本没交到壳手上(老壳不会弹、壳没接上 / 没回话)→ 照实说,不指去系统设置(那儿改不好)。
 * 没出问题、或者老服务没报,就不说(不为一件没发生的事占一行)。
 */
export function notifyTrouble(helper: HelperView | undefined): { text: string, settings: boolean } | undefined {
  const notify = helper?.notify
  if (notify === undefined) return undefined
  const post = notify.last_post
  if (post !== undefined && !post.ok && post.error !== undefined && /壳/.test(post.error)) {
    return { text: `我弹不了系统通知:${post.error}`, settings: false }
  }
  if (notify.permission === 'denied' || (post !== undefined && !post.ok)) {
    return { text: '系统没让我弹通知:去系统设置 → 通知里打开「工作台」', settings: true }
  }
  return undefined
}
