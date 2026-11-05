/**
 * 各家客户端 hooks 配置的生成器(2026-09-17 卡 C 第 4 条;2026-09-25 卡 R「钩子脚本随插件走」改写)。
 *
 * ## 病根(两次)
 *
 * 1. **09-17**:`bin/claude-settings.hooks.json` 里那四条 command 写死
 *    `/Users/example/Documents/GitHub/desktop-workbench/workbench-plugin/bin/agent-hook.sh claude` ——
 *    换一台 Mac 照抄过去就是四条永远静默失败的 hook。当时的治法是「按本机仓库路径现渲染」。
 * 2. **09-25(卡 R)**:「按本机仓库渲染」本身就是病。插件包(`package.json` 的 `files`)里根本没带
 *    `bin/`,装好的机器上没有开发仓库;`butler_cwd` 是事务官的**工作目录**(`~/Documents/工作台`),
 *    也不是仓库 —— 于是正常装机的用户**永远**接不上 Claude / Codex 的额度钩子,界面上还叫一个
 *    不懂代码的人去把「事务官仓库目录」指到开发仓库。维护者:「下一个用户是不是会遇到一样的问题,
 *    得建立机制」。
 *
 * ## 治法(卡 R):脚本随包走,命令只指一个固定位置
 *
 * - `bin/agent-hook.sh`、`bin/claude-statusline.sh` 进包(`files`),守门用例盯着:运行时要读的包内文件
 *   漏进包就红(tests/package-files-guard.test.ts)。
 * - 插件**每次起服务**(以及每次「接上」之前)把这两个脚本同步到 **`~/.dsh/workbench/hooks/`**,
 *   内容有变才覆盖、原子替换(hookScripts.ts)。
 * - 写进各家配置的命令**只指这个固定位置**:插件升级、换版本、换装法(pnpm 的目录名里带版本号),
 *   那几条命令一个字都不用变;插件被卸掉时脚本还在、照样安静退出 0,不会在他每次会话里报错。
 * - 不依赖开发仓库,不依赖 `butler_cwd`。开发仓库只是开发时的兜底:脚本来源先找「这份代码自己所在的包」,
 *   开发机上那就是正在跑的这份 checkout 的 `workbench-plugin/bin/`;再找不到才往上找开发仓库。
 *
 * 选这条而不是「命令直接指进包里的 bin/」的理由写在 docs/决策记录.md(2026-09-25 卡 R)。
 *
 * bin/ 里的两份 JSON 仍是**模板**(位置写成 `__WORKBENCH_HOOKS__`),与生成器的一致性由
 * tests/server-hooks-config.test.ts 盯着(两份各写一遍的东西迟早会不一致)。
 *
 * ## Codex 那一份
 *
 * 仓库里原本没有副本。这份模板照着本机 `~/.codex/hooks.json` 里与工作台相关的三条
 * (Stop / UserPromptSubmit / SessionEnd)写成,**不含 headroom 那两条**——那是另一个工具的
 * 东西,与工作台无关,抄过来等于替 Ben 决定他该装什么。Codex 没有 Notification,
 * 所以只有三条而不是四条(能力差是事实,见 hooks.ts 顶部)。
 */

/** 模板里代表"钩子脚本所在的固定位置"的占位符。bin/*.json 里存的就是它。 */
export const WB_HOOKS_PLACEHOLDER = '__WORKBENCH_HOOKS__'

/** 转发 hook 事件的那个脚本(各家 hook 配置里挂的就是它)。 */
export const WB_HOOK_SCRIPT = 'agent-hook.sh'
/** Claude 状态栏那个脚本(额度随它上报)。 */
export const WB_STATUSLINE_SCRIPT = 'claude-statusline.sh'
/** 同步到固定位置的就是这两个 —— 包里 `bin/` 下别的东西运行时都不用(见 package-files-guard)。 */
export const WB_HOOK_SCRIPTS = [WB_HOOK_SCRIPT, WB_STATUSLINE_SCRIPT] as const

/**
 * 固定位置,相对家目录:`~/.dsh/workbench/hooks`。
 *
 * 放在 `~/.dsh/workbench/` 下(工作台自己的数据目录,apps.json、tasks.json 都在那儿),
 * 不放进包里、不放进 DSH 的 profile —— 那两处的目录名都会随版本变。
 */
export const WB_HOOKS_DIR_REL = '.dsh/workbench/hooks'

/** 这台机器上钩子脚本的固定位置。`home` 空(没配 HOME)时回 undefined —— 不往根目录下放东西。 */
export function wbHooksDir(home: string): string | undefined {
  const root = trimRoot(home)
  if (root === '' || root === '/') return undefined
  return `${root}/${WB_HOOKS_DIR_REL}`
}

/**
 * 认仓库用的标志文件:有它才是 desktop-workbench 的开发仓库根。
 *
 * 卡 R 之后它**只剩两个身份**:① `wbHooksResolveRepoRoot` 找开发仓库(技能正文「仓库优先」、
 * 进化那两处在用,钩子不再走它);② 认出**旧位置**的工作台条目(指着开发仓库的那几条)——
 * 所以它仍在 `WB_HOOKS_COMMAND_MARKERS` 里。
 */
