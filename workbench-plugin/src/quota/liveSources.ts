/**
 * **「读不到最新」那一格该说什么 —— 各家额度来源自己声明的那一处**(2026-10-02,卡 QK)。
 *
 * ## 为什么要有这一处
 *
 * 卡 QA 把过线那一档从「照说那个数」改成「读不到最新的,上次 04:27」—— 不再骗人了,
 * 可她看到的仍然只有这一句。查实的那一幕(`docs/交接-1002-额度陈旧要标出来.md` 第 2 节):
 * Claude 唯一能**随她的使用实时更新**的那条路(自发 1 token 请求读响应头,`claudeHeaders.ts`)
 * 要一把她没配的凭据;桌面端那份用量文件从 04:27 起就停更了(桌面端没在跑);
 * statusLine 那条在桌面端拉起的 Claude Code 里压根不响。**界面上一个字都没说。**
 *
 * 所以过线那一格要说清两件事:**为什么读不到**、**她能做什么**。
 *
 * ## 为什么声明在这里,而不在界面里
 *
 * 在这之前「过线时多说半句」是 `server/agentQuota.ts` 里一张按家名写死的表
 * (`STALE_HINTS = { claude: 'Claude 桌面没在跑' }`)。那是把一家的事实写进了拼界面那一层:
 * 新接一家就要回去改界面,而「这一家有没有更实时的来源」本来是**那条来源自己知道的事**。
 *
 * 现在一家一条,就在这张表上:
 * - `why` —— 读不到最新多半是为什么。**查实过才写**,没查实的家整格缺席(D13:不替它编一个原因)。
 * - `live` —— 这一家还有一条更实时的来源,但缺一样东西:`needs` 写**名字**(环境变量名 / 凭据名),
 *   那一句人话、那个入口写在旁边。**没有更实时来源的家(今天是别的每一家)整格缺席**,
 *   过线就只说「上次 HH:MM」—— 不凭空长出一颗按钮。
 *
 * ## 一个密钥都不经过这里
 *
 * `needs` 只有名字,通不通由调用方给的 `has(name)` 回答(AGENTS.md「不展示或写入 API Key…」)。
 * 那句人话里也不说密钥长什么样、更不说它的值;`CLAUDE_LIVE_WHY` 按卡 SG 的规矩说「密钥」,
 * 不说「setup-token」这种词 —— 用的人是不写代码的半专业个体。
 *
 * ## 这张卡**不做**配置流程
 *
 * `fix.at` 只是「设置里哪一节、哪一行」—— 设置页里那一行(各家的密钥与登录 → Claude)早就有了,
 * 这里只负责把她送过去。填什么、怎么存、怎么验,一个字都没改。
 */
import type { QuotaStaleFix, QuotaStaleHint } from '../protocol.ts'

/** Claude 桌面端那份用量记录停更时的原话(2026-09-26 卡 QS 起就是这一句,卡 QK 只是把它搬到了这里)。 */
export const CLAUDE_STALE_WHY = 'Claude 桌面没在跑'

/**
 * Claude 那条**唯一实时**的路缺什么(`quota/claudeHeaders.ts`:自发一个 1 token 的请求、读它回的限流头)。
 * 不说「setup-token」(卡 SG:界面上不出现这类词),也不说它长什么样。
 *
 * ★ 2026-10-03(卡「不让用户知道什么叫 setup-token」):原话是「配一把 Claude 的密钥就能实时」——
 * 维护者按那句话去配,发现要先在终端里跑一条命令,于是说:「**你得考虑产品化啊,你不说我咋知道要咋弄啊。**」
 * 现在那一步只剩一颗键(`quota/claudeSetupToken.ts`:工作台自己起那条命令、替她开浏览器),
 * 所以这句话也跟着改成**她真要做的那一下**:点一下、在浏览器里授权一次。
 */
export const CLAUDE_LIVE_WHY = '点一下「接上」,在浏览器里用 Claude 账号授权一次就实时'

/**
 * 这把密钥**被上游拒了**(401/403)时那一句。与上面那句不是一件事:
 * 「没配」和「配了但不管用」她要做的下一步一样(再接一次),可**说错了她会去找别的毛病**。
 * 采集层查实了才会用它(`quota/collect.ts`:那一轮真收到 401/403),没查实不猜(D13)。
 */
