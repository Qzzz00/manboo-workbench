/**
 * 随版本走的事务官技能(2026-09-23,统筹追加第三件)。
 *
 * 起因:新装机器的 web.stdout.log 每次启动都打「[技能] 起服务时没接上事务官技能:找不到本机的
 * desktop-workbench 仓库……」。技能正文原来**只**从开发仓库的 `docs/技能/` 读,普通用户机器上没有这个仓库,
 * 运营模板的十段技能与派活技能永远接不上。
 *
 * 现在 `docs/技能/*.md` 由 `scripts/gen-bundled-skills.mjs` 原样打进插件(`bundledSkills.generated.ts`,
 * 进 `lib/index.js`,dmg 与热更新包带的都是这一份)。**取法:仓库优先,包内兜底**:
 * - 找得到仓库(维护者机器、开发时):照旧读仓库那份 —— 改技能当场生效,不用发版;
 * - 找不到(普通用户):读包内那份。
 * 仓库那份若比包内新,只在有仓库的那台机器上生效;发版前跑一次生成脚本,守卫用例保证两份一致。
 *
 * 违禁词表是「技能读的数据」,技能正文里写的是仓库相对路径 `docs/技能/违禁词表.md`(会话 cwd 是她的工作目录,
 * 那里没有这个文件)。用包内技能时把它落到 `~/.dsh/workbench/技能/违禁词表.md`,正文里的路径换成那个绝对路径。
 */
import { BUNDLED_SKILL_DOCS } from './bundledSkills.generated.ts'

const SKILL_DIR_PREFIX = 'docs/技能/'

/** `docs/技能/运营-总纲.md` → 包内那份全文;不是这个目录下的、或包里没有 → undefined。 */
export function bundledSkillDoc(relPath: string): string | undefined {
  if (!relPath.startsWith(SKILL_DIR_PREFIX)) return undefined
  return BUNDLED_SKILL_DOCS[relPath.slice(SKILL_DIR_PREFIX.length)]
}

/**
 * 技能正文里「工作台在哪」的占位(2026-09-26,卡 SP)。
 *
 * ## 撞出来的事
 *
 * 技能正文里的接口地址原来是写死的 `http://127.0.0.1:8791/...`(`/dispatch/run`、`/dispatch/choices`、
 * `/progress/ask`、`/agents/quota`、`/confirm/points` …),而服务真听的端口是 `WORKBENCH_PORT` 算出来的。
 * 于是灰度实例(`WORKBENCH_PORT=8890`)里的事务官照技能里那个地址去派活 —— **派的是生产**。
 * 卡 GP 修的是**页面**那一半(宿主经 DSH 注入表把地址告诉页面),它的语法树守门只扫 `src/client`,
 * Markdown 正文不在扫描范围里,所以这一半漏了。
 *
 * ## 机制
 *
 * 正文里写 `{{工作台地址}}`,写进 `~/.dsh/AGENTS.md` 时换成**这台服务真在听的地址**
 * (`serviceOrigin.ts` 的 `serviceBaseUrl(host, port)` —— 跟页面那一半同一个算法、同一个回环收敛规矩)。
 * 生产上渲出来还是 `http://127.0.0.1:8791`,一个字没变。
 *
 * 这是**文末那张「这台电脑上现在怎么派」表**那条路的同一条:凡"每台机器不一样"的东西都不写死在仓库里,
 * 接上那一刻现渲(`http.ts` 的 `prepareDispatchSkill` / `prepareOpsSkills` 的 readDoc)。
 *
 * 与违禁词表那一处的区别:词表只有**包内**那份要换(仓库那份的相对路径在仓库里是对的),
 * 地址是**两份都要换** —— 仓库那份也不知道这台服务听在哪。
 */
export const SERVICE_URL_PLACEHOLDER = '{{工作台地址}}'

/**
 * 正文里的 `{{工作台地址}}` 换成这台服务真在听的 origin(形如 `http://127.0.0.1:8791`,不带结尾斜杠)。
 *
 * @param baseUrl `serviceBaseUrl(host, port)` 的结果。**调用方必须给真地址**,这里不兜底 ——
 *   兜出来的那个地址正是这张卡要修的病(打到别人家的服务上,而且界面上一切正常)。
 */
export function pointServiceAt(text: string, baseUrl: string): string {
  return text.split(SERVICE_URL_PLACEHOLDER).join(baseUrl)
}

export const WORDLIST_REL = `${SKILL_DIR_PREFIX}违禁词表.md`

/**
 * 技能正文与它读的数据落在哪(2026-10-02 起正文也落这儿,见 `opsSkills.ts` 的 `opsSkillIndexEntry`)。
 * 只有这一处算这个目录 —— 两处算法迟早会漂。
 */
export function skillDataDir(home: string): string {
  return `${home}/.dsh/workbench/技能`
}

/** 包内技能用的违禁词表落在哪。 */
export function bundledWordlistFile(home: string): string {
  return `${skillDataDir(home)}/违禁词表.md`
}

/**
 * 一段技能的**正文**落在哪(2026-10-02,卡「事务官为什么要跑这么多步」)。
 * AGENTS.md 里那一段只留索引,索引指的就是这个路径。
 */
export function skillBodyFile(home: string, name: string): string {
  return `${skillDataDir(home)}/${name}.md`
}

/** 包内技能正文里指向仓库违禁词表的路径,换成落盘那份的绝对路径。 */
export function pointWordlistAt(text: string, wordlistFile: string): string {
  return text.split(WORDLIST_REL).join(wordlistFile)
}

/**
 * 读一份技能:仓库优先(`readRepo` 回 undefined / 空 = 没有),包内兜底。
 * `source` 给界面与日志如实说读的是哪一份。
 */
export async function readSkillDoc(
  relPath: string,
  readRepo: ((relPath: string) => Promise<string | undefined>) | undefined,
): Promise<{ text: string, source: 'repo' | 'bundled' } | undefined> {
  if (readRepo !== undefined) {
    const repoText = await readRepo(relPath)
    if (repoText !== undefined && repoText.trim() !== '') return { text: repoText, source: 'repo' }
  }
  const bundled = bundledSkillDoc(relPath)
  return bundled === undefined || bundled.trim() === '' ? undefined : { text: bundled, source: 'bundled' }
}
