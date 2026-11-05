/**
 * 多账号:一个账号一个浏览器档案(2026-09-22)。**除了一个 readdir 之外没有 I/O。**
 *
 * Ben 原话:「我想直接验证多账号的数据汇总,现在你打开的网页已经登录好一个了,
 * 再开一个纯净的,我登录第二个账号」。
 *
 * ## 为什么是「一个账号一个档案」而不是「一个档案里切换账号」
 *
 * 小红书创作者中心在同一个浏览器档案里只有一个登录态 —— 登第二个号会把第一个挤掉。
 * 要同时拿到两个账号的数,只能开两个互相独立的 Chrome 用户档案。这也正好接着
 * Kimi 网页登录那套(`login-profile-<provider>`)的命名与 `openProfileWindow`,
 * 不新造一套。
 *
 * | 第几个 | 档案目录名 |
 * |---|---|
 * | 1 | `login-profile-xhs_creator` ←**保持不变**,9/21 那一版登的那个号不用重登 |
 * | 2 | `login-profile-xhs_creator-2` |
 * | N | `login-profile-xhs_creator-N` |
 *
 * ## 这一份数据是谁的
 *
 * 归属**只认从首页读回来的东西**:账号名(页面顶部)与「小红书账号: <数字 id>」。
 * id 是稳定机器键(改昵称不影响),名字是给人看的。两样都读不到时,界面就叫它
 * 「账号 N」(N = 档案序号)——**不编一个名字**,也不拿档案目录名冒充昵称。
 *
 * ## 与运营模板 `<工作目录>/账号/<名>/` 的关系:**按名字匹配,匹配不上就单列**
 *
 * 那边的「账号」是 Ben 自己建的文件夹(定位/风格/人群),这边的「账号」是一个登录态。
 * 两边**不强绑**:名字一样就认作同一个、在界面上挂个钩;名字对不上就各归各的
 * (他可能还没建那个文件夹,也可能文件夹名和小红书昵称本来就不一样)。
 * 强绑的代价是"改个昵称数据就不见了",那比"少一个钩子"糟得多。
 */
import { readdir } from 'node:fs/promises'

/** 第一个档案的名字。**9/21 那一版就是它**,不能改 —— 改了 Ben 要重登一次。 */
export const XHS_PROFILE_NAME = 'login-profile-xhs_creator'

/** 第 N 个档案叫什么。N=1 回不带后缀的那个(兼容)。 */
export function xhsProfileName(index: number): string {
  return index <= 1 ? XHS_PROFILE_NAME : `${XHS_PROFILE_NAME}-${index}`
}

/** 档案目录名 → 第几个。不是这一族的名字回 undefined。 */
export function xhsProfileIndex(name: string): number | undefined {
  if (name === XHS_PROFILE_NAME) return 1
  const match = new RegExp(`^${XHS_PROFILE_NAME}-(\\d+)$`).exec(name)
  if (match === null) return undefined
  const index = Number(match[1])
  return Number.isInteger(index) && index >= 2 ? index : undefined
}

/**
 * 盘上现在有哪几个档案(`~/.dsh/workbench/` 下面扫一遍)。
 *
 * **只读目录名,不进去看一眼** —— 档案目录里是 Chrome 自己的东西(含登录态),
 * 这条路一个字都不读。目录不存在 = 还没登过,回空数组,不是错误。
 */
export async function listXhsProfiles(root: string): Promise<number[]> {
  let names: string[]
  try { names = await readdir(root) }
  catch { return [] }
  const out = names
    .map(name => xhsProfileIndex(name))
    .filter((index): index is number => index !== undefined)
  return [...new Set(out)].sort((a, b) => a - b)
}

/** 从首页读回来的身份。两样都可能读不到。 */
export interface XhsAccountIdentity {
  /** 页面顶部那个账号名(昵称)。 */
  name?: string
  /** 「小红书账号: <数字>」里那串。稳定机器键。 */
  uid?: string
}

/**
 * 「小红书账号: 1234567」或「小红书账号: Cici1878…」。小红书号可以被用户改成字母数字混排
 * (2026-09-22 Ben 的第二个号就是),所以认字母、数字、下划线、点、横线;别的形状宁可读不到。
 */
const UID_LINE = /小红书账号[\s:：]*([A-Za-z0-9_.-]{3,})/

/**
 * 往上找账号名时要跳过的词。页面顶部在账号名与「小红书账号」之间还夹着
 * 关注数 / 粉丝数 / 获赞与收藏,以及一堆导航字样。
 */
const NAME_STOP_WORDS = [
  '关注', '粉丝', '获赞', '收藏', '笔记', '直播', '数据', '总览', '统计', '周期',
  '环比', '创作', '发布', '首页', '登录', '退出', '消息', '通知', '服务', '平台',
  '中心', '学院', '管理', '灵感', '账号',
] as const

/**
 * 从首页文字里读账号名与 id。
 *
 * id:直接认「小红书账号」那一行,**硬**。
 * 名字:从那一行**往上**找最近的一行,跳过纯数字、跳过上面那串导航词、长度 1–24 ——
 * 这一条是**best-effort**,读不到就没有名字(界面显示「账号 N」),**绝不编一个**。
 *
 * @param nicknameLabels - `xhs-selectors.json` 里可以配的「昵称跟在哪个词后面」。
 *   配了就**优先**用它 —— 一份手改的配置胜过一条启发式规则。
 */
export function accountIdentityFrom(
  pageText: string,
  nicknameLabels: readonly string[] = [],
): XhsAccountIdentity {
  const lines = pageText.split('\n').map(line => line.trim()).filter(line => line !== '')

  let uid: string | undefined
  let uidLine = -1
  for (const [index, line] of lines.entries()) {
    const match = UID_LINE.exec(line)
    if (match === null) continue
    uid = match[1]
    uidLine = index
    break
  }

  // ① 手配的标签优先。
  for (const label of nicknameLabels) {
    for (const [index, line] of lines.entries()) {
      const at = line.indexOf(label)
      if (at < 0) continue
      const sameLine = line.slice(at + label.length).replace(/^[:：\s]+/, '').trim()
      if (sameLine !== '') return { name: sameLine, ...(uid === undefined ? {} : { uid }) }
      const next = lines[index + 1]
      if (next !== undefined && next !== '') return { name: next, ...(uid === undefined ? {} : { uid }) }
    }
  }

  // ② 没配就从「小红书账号」那一行往上找。找不到就是没有。
  if (uidLine > 0) {
    for (let index = uidLine - 1; index >= 0 && index >= uidLine - 8; index--) {
      const line = lines[index] ?? ''
      if (line.length === 0 || line.length > 24) continue
      // 纯数字 / 数字带单位 / 百分比 —— 那是关注数粉丝数那一排。
      if (/^[+-]?[\d.,]+\s*(?:万|亿|千|%)?$/.test(line)) continue
      if (NAME_STOP_WORDS.some(word => line.includes(word))) continue
      return { name: line, ...(uid === undefined ? {} : { uid }) }
    }
  }

  return uid === undefined ? {} : { uid }
}

/** 界面上叫它什么。读不到名字就「账号 N」——**不拿档案目录名冒充昵称**。 */
export function accountDisplayName(index: number, name?: string): string {
  return name !== undefined && name.trim() !== '' ? name : `账号 ${index}`
}