export const WB_HOOKS_REPO_MARKER = `workbench-plugin/bin/${WB_HOOK_SCRIPT}`

/** 同上,Claude 的状态栏那一条的旧位置。 */
export const WB_HOOKS_STATUSLINE_MARKER = `workbench-plugin/bin/${WB_STATUSLINE_SCRIPT}`

/**
 * 认出「这条 hook 是工作台自己的」的标记:**新位置在前、旧位置在后,两种都认**。
 *
 * 为什么旧的也要认:维护者那台机器上现有的条目指着开发仓库里的 `workbench-plugin/bin/agent-hook.sh`。
 * 下次「接上」要把它们**换掉**而不是与新条目并存(并存的话旧那条每次会话都静默跑一遍),
 * 撤回也要摘得干净 —— 两件事都靠这张表。代写、撤回、「接上没有」三处共用这一份判据。
 */
export const WB_HOOKS_COMMAND_MARKERS: readonly string[] = [`/${WB_HOOKS_DIR_REL}/${WB_HOOK_SCRIPT}`, WB_HOOKS_REPO_MARKER]

/** 同上,状态栏那一条。 */
export const WB_HOOKS_STATUSLINE_MARKERS: readonly string[] = [`/${WB_HOOKS_DIR_REL}/${WB_STATUSLINE_SCRIPT}`, WB_HOOKS_STATUSLINE_MARKER]

/** 一条命令(或命令里的一个路径)是不是指着工作台自己的 hook 脚本 —— 新位置或旧位置。 */
export function wbHooksMentionsOurScript(text: string): boolean {
  return WB_HOOKS_COMMAND_MARKERS.some(marker => text.includes(marker))
}

/** 同上,状态栏脚本。 */
export function wbHooksMentionsOurStatusLine(text: string): boolean {
  return WB_HOOKS_STATUSLINE_MARKERS.some(marker => text.includes(marker))
}

/** hook 脚本的超时(秒)。上报是关键路径上的一次 curl,5 秒足够且不拖住会话。 */
const HOOK_TIMEOUT_SEC = 5

/**
 * Codex 的 SessionEnd 最多 3 秒(它自己钳,写 5 每次 `codex exec` 都打一行警告)。钳过之后的指纹相同,
 * 所以写 3 不会让她点过的「信任」作废(2026-10-21 实测,见 codexHookTrust.ts)。
 */
const CODEX_SESSION_END_TIMEOUT_SEC = 3

function hookTimeout(agent: WbHooksAgent, event: string): number {
  return agent === 'codex' && event === 'SessionEnd' ? CODEX_SESSION_END_TIMEOUT_SEC : HOOK_TIMEOUT_SEC
}

export type WbHooksAgent = 'claude' | 'codex'

export interface WbHooksCommand { type: 'command', command: string, timeout: number }
export interface WbHooksGroup { hooks: WbHooksCommand[] }
export interface WbHooksRendered {
  hooks: Record<string, WbHooksGroup[]>
  /** Claude Code 独有;Codex 的 hooks.json 里没有这一节。 */
  statusLine?: { type: 'command', command: string }
}

/** 哪家有哪几个 hook。Codex **没有 Notification**——绝不为它假造一条(hooks.ts 顶部同一条纪律)。 */
const HOOK_EVENTS: Record<WbHooksAgent, readonly string[]> = {
  claude: ['Notification', 'Stop', 'UserPromptSubmit', 'SessionEnd'],
  codex: ['Stop', 'UserPromptSubmit', 'SessionEnd'],
}

/** 去掉末尾斜杠,免得渲染出 `…/hooks//agent-hook.sh`。 */
function trimRoot(path: string): string {
  let root = path.trim()
  while (root.length > 1 && root.endsWith('/')) root = root.slice(0, -1)
  return root
}

/**
 * 按钩子脚本的固定位置渲染一份 hooks JSON。纯函数,不读盘。
 *
 * ★ Codex 那三条渲染出来的东西就是它算指纹的原料(事件、命令、超时……),她在 Codex 里点过的「信任」
 * 只认这个指纹:这里改一个字,她那几条就悄悄变回「没放行」。所以命令只指固定位置、不带版本号,
 * 渲染结果由 tests/server-hooks-config.test.ts 逐字钉死。
 *
 * @param hooksDir 固定位置(生产是 `~/.dsh/workbench/hooks` 的绝对路径,见 `wbHooksDir`)。
 */
export function wbHooksRender(agent: WbHooksAgent, hooksDir: string): WbHooksRendered {
  const dir = trimRoot(hooksDir)
  const script = `${dir}/${WB_HOOK_SCRIPT} ${agent}`
  const hooks: Record<string, WbHooksGroup[]> = {}
  for (const event of HOOK_EVENTS[agent]) {
    hooks[event] = [{ hooks: [{ type: 'command', command: script, timeout: hookTimeout(agent, event) }] }]
  }
  return {
    hooks,
    ...(agent === 'claude'
      ? { statusLine: { type: 'command' as const, command: `${dir}/${WB_STATUSLINE_SCRIPT}` } }
      : {}),
  }
}