export const CLAUDE_KEY_REJECTED_WHY = '上次那把 Claude 密钥不管用了(多半过期了),点一下「接上」重新授权一次'

/**
 * 那颗键去哪:设置 →「各家的密钥与登录」(原名「额度凭据」)里 Claude 那一行 ——
 * 2026-10-03 起那一行上第一颗就是「接上」,所以这颗键的字也从「去设置里配」改成「去接上」
 * (她点完到的那一行里,按的还是同一个词)。
 */
export const CLAUDE_LIVE_FIX: QuotaStaleFix = {
  label: '去接上',
  at: { group: 'agents', row: 'claude_api' },
  desk_only: true,
}

/**
 * 一家一条。`needs` 里**任一样有**就算这条更实时的路通了 —— 通了就不说那句话
 * (那时数本来就是实时的,再劝她配一把是句废话)。
 */
interface LiveQuotaDecl {
  why?: string
  live?: {
    needs: readonly string[]
    why: string
    /**
     * 那一样**配了、但上游拒了它**时改说这一句(2026-10-03)。缺席 = 这一家没分这两种,
     * 照 `why` 说(行为与这一版之前一字不差)。
     */
    rejected_why?: string
    fix?: QuotaStaleFix
  }
}

/**
 * 今天表上只有 Claude 一条,**这不是写死一家**:别的每一家要么没有更实时的来源
 * (从窗口上读的那几家、Codex 那条实时路用它自己的登录态、什么都不缺),要么还没查实过原因。
 * 新接一家有了更实时的来源,在这里加一行 —— 三端一个字都不用改。
 */
const LIVE_SOURCES: Readonly<Record<string, LiveQuotaDecl>> = {
  claude: {
    why: CLAUDE_STALE_WHY,
    live: {
      // 名字,不是值:环境变量 `CLAUDE_SETUP_TOKEN`,或凭据文件里那把 `claude_api`
      // —— 与 `collect.ts` 的 `collectClaude` 读的是同两样(那边一处取值,这边一处声明)。
      needs: ['CLAUDE_SETUP_TOKEN', 'claude_api'],
      why: CLAUDE_LIVE_WHY,
      rejected_why: CLAUDE_KEY_REJECTED_WHY,
      fix: CLAUDE_LIVE_FIX,
    },
  },
}

/** 这一家声明过更实时的来源吗(用例与交接里数「哪几家有、哪几家没有」用得上)。 */
export function hasLiveQuotaSource(id: string): boolean {
  return LIVE_SOURCES[id]?.live !== undefined
}

/**
 * 这一家过线时该说什么。
 *
 * @param has 这一样**配了没有**(只给名字,绝不给值)。缺省当成一样都没配 ——
 *   那时如实说「点一下『接上』就实时」,比闷声不说有用。
 * @returns 两句都没有 → `undefined`(那一格只剩「上次 HH:MM」)。
 */
export function quotaStaleHintFor(
  id: string,
  has: (name: string) => boolean = () => false,
  /**
   * 这一家那把密钥**这一轮被上游拒了**(2026-10-03,卡「一键接上」第 3 条)。
   *
   * 「配了但不管用」要当成**缺**那一样 —— 否则那一格会闷声不响:凭据明明在文件里,
   * 于是这条更实时的路被判成「通了」,而她看到的只有一个越来越旧的数、一个字的提示都没有。
   * 只有采集层真收到 401/403 才会传 true(查实过才说,D13)。
   */
  rejected = false,
): QuotaStaleHint | undefined {
  const decl = LIVE_SOURCES[id]
  if (decl === undefined) return undefined
  const live = decl.live !== undefined && (rejected || !decl.live.needs.some(name => has(name)))
    ? {
        why: rejected ? (decl.live.rejected_why ?? decl.live.why) : decl.live.why,
        ...(decl.live.fix === undefined ? {} : { fix: decl.live.fix }),
      }
    : undefined
  if (decl.why === undefined && live === undefined) return undefined
  return {
    ...(decl.why === undefined ? {} : { why: decl.why }),
    ...(live === undefined ? {} : { live }),
  }
}
