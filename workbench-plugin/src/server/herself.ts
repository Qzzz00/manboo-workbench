/**
 * 「等你确认」只认她本人,发版要她点头(2026-09-28,卡 BS;
 * 决策记录 2026-09-28 15:5x 第 2、3、4 条)。
 *
 * ## 拍板的原话
 *
 * > **「等你确认」只有她本人能答**,事务官也不行。
 * > **发版(`/feature/ship`)只有她点头才走。**
 * > 「做不到」靠代码里的门,不靠提示词;门要能分出事务官与别家(现在的 Origin 头 / 授权表都可伪造)。
 *
 * ## 为什么原来分不出来
 *
 * 8791 只有三档权限:本机(全权)/ 本机或配对设备 / 外来须设备令牌。而**事务官自己也是在
 * 它那条会话里用 shell 打 8791 的**,所以「本机」这一档里混着:她点的页面、她的壳、她的手机、
 * 电话工人、事务官、以及派出去的任何一家 Agent。唯一想区分「谁在写」的
 * `actorOfRequest`(`actorNotes.ts`)看的是 `Origin` 头或壳 UA —— 加一个头就当页面放行。
 * 授权表(`docs/记忆/授权.md`)更是谁都能改。
 *
 * ## 这一版的门:**先能指认出事务官,再把「认不出来的程序」一起关在外面**
 *
 * 开机时现生两把令牌,**只在进程里,不落盘**(重启即换,泄不出去一份长期凭据):
 *
 * 1. **事务官那一把**(`WORKBENCH_BUTLER_ACTOR`)放进**这个进程自己的 env**。8791 跑在 DSH 进程里,
 *    事务官的 shell 工具是这个进程的**子进程**,于是只有它继承得到 —— 派出去的 Codex / Claude
 *    在别的进程树里,拿不到。带着它的请求**一定是事务官**,这四个口当场 403(它自己不能替她点头)。
 * 2. **电话工人那一把**(`WORKBENCH_WORKER_ACTOR`)只放进**工人的 spawn env**,
 *    **不进 `process.env`** —— 所以事务官在自己的 env 里读不到它,伪装不了工人。
 *    工人替她转的是她在电话里亲口说的那一句(`/asks/voice`),算她本人。
 *
 * 允许的四种身份,各走各的凭据:
 *
 * | 谁 | 凭据 | 伪造得了吗 |
 * |---|---|---|
 * | 她的手机 / 座机 | 设备令牌(`/pair` 签的) | 要偷到令牌 |
 * | 电话工人 | 工人那把进程令牌 | 要读到另一个进程的 env |
 * | 她的页面 / 壳 | 浏览器痕迹(Origin / 壳 UA)**且不带事务官令牌** | ⚠️ **本机程序加一个 Origin 头仍然能装页面** |
 * | 事务官 | —— | 明着拒 |
 *
 * ## ⚠️ 剩下的那个洞(写清楚,不假装关上了)
 *
 * 第三行那个 ⚠️ 是这一版**没有**关上的:一个跑在这台机器上的程序,只要加一个
 * `Origin: http://127.0.0.1:...`,在这道门看来就是页面。要关它得给页面一把**真凭据**,
 * 而页面那一把只能经 DSH 的登录态发下来(注入表是一行明文 HTML,`serviceOrigin.ts` 自己
 * 写着「只放地址,永远不放凭据」)—— 那是另一张卡。
 *
 * 但**这一版仍然把最要紧的两条堵上了**:
 * - 事务官带着自己的令牌打这四个口 → 拒。而那把令牌对它**是必需的**(A11 那道门要它,见交接待办),
 *   所以它不能靠「不带令牌」绕过去,一绕就什么都写不成。
 * - 派出去的别家 / 随手一条 curl(既没有设备令牌、也没有浏览器痕迹)→ 拒。
 *   在这之前它们**在本机上直接就能替他点批准、按发版**(见 `docs/盘点-模组显示状态谁能改-2026-09-28.md`)。
 */

import { randomBytes } from 'node:crypto'

/** 事务官那把令牌放在哪个环境变量名下(它的 shell 工具从自己的 env 里读)。 */
export const BUTLER_ACTOR_ENV = 'WORKBENCH_BUTLER_ACTOR'

/** 电话工人那把令牌放在哪个环境变量名下(**只进工人的 spawn env**)。 */
export const WORKER_ACTOR_ENV = 'WORKBENCH_WORKER_ACTOR'