/**
 * Codex 那边还差的一步:去哪儿点、点哪颗(2026-10-21)。新版 Codex 对没放行过的钩子一条都不跑。
 * 用的是 ChatGPT 桌面版简体中文界面上的原字(从它包里的界面文案核过:设置里那一页叫「钩子」,
 * 每条一颗「信任」,顶上一颗「全部信任」)。手工贴的说明、「接上」之后那句提示、体检页共用这一句。
 */
export const CODEX_TRUST_HOW = '打开 ChatGPT 里的 Codex → 设置 →「钩子」,把命令里带 agent-hook.sh 的那几条点「信任」'

/**
 * 想手工贴的人看的那段话(设置里「看一下」那条老路)。**不提仓库** —— 命令指的是工作台自己放好的脚本,
 * 跟他机器上有没有源码毫无关系。平常用不着它:「帮我接上」那颗按钮会替他写。
 */
export function wbHooksInstructions(agent: WbHooksAgent): string {
  const tail = [
    '',
    '命令指的是工作台放在固定位置的两个小脚本:工作台每次启动都会把它们放好,升级之后位置不变,',
    '所以这几行贴一次就一直有效。不想手工贴的话,点「帮我接上」,工作台会先给你看一眼再替你写。',
  ]
  if (agent === 'claude') {
    return [
      '把下面这份 JSON **合并**进 `~/.claude/settings.json`:',
      '',
      '1. 如果那个文件还不存在,直接把这份存成 `~/.claude/settings.json` 即可。',
      '2. 如果已经有了,只把 `hooks` 里的四项与 `statusLine` 贴进去 —— **不要整份覆盖**,',
      '   那个文件里还有权限、模型之类别的设置,覆盖掉要一条条找回来。',
      '3. 已经有同名 hook(比如别的工具也挂了 Stop)时,把这一条**加进那一项的数组里**,不要替换。',
      ...tail,
    ].join('\n')
  }
  return [
    '把下面这份 JSON **合并**进 `~/.codex/hooks.json`:',
    '',
    '1. 文件不存在就直接存成 `~/.codex/hooks.json`。',
    '2. 已经有了就只加 `hooks` 里的三项 —— **不要整份覆盖**,那里可能还挂着别的工具',
    '   (本机现在就有 headroom 的两条),覆盖掉它们会一起失效。',
    '3. Codex 没有 Notification 这个事件,所以只有三条;会话区的「等你确认」对 Codex 天生缺席,',
    '   这是它的能力边界,不是漏配。',
    `4. 贴完之后 Codex 还要你放行一次:${CODEX_TRUST_HOW}。没放行之前它一条都不跑。`,
    ...tail,
  ].join('\n')
}

export interface WbHooksResolveOptions {
  /** 这个模块自己所在的目录(生产用 import.meta.url 换算,测试注入)。 */
  moduleDir: string
  /** 此刻生效的事务官仓库(环境变量 > app.json)。没配就不传。 */
  butlerCwd?: string | undefined
  /** 某个路径在不在。生产注入 fs 的 access,测试注入假的。 */
  exists: (path: string) => Promise<boolean>
}

export interface WbHooksRepoRoot { root: string, source: 'plugin' | 'butler_cwd' }

/**
 * 找本机的**开发仓库**根。找不到就 undefined —— **不猜**。
 *
 * ★ 卡 R(2026-09-25)之后**钩子不再走这里**(钩子脚本随包走,见文件头与 hookScripts.ts)。
 * 还在用它的只有两处,而且都有不靠仓库的路:技能正文「仓库优先、包内兜底」(bundledSkills.ts)、
 * 进化那一条技能路(找不到仓库就如实拒绝)。名字没改是为了不去动那两处的接线。
 */
export async function wbHooksResolveRepoRoot(opts: WbHooksResolveOptions): Promise<WbHooksRepoRoot | undefined> {
  const marked = async (candidate: string): Promise<boolean> =>
    await opts.exists(`${trimRoot(candidate)}/${WB_HOOKS_REPO_MARKER}`)

  // 1) 从模块目录逐层往上。worktree 里跑的插件会在这一步命中自己这份 checkout。
  let dir = trimRoot(opts.moduleDir)
  while (dir !== '' && dir !== '/') {
    if (await marked(dir)) return { root: dir, source: 'plugin' }
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    if (parent === dir) break
    dir = parent
  }

  // 2) 装好的 tgz:身边没有仓库,只能问 butler_cwd。
  const butler = opts.butlerCwd === undefined || opts.butlerCwd === '' ? undefined : trimRoot(opts.butlerCwd)
  if (butler !== undefined && await marked(butler)) return { root: butler, source: 'butler_cwd' }

  return undefined
}
