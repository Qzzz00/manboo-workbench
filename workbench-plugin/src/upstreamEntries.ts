/**
 * 上游 DSH 自己带的那些入口:一张表说清每一个「用户会在哪看到它、上游默认开不开、我们怎么办」
 * (2026-09-25 升到 0.1.7-rc.2,卡 U2;来源:评估第二节 2.3「要防的」与决策记录 09-25 夜那两节)。
 *
 * ## 为什么要这张表
 *
 * 我们的界面是**一整层盖在 DSH 网页上面**(`shell.overlay` 席位)。DSH 自己的界面只在两处露出来:
 * ① 点开一条事项进 DSH 的对话页(那时我们的浮层让开);② 走到 DSH 自己的设置页。
 * 0.1.7 的默认组合比 0.1.2 多了一批面板与入口,**它们就从这两处缝里露出来**;
 * 还有几个更麻烦的,注册的是**跟我们同一个席位**(`shell.overlay`,整屏那一层),
 * 按一下快捷键就画在工作台上面 —— 不是「缝里露出来」,是直接盖在我们身上。
 *
 * 关掉的手段只有一种:**profile patch 里给那一行加 `disabled: true`**(上游自己也这么做,
 * 见 `packages/bundle/web-app/cordis.patch.yml` 里 `time-context` / `schedule` / `ui-schedule` 三行)。
 * 客户端这一层**没有**能关掉别人插件的办法:
 * - 用 CSS 藏:上游渲染出来的 DOM 只有 `[data-slot="<席位名>"]` 这一个锚点,**没有按 id 分的属性**,
 *   要藏就得藏掉整个席位 —— 会把同席位里我们想留的东西(右侧栏的文件 / 改动 / 文档预览)一起藏掉;
 * - 用「同 id 更低优先级去遮」(上游 list / keyed 席位支持的 shadowing):做得到,但那是**写死在插件里**,
 *   维护者就再也没法在自己的配置里把终端打开了 —— 与决策记录 09-25 夜「用户默认关,维护者配置里开」冲突。
 *
 * 所以这张表是**给 patch 用的清单**,不是运行时开关。`ROWS_OFF_FOR_USERS` 就是要写 `disabled: true` 的那几行。
 * 守门在 `tests/client-upstream-seats.test.ts`:表里每一行的 id 都得在上游组合里真的存在(打错字就红),
 * 每一行记的「上游默认开不开」也要跟上游组合对得上(上游哪天翻了默认值,我们当场知道)。
 */

/** 一个上游入口在组合里的那一行,加上我们的处置。 */
export interface UpstreamEntry {
  /** 组合(`cordis.patch.yml`)里那一行的 `id` —— patch 按这个 id 覆盖。 */
  readonly id: string
  /** 那一行的包名,只为看表的人对得上号。 */
  readonly pkg: string
  /** 用户会看到什么。 */
  readonly what: string
  /** 从哪儿露出来。 */
  readonly where: string
  /** 上游在 web 组合里的默认:`on` 开,`off` 写了 `disabled: true`,`conditional` 按 profile 判。 */
  readonly upstreamDefault: 'on' | 'off' | 'conditional'
  /** 我们给用户的档:`off` 要在 patch 里关掉,`on` 留着,`undecided` 灰度里逐项定(决策记录 09-25 夜)。 */
  readonly forUsers: 'off' | 'on' | 'undecided'
  /** 为什么这么定。 */
  readonly why: string
}

/**
 * 评估第二节 2.3 点名要防的六个,加上它们的 host 半区与同族行。
 * Team(Agent Team)不在这张表里:0.1.7 的 web 组合里**一行都没有**(实验插件,要手动 add),
 * 我们不装,所以没有要关的东西 —— 这一条由守门里那条「组合里搜不到 team」钉住。
 */