/** 两把令牌都从这条头上带。值就是令牌本身。 */
export const ACTOR_TOKEN_HEADER = 'x-workbench-actor'

/** 认得出来的四种身份,加一个「认不出来」。 */
export type Asker = 'device' | 'worker' | 'butler' | 'page' | 'unknown'

/** 一套进程令牌。**不落盘**:重启即换。 */
export interface ActorTokens {
  butler: string
  worker: string
}

/** 现生一套。48 位十六进制,与火山回调那条签名同规格。 */
export function mintActorTokens(random: (bytes: number) => string = n => randomBytes(n).toString('hex')): ActorTokens {
  return { butler: `wb-butler-${random(24)}`, worker: `wb-worker-${random(24)}` }
}

/** 请求上带的那把令牌(没带回 undefined)。 */
function tokenOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers[ACTOR_TOKEN_HEADER]
  const one = Array.isArray(raw) ? raw[0] : raw
  return typeof one === 'string' && one.trim() !== '' ? one.trim() : undefined
}

/**
 * 这一条是谁打来的。
 *
 * 顺序要紧:**令牌先认**(带了事务官那把就是事务官,哪怕它同时伪造了 Origin 头);
 * 设备令牌次之(那是她的手机 / 座机);都没有才看有没有浏览器痕迹。
 *
 * @param tokens 这个进程这一轮的两把令牌;缺席(老实现 / 用例没接)时一把都认不出来,
 *   于是事务官与工人都落到 `page` / `unknown` 上 —— **宁可认不出,也不认错**。
 */
export function whoIsAsking(input: {
  headers: Record<string, string | string[] | undefined>
  /** 这一条是不是已经认出了配对设备(http.ts 的 `device`)。 */
  device: boolean
  tokens?: ActorTokens | undefined
}): Asker {
  const token = tokenOf(input.headers)
  if (token !== undefined && input.tokens !== undefined) {
    if (token === input.tokens.butler) return 'butler'
    if (token === input.tokens.worker) return 'worker'
  }
  if (input.device) return 'device'
  const origin = input.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') return 'page'
  const ua = input.headers['user-agent']
  if (typeof ua === 'string' && ua.includes('BenWorkbenchShell/')) return 'page'
  return 'unknown'
}

/** 拒绝时说的那句话。**说清是谁被拒、下一步该怎么办**,不留一句「403」。 */
export const HERSELF_ONLY_ANSWER
  = '这一条只有你本人能答 —— 在电脑上点、在手机上点,或者在电话里说一句。'
  + '事务官不能替你答:它的活是把要问的事摆到你面前。'

export const HERSELF_ONLY_SHIP
  = '发版只有你点头才走 —— 在电脑上或手机上按「通过」。事务官可以把这一版准备好,但按不下这一下。'

/**
 * 这四个口(`/approvals/answer`、`/questions/answer`、`/asks/voice`、`/feature/ship`)
 * 允许这一条过吗。回 undefined = 过;回一句话 = 403 加这句话。
 */
export function notHerself(asker: Asker, what: 'answer' | 'ship'): string | undefined {
  if (asker === 'device' || asker === 'worker' || asker === 'page') return undefined
  return what === 'ship' ? HERSELF_ONLY_SHIP : HERSELF_ONLY_ANSWER
}

// ───────────────────────── A11:改显示状态的那道门 ─────────────────────────

/**
 * **改工作台上各模组显示的状态,只许事务官与她本人做**
 * (2026-09-28 维护者拍板 A11 + 同日 15:5x 第 1 条;卡 BS2 落地;`docs/盘点-模组显示状态谁能改-2026-09-28.md`)。
 *
 * 维护者原话:「摆弄项目区里看板的事项卡进度这些,应该都是只允许事务官来做的,这个是通用的,
 * 就是更改工作台上一些模组的显示状态。」
 *
 * 在这之前那份盘点的结论是:**本机任何程序都写得动任何一处** —— 派出去的 Codex / Claude
 * 在本机随手一条 curl 就能建卡、挪列、改进度、改布局、触发例程。
 *
 * ## 这道门怎么判
 *
 * 放过去的四种:**她的页面 / 壳**、**她配对过的手机 / 座机**、**电话工人**、**事务官那把进程令牌**。
 * 认不出来的(`unknown` —— 既没有设备令牌、也没有哪一把进程令牌、也没有浏览器痕迹)一律 403。
 *
 * 与「等你确认」那道门(`notHerself`)正好差一格:那四个口**连事务官也不放**,这一批**只有事务官放得过**。
 *
 * ## 报事实的口不在这道门里
 *
 * `/event`、`/hook/<agent>`、`/statusline` 照旧敞着(`bin/agent-hook.sh` 与各家的钩子要报状态),
 * 座机那条信令(`/phone/event`、`/call/*`、`/ring/*`)也照旧 —— 它们报的是**事实**,不是「摆弄显示状态」。
 * 事实报进来之后由工作台自己按证据算(A11 允许的第三方)。
 *
 * ## 事务官怎么带上那把令牌
 *
 * 它的 shell 是 8791 这个进程的子进程,所以 env 里有 `WORKBENCH_BUTLER_ACTOR`;
 * 每条写请求加一条头 `x-workbench-actor: $WORKBENCH_BUTLER_ACTOR` 就认得出来。
 * 技能里写了这一条,而且**拦下那句话本身就把做法说清**(读得到这句话的只有它自己 ——
 * 派出去的别家在别的进程树里,env 里没有那个值,照着做也带不出来)。
 */
