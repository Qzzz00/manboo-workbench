/**
 * 「改自己」那条闭环的**收尾**:重启之后回头确认上一版到底生没生效(2026-09-23)。
 *
 * ## 这一段为什么必须存在
 *
 * `selfShip.ts` 的第 ⑧ 步(`POST /update/apply`)会把**正在跑那条请求的那个进程**
 * 换掉并重启,所以它没有任何办法在原地等到"版本号真的变了"。统筹定的做法是
 * **先落记录、再触发更新、立刻回包**,于是进化日志里那一节写下去的时候,
 * 状态是如实的「待重启确认」(`EVOLUTION_PENDING`)。
 *
 * 那一句话必须有人回头把它变成结论,否则日志里会永远躺着一条"不知道成没成"的记录 ——
 * 而这正是一件能自己改自己的东西最不该留下的东西。
 *
 * **这一段就是那个"回头"**:服务起来的时候跑一次,两种结局都有下文 ——
 *
 * | 对上了 | 把那一行改成「已生效」+ 收件箱一条「上一版已生效」 |
 * | 没对上 | 日志**原样不动**(它仍然是待确认的),收件箱一条「更新没生效」,带**原话** |
 *
 * ## 「当前运行版本」读的是**装到盘上那一份**,不是进程里那一个
 *
 * `PLUGIN_VERSION` 是**构建时注入**进 bundle 的(见 `src/version.ts`):它说的是
 * "这段正在跑的代码是哪一版"。而这里要问的是另一个问题 ——
 * **"这台机器上装着的是哪一版"**。
 *
 * 两者在正常情况下相等,但恰恰在这一段最关心的那一刻不等:热更新把新插件装进
 * `~/.dsh/profiles/web/node_modules/@ben/dsh-workbench/` **之后**才重启。
 * 万一 launchd 没把服务拉起来、或者拉起来的还是旧进程,读进程里那一个会得到
 * "还是旧版"这种半真半假的答案。读盘上那一份问的才是"装成了没有"。
 *
 * 所以 `runningVersion` 由接线方(`src/index.ts`)喂进来,读的是
 * `setupPaths().profilePluginPackageJson`。
 *
 * ## 这一层不碰收件箱、不碰卡
 *
 * 它只回一份"确认了没有"的事实。把那一条铺进收件箱是 `butlerInbox.ts` 的事
 * (那个文件是纯函数、现拼不落盘,同它既有的六个来源一条纪律)。
 */
import {
  EVOLUTION_LOG_REL, EVOLUTION_PENDING,
  confirmEvolutionSection, isEvolutionPending, joinRel, parseLatestEvolution, versionOfPackageJson,
} from './selfUpdate.ts'

/**
 * 收尾之后要跟她说的那一条。**两种结局都给** —— 「没生效」比「生效了」更要说出来,
 * 而一条只在成功时说话的收尾等于没有收尾。
 */
export interface SelfShipFollowUp {
  /** 上一版生效了没有。 */
  ok: boolean
  /** 进化日志里那一节记着的版本号。 */
  version: string
  /** 那一节的「什么」(= 发版时那句人话)。日志里没写就没有。 */
  what?: string
  /** 这台机器上**装着**的是哪一版。读不出就没有(**不猜**)。 */
  running?: string
  /** 收件箱那一条的正文。没生效时是**原话**,不概括。 */
  note: string
  /** 确认的那一刻(ISO)。 */
  at: string
}

export interface SelfShipFollowUpDeps {
  /** 项目根(= 工作台自己那个仓库)。进化日志在它底下。 */
  projectPath: string
  readText: (path: string) => Promise<string | undefined>
  writeText: (path: string, text: string) => Promise<void>
  /** 这台机器上**装着**的是哪一版(读盘上那一份 package.json,见文件头)。 */
  runningVersion: () => Promise<string | undefined>
  now: () => Date
}

/**
 * 装到盘上那一份 package.json 的版本号。读不出回 undefined ——**不退回进程里那一个**:
 * 两者在这一段最关心的那一刻恰好可能不等(见文件头),拿一个"差不多对"的值去做
 * "生效了没有"的判定,得到的结论会比没有结论更坏。
 */
export async function installedPluginVersion(
  packageJsonPath: string,
  readText: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const text = await readText(packageJsonPath)
  return text === undefined ? undefined : versionOfPackageJson(text)
}

/**
 * 服务起来的时候跑一次。
 *
 * **绝大多数次什么都不做**:日志不在、一节都没有、最近那一节不是「待重启确认」——
 * 三种都直接回 undefined(收件箱里一条都不出)。这一段只在"上一次真的按过更新"
 * 之后那一次启动说话。
 */
export async function runSelfShipFollowUp(deps: SelfShipFollowUpDeps): Promise<SelfShipFollowUp | undefined> {
  const path = joinRel(deps.projectPath, EVOLUTION_LOG_REL)
  const text = await deps.readText(path)
  if (text === undefined) return undefined
  const entry = parseLatestEvolution(text)
  if (!isEvolutionPending(entry) || entry?.version === undefined) return undefined

  const at = deps.now().toISOString()
  const running = await deps.runningVersion()
  const base = {
    version: entry.version,
    ...(entry.what === undefined ? {} : { what: entry.what }),
    ...(running === undefined ? {} : { running }),
    at,
  }

  if (running !== entry.version) {
    /**
     * 对不上。**日志一个字节都不动** —— 它记着的仍然是实情:那一版触发过更新,
     * 但这台电脑上还不是它。改成「没生效」等于替一件还可能在半路上的事下结论
     * (下一次启动再对一次就是了)。
     */
    return {
      ok: false,
      ...base,
      note: `上一版 ${entry.version} 触发过热更新,但这台电脑上装着的是 ${running ?? '不详(那份 package.json 读不出来)'}。`
        + `进化日志里那一条还标着「${EVOLUTION_PENDING}」,没有替它改成「已生效」。`
        + '去设置里点一次「检查更新」,或者看一眼更新那条作业停在哪儿。',
    }
  }

  const confirmed = confirmEvolutionSection(text, { version: entry.version, at })
  if (!confirmed.ok) {
    // 版本是对上了,只是那一行没改成 —— **如实说**,不假装收尾做完了。
    return {
      ok: true,
      ...base,
      note: `上一版 ${entry.version} 已经在这台电脑上跑起来了。`
        + `只是 ${EVOLUTION_LOG_REL} 里那一行没改成「已生效」:${confirmed.reason}`,
    }
  }
  try { await deps.writeText(path, confirmed.text) }
  catch (error) {
    return {
      ok: true,
      ...base,
      note: `上一版 ${entry.version} 已经在这台电脑上跑起来了。`
        + `只是 ${EVOLUTION_LOG_REL} 写不进去:${(error as Error).message}`,
    }
  }
  return {
    ok: true,
    ...base,
    note: entry.what === undefined
      ? `${entry.version} 已经在这台电脑上跑起来了,进化日志里那一条已经标成「已生效」。`
      : `${entry.what} —— ${entry.version} 已经在这台电脑上跑起来了,进化日志里那一条已经标成「已生效」。`,
  }
}