export const UPSTREAM_WEB_ENTRIES: readonly UpstreamEntry[] = [
  {
    id: 'ui-sidebar-terminal',
    pkg: '@deepseek-ai/dsh-client-ui-sidebar-terminal',
    what: '事项会话页右侧栏里的「终端」页签,能用系统用户权限跑 shell',
    where: '对话页右侧栏',
    upstreamDefault: 'on',
    forUsers: 'off',
    why: '决策记录 2026-09-25 夜:用户默认关(系统用户权限、绕过 agent 沙箱),维护者自己的配置里开',
  },
  {
    id: 'terminal-controller',
    pkg: '@deepseek-ai/dsh-api-terminal-controller',
    what: '上面那个页签的 host 半区(真正起 shell 的那一半)',
    where: '不露面',
    upstreamDefault: 'on',
    forUsers: 'off',
    why: '关了界面还留着服务没有意义;两半一起关,用户机器上就没有这条能跑 shell 的路',
  },
  {
    id: 'ui-shortcuts',
    pkg: '@deepseek-ai/dsh-client-ui-shortcuts',
    what: '⌘/ 弹出来的「快捷键」整屏参考页,以及设置里的快捷键那一行',
    where: '**跟我们同一个席位**(`shell.overlay`,id `shortcuts`)—— 按一下就画在工作台上面',
    upstreamDefault: 'on',
    forUsers: 'off',
    why: 'U2 复核发现:它不是「缝里露出来」,是同席位盖上来。用户面不需要快捷键表('
      + '我们的界面没有快捷键),留着只会在壳里被误触。注意只关这一行,'
      + '**不要关 `shortcuts`**(那是命令注册表,`ui-settings-general` 要用它注册「打开设置」)',
  },
  {
    id: 'ui-sidebar-browser',
    pkg: '@deepseek-ai/dsh-client-ui-sidebar-browser',
    what: '右侧栏里的「浏览器」页签',
    where: '对话页右侧栏',
    upstreamDefault: 'conditional',
    forUsers: 'off',
    why: '上游自己就写了 `disabled: profileContext.name !== \'desktop\'` —— web profile 天然是关的,'
      + '我们不用补。列在这里只为让盘查有据可查',
  },
  {
    id: 'ui-plugin-manager',
    pkg: '@deepseek-ai/dsh-client-ui-plugin-manager',
    what: '侧栏那颗「插件」图标 + 装 / 停 / 卸插件的整页',
    where: '侧栏 `sidebar.panellist` + 中栏 `main`',
    upstreamDefault: 'on',
    forUsers: 'off',
    why: '决策记录 2026-09-26 凌晨(关闭清单再定)拍定:对用户默认关。'
      + '装插件这件事由安装器按锁定清单做(C3),他点一下装个别的插件进来,'
      + '下一次 `npm ci` 就把它冲掉而他不会知道为什么。'
      + '只读的那一页(`ui-settings-plugin-inventory`)留着 —— 想看装了什么仍看得到',
  },
  {
    id: 'ui-settings-account',
    pkg: '@deepseek-ai/dsh-client-ui-settings-account',
    what: '侧栏底部的账号菜单、登录框、DeepSeek 账号与额度那一页',
    where: '侧栏 `settings.launcher` + **`shell.overlay`(两条:`desktop-onboarding`、`account.platform-page`)**',
    upstreamDefault: 'on',
    forUsers: 'off',
    why: '决策记录 2026-09-26 凌晨:**账号页对用户默认关**,等以后接 DeepSeek 账号额度时再开。'
      + '定这一条的是 U2 查到的那条绕过口:登录框里「改用 API Key」会调 '
      + '`openOnboarding(\'deepseek-official\')`,那是 0.1.7 新增的「点名要某一步」入口,'
      + '`onboardingGate` 按 order 排的那一套拦不住 —— 留着这一页,壳里就可能弹出上游'
      + '那个「添加一个 API Key」框。它另占 `shell.overlay` 两条(`desktop-onboarding`、'
      + '`account.platform-page`),都跟着这一行一起关掉',
  },
  {
    id: 'ui-settings-models',
    pkg: '@deepseek-ai/dsh-client-ui-settings-models',
    what: '设置里的「模型」页,**以及首次使用时自动弹的那个「添加一个 API Key 开始使用」框**',
    where: '设置页里的一节 + `settings.onboarding` 槽的 `deepseek-official` 那一步(整屏遮罩,把 `#root` 设成 inert)',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '**页留着、自动弹的那一步关掉**(2026-09-26 卡 AK)—— 这是表里唯一一个'
      + '「不写 `disabled: true`、只写一个 config」的处置,所以特意列进来。'
      + '那个框的判据是「一个能用的 provider 都没有」,而我们那条中转路由的令牌'
      + '**要用户注册之后我们的服务器才发下来**,第一次打开的那一刻物理上满足不了;'
      + '关它用的是上游 0.1.7 自己新加的 `credentialOnboarding`(注释原话:没有原生壳'
      + '接管凭据引导时才提供这一步),工作台就是那个壳。整段理由与落笔在 '
      + '`src/server/setup/install.ts` 的 `PROFILE_MODELS_ONBOARDING_BLOCK`;'
      + '壳里那道 `onboardingGate` 仍然留着当第二道',
  },
  {
    id: 'ui-schedule',
    pkg: '@deepseek-ai/dsh-client-ui-schedule',
    what: '侧栏那颗「任务」图标 + 定时任务管理页',
    where: '侧栏 `sidebar.panellist` + 中栏 `main` + `shell.overlay`(删除提示条)',
    upstreamDefault: 'off',
    forUsers: 'undecided',
    why: '上游 web 组合默认就关。决策记录 09-25 夜:定时任务作为事务官自用工具接(另开卡),'
      + '用户面的例程仍用我们自己的',
  },
  {
    id: 'ui-sidebar-files',
    pkg: '@deepseek-ai/dsh-client-ui-sidebar-files',
    what: '右侧栏「文件」页签(工作目录文件树)',
    where: '对话页右侧栏',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '评估第八节第 2 条建议留的三个之一:点开一条事项时能看文件,是真收益',
  },
  {
    id: 'ui-sidebar-documentpreview',
    pkg: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    what: '右侧栏「文档」页签(Markdown / 代码 / PDF / Office 预览)',
    where: '对话页右侧栏',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '同上,留',
  },
  {
    id: 'ui-deliverables',
    pkg: '@deepseek-ai/dsh-client-ui-deliverables',
    what: '对话里每一回合的「改动」卡(这一轮动了哪些文件)',
    where: '对话页正文尾部',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '决策记录 2026-09-26 凌晨点名留的三样之一(文件 / 改动 / 文档预览)。'
      + '列在表里是为了让守门也盯着它 —— 哪天上游把它默认关了,我们当场知道',
  },
  {
    id: 'ui-settings-plugin-inventory',
    pkg: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    what: '设置「插件」里那张**只读**的插件清单(装了什么、版本)',
    where: '设置页里的一个页签',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '决策记录 2026-09-26 凌晨:插件管理页(能装 / 停 / 卸)关,这张只读清单**留**。'
      + '只读的看一眼不会把安装器按锁定清单装好的东西改坏,而「我这台装了什么」是个正当问题',
  },
  {
    id: 'shortcuts',
    pkg: '@deepseek-ai/dsh-client-shortcuts',
    what: '命令注册表(不露面,别的插件靠它注册命令)',
    where: '不露面',
    upstreamDefault: 'on',
    forUsers: 'on',
    why: '**留,而且是必须留**:`ui-settings-general` 用它注册「打开设置」,关了连设置入口一起坏。'
      + '要关的是 `ui-shortcuts`(⌘/ 那张整屏参考页)—— 两个 id 差三个字,'
      + '所以把它也写进表里,免得哪天谁照着「关快捷键」把这一行关掉',
  },
]

/**
 * 要在 profile patch 里写 `disabled: true` 的那几行(`forUsers: 'off'` 且上游默认不是已经关掉的)。
 * `ui-sidebar-browser` 上游自己就关了,不必补,所以不在这里面。
 */
export const ROWS_OFF_FOR_USERS: readonly string[] = UPSTREAM_WEB_ENTRIES
  .filter(e => e.forUsers === 'off' && e.upstreamDefault === 'on')
  .map(e => e.id)