export const DISPLAY_STATE_DENIED
  = '这条改的是工作台上模组显示的状态(看板与事项卡、项目区、布局、规矩与记忆、随手记、例程、小组件……),'
  + '而工作台认不出你是谁,所以没办。'
  + '改这些只有三方:她本人(电脑上点、手机上点、电话里说)、事务官,以及工作台自己按证据算。'
  + '派出去的那家只把结果交回它自己那件事上(报事实的口照旧敞着:/event、/hook/<哪一家>、/statusline),'
  + '由事务官按证据记上去。'
  + `如果你就是事务官:每条写请求带上这条头 —— \`${ACTOR_TOKEN_HEADER}: $${BUTLER_ACTOR_ENV}\`(那个值在你自己的环境变量里)。`

/**
 * 这一条改的是「模组显示的状态」吗(**只看写方法**:GET / HEAD 一律不是)。
 *
 * 表照 `docs/盘点-模组显示状态谁能改-2026-09-28.md` 那张「模组 × 写入口」列的。
 * **没列进来的一律放行** —— 宁可这一版少关几处,也不要把手机、座机、钩子、安装器弄坏;
 * 漏了哪一处补进这张表就是(它是一处定义,不散在三十个路由里)。
 */
const DISPLAY_STATE_WRITES: readonly RegExp[] = [
  // 看板 / 事项卡 / 冲刺 / 项目排期 / 进度
  /^\/task(\/|$)/, /^\/sprint(\/|$)/, /^\/module(\/|$)/, /^\/board\//, /^\/item\//, /^\/progress\//,
  // 协作区(2026-10-21):目标、名片、板的摆法、会话挂目标、迁移
  /^\/collab\//,
  // 事务官那一摊:事项、规矩、记忆 / 偏好、上限、通话纪要、抽屉里那几问
  /^\/butler\//, /^\/asks\//,
  // 派活(挑手那条 `/dispatch/choices` 是只读的查询,不在这里)
  /^\/dispatch\/(run|client|api)$/,
  // 项目区
  /^\/project\//, /^\/attribution\//,
  // 布局 / 模板 / 窗位槽 / 坞 / 场景 / 应用
  /^\/layout/, /^\/template\//, /^\/dock\//, /^\/slot\//, /^\/apps\//, /^\/scene\//, /^\/snap$/,
  // 随手记 / 收件箱 / 资讯 / 会议 / 哨兵 / 暂停
  /^\/note(\/|$)/, /^\/inbox\//, /^\/feed\//, /^\/meeting\//, /^\/sentinel\//, /^\/pause$/,
  // 例程(开工汇报 / 下班例程 / 每周 lint 的开关与手动跑)
  /^\/routine\//,
  // 引导 / 落地单、选题卡、需求卡与发版、自我进化、技能段
  /^\/onboarding\//, /^\/topic\//, /^\/feature\//, /^\/evolve\//, /^\/config\/skill\//,
]

export function isDisplayStateWrite(method: string | undefined, path: string): boolean {
  const verb = (method ?? '').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return false
  return DISPLAY_STATE_WRITES.some(one => one.test(path))
}

/**
 * 这条改显示状态的请求放得过吗。回 undefined = 过;回一句话 = 403 加这句话。
 *
 * @param asker `whoIsAsking` 的结果。
 */
export function notButlerOrHerself(asker: Asker): string | undefined {
  return asker === 'unknown' ? DISPLAY_STATE_DENIED : undefined
}
