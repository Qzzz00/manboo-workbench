/**
 * 「开发一个小工具」那句话 → 一条待确认的需求 → 交给 DSH 的一件事项(2026-09-21)。
 *
 * 链路只有四步,每一步都要能单独指出来:
 *
 *   ① **认出来**   `POST /butler/item` 收到的文本以那句预填开头(或 body 带 `kind:'dev_tool'`)
 *   ② **先复述**   不建事项、不开会话、不写一个字节 —— 先摆一条「我理解的是…,它叫什么?」
 *   ③ **他确认**   `POST /devtool/confirm { id, name }`(PRD §9 门槛③:不得自行执行)
 *   ④ **派出去**   建一张卡(`createButlerItem`,**不开会话**)+ 走既有派活管线
 *                  (`dispatchItem`,写代码的活 → 能改本机文件的那一家)把**产出规范**交出去
 *
 * ## 第④步 2026-10-01 改了:不再让事务官自己写
 *
 * 原来第④步是「交给 DSH」—— 开一条事务官自己的会话,让她在那条会话里把网页写出来。
 * 维护者 09-28 15:5x 已拍板「**事务官自己不干活**」(设计-事务官做什么不做什么 第四节 C2:
 * 「小组件是代码(B1);09-27 17:15 已拍板『开发活可以派给她机器上的任一家』」),
 * 可那条链路一直没改(交接-0928 第七节第 3 条原话:「**没做**」)。现在改成:
 *
 * - **事务官只写交代 + 验收**。交代就是 `devToolBrief()` 产出的那一份,**原样带上**
 *   (写到哪、只能打哪几条接口、不许引外网)—— 一个字都不重新组织,它是给机器执行的。
 * - **派给她机器上能写代码的那一家**:走既有那条派活管线(`http.ts` 的 `dispatchItem`
 *   → `dispatchRun.ts`),家与包由 `agentSources.pickFamilyPackage` 一处挑 ——
 *   **这里不新造「家→包」表**。挑哪一家由 `dispatchChoice.ts` 的选项表说了算(写代码的活
 *   只列能改本机文件的那几家)。
 * - **一家都派不出去时如实说**(`NO_CODER_FOR_MODULE`),**不退回让事务官自己写** ——
 *   退回去就等于那条拍板从来没生效过。
 * - **做完事务官验收**:读模块清单里出现了这一格没有(`devToolAcceptNote`)。
 *   派出去的活回来了而清单里还是没有 —— 如实说它没照规范落盘,不把「派完了」当成「做好了」。
 *
 * ## 为什么第②步不经模型
 *
 * 复述那段字**是从他自己那句话里切出来的**(去掉预填的开头),一个字都不是生成的 ——
 * 复述最忌讳的就是"复述出了他没说过的意思"。草图(一句话描述界面)确实需要模型,所以
 * 它是一个**可选的端口**(`sketch`):接上了就有,没接上界面如实说一句「这一版没有草图」。
 * **不拿一句模板话冒充草图**(D13)。这一版 `src/index.ts` 没有接它 —— 插件里现在
 * 没有任何一条"问一次模型"的通路,现造一条要碰凭据,那是另一张卡的事。
 *
 * ## 落盘
 *
 * 待确认的那几条落 `~/.dsh/workbench/dev-tools.json`。为什么要落盘:从"说完那句话"到
 * "点确认"中间可能隔着一次刷新、一次重启;那条需求要是只活在内存里,他回来就得重说一遍。
 *
 * **派出去的那几条也落同一份**(`dispatched`,2026-10-01):验收要跨重启 —— 派出去到
 * 落盘之间可能隔着一次热更新,那时候"我在等哪一格出现"只活在内存里就验不成了。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEV_TOOL_DRAFT, type DevToolProposalView } from '../protocol.ts'

export function defaultDevToolFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/dev-tools.json`
}

/** 同时待确认的上限。到顶了就不再收新的 —— 攒一屏待确认的需求,等于一条都没在办。 */
export const MAX_PENDING = 5

/**
 * 这条文本是不是一次"造模块"的请求。
 *
 * 两条判据,**或**的关系:
 * - 以那句预填开头(他点了那颗按钮,而且没把开头删掉)——`DEV_TOOL_DRAFT` 在 protocol.ts,
 *   与按钮共用同一个常量,改文案只改一处;
 * - body 里显式写了 `kind: 'dev_tool'`(手机端、通话里、将来别的入口)。
 *
 * **只认开头,不认"含有"**:他在别的事项里引用了这句话(比如"上次那条『我想在窗口槽…』
 * 的需求做完了吗"),那是一条普通事项,不该被劫持成一次新的造模块。
 */
export function isDevToolRequest(text: string, kind?: unknown): boolean {
  if (kind === 'dev_tool') return true
  return text.trimStart().startsWith(DEV_TOOL_DRAFT)
}

/**
 * 复述:把预填那段开头切掉,剩下的就是他自己说的那部分。
 *
 * 他什么都没接着说(光点了按钮就回车)时回空串 —— 调用方据此拒绝,并如实说一句
 * 「你还没说它要做什么」。**不替他编一个需求**。
 */
export function devToolRestate(text: string): string {
  const full = text.trim()
  if (!full.startsWith(DEV_TOOL_DRAFT)) return full
  return full.slice(DEV_TOOL_DRAFT.length).trim()
}

/**
 * 新模块的目录名。
 *
 * **不拿名字去转拼音/转码**:名字是中文(「番茄钟」),转出来的东西既不好看也不稳定,
 * 而且两个不同的名字可能撞成同一串。`tool-<6 位随机>` 一眼看得出是自定义模块,
 * 而且永远不会撞上工作台自己那些模块 id(projects / notes / files…)。
 */
export function newModuleId(random: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 6; i += 1) out += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)] ?? '0'
  return `tool-${out}`
}

/** 标签上那几个字的上限。窗位叠那一排是横着排的,名字太长会把别的标签挤出去。 */
export const MAX_NAME = 12

/**
 * 草图端口(一句话描述界面)。**接上了才有草图**,没接就整条缺席。
 *
 * 绝不抛是实现方的责任;调用方仍然兜一层(端口是外部实现,兜底不能只写在注释里)。
 * 回空串 / undefined 一律当"这次没出草图"处理 —— 与"没接端口"走同一条路,界面上那句话
 * 也是同一句,因为对用户来说这两件事是同一件:这一版没有草图给你看。
 */
export type DevToolSketch = (need: string) => Promise<string | undefined>

export function checkModuleName(raw: unknown): { ok: true, name: string } | { ok: false, error: string } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') return { ok: false, error: '得给它起个名字,标签上要写' }
  if (name.length > MAX_NAME) return { ok: false, error: `名字最多 ${MAX_NAME} 个字(标签栏放不下)` }
  if (name.includes('\n')) return { ok: false, error: '名字里不能换行' }
  return { ok: true, name }
}

/**
 * 交给 DSH 的那一条事项的正文。
 *
 * 它同时是**产出规范**:写到哪个目录、`module.json` 长什么样、能用哪几个接口、
 * 不许干什么。写在这里而不是仓库的 AGENTS.md 里,是因为 DSH 干活的地方是**用户的工作
 * 目录**,不是这个仓库 —— 它读不到这个仓库的 AGENTS.md。一件事项自带它的全部规范,
 * 这样这条链路不依赖任何"他那边恰好也装了某份说明"。
 *
 * 人话那一份在 `docs/自定义模块-接口.md`,两边要一起改(这个函数里写的是给机器执行的
 * 最小集,文档里写的是给人读的完整说明)。
 */
export function devToolBrief(input: {
  need: string
  moduleId: string
  name: string
  modulesDir: string
  serviceOrigin: string
}): string {
  const dir = `${input.modulesDir}/${input.moduleId}`
  return [
    `请做一个工作台自定义模块。用户要的是:${input.need}`,
    '',
    `它叫「${input.name}」,模块 id 是 ${input.moduleId}。`,
    '',
    '## 产出规范(照这个来,工作台就能直接把它嵌进窗位槽)',
    '',
    `1. 把东西写到 \`${dir}/\`,这个目录自己建。`,
    `2. \`${dir}/module.json\`:`,
    `   \`{"version":1,"id":"${input.moduleId}","name":"${input.name}","created_at":"<ISO 时间>","source":"dsh","entry":"index.html"}\``,
    `3. \`${dir}/index.html\`:**单文件**,样式与脚本都写在里面。可以另放 css/js/图片,`,
    '   但**不许引任何外网地址**(CDN、字体、图床都不行)—— 工作台给这个页面下了 CSP,',
    '   外网脚本在浏览器那一层就会被拦掉,你引了也不会生效。',
    '4. 页面铺满整个窗口(`html,body{margin:0;height:100%}`),它会被嵌在窗位槽那块矩形里。',
    '   深色背景,工作台是深色的。',
    '',
    '## 它能用的接口(直接 `fetch(\'/state\')` 这样写相对路径即可)',
    '',
    '- `GET /state` —— 工作台此刻的整份快照(事项、随手记、会话、额度、布局…),**读什么都从这里读**',
    '- `POST /task/create`、`POST /task/move`、`POST /task/update` —— 事项',
    '- `POST /note/add`、`POST /note/remove` —— 随手记(列表在 `/state.notes`)',
    '- `GET /module/data?name=<采集器名>` —— 她的采集器采回来的那一页文字(`{ ok, name, at, text, last }`;',
    '  `text` 是页面上看得见的字,原样;`at` 是采成的时刻;没采成过时 `text` 为空、`last` 里写为什么)。',
    '  **把字变成数是你这个页面的事**:用正则或按行找,找不到就在页面上明说「这一份读不懂了,最后一次能读的是 <at>」,不编数。',
    '- `POST /xhs/refresh` —— 让工作台现在去她的小红书后台取一次数(数据复盘那一格的「刷新」)。',
    '  **受它原有的频率闸**:两次之间至少 10 分钟,没到就原样回上一次的结果 —— 别写重试循环。',
    '  取回来的数在 `/state.xhs` 里(账号、几个区间、折线;读不到的格子**缺席**,不要补零)。',
    '- `POST /files/asset-reveal` —— 在 Finder 里打开**一个素材文件夹**:`{"name":"脚本"}`。',
    '  只收文件夹名,路径由工作台自己查(`/state.template.asset_dirs` 里是「名字 → 绝对路径」,',
    '  名字就从那儿读)。名字不在那一份里回 404。**任意路径的 `/files/reveal` 打不通**,别试。',
    '',
    '**就这九条,别的一条都打不通**(2026-10-01 起)。模块页面跑在**自己的来源**上,',
    '工作台那边只给这九条开跨源白名单,表外的一律 403 —— 那不是规范,是一道真门。',
    '(任意路径的 `POST /files/reveal` 2026-09-22 从这张表上去掉了:它收任意路径、还会弹 Finder 窗口。',
    ' 2026-10-01 换成了上面那条只收素材文件夹名的。)',
    '容器会往页面里注入 `window.WB_API_BASE`(工作台服务地址)与 `window.WB_MODULE_TOKEN`',
    '(这个模块专用的短期令牌,会自动续),并且包了一层 `fetch`:**你照上面那样写相对路径就行**,',
    '要自己发请求就用 `WB_API_BASE` + `Authorization: Bearer ${WB_MODULE_TOKEN}`。',
    '',
    '**页面里用不了 localStorage / sessionStorage / IndexedDB / cookie**:那块 iframe 加了',
    '`sandbox`,是不透明来源,碰这几样会抛 SecurityError(记得包 try/catch)。要记东西:',
    '小工具自己的就放内存(切走不卸载,还在);要留得住的就落一条随手记或一件事项。',
    '',
    '**不给凭据、不给 shell**:页面里不许出现任何 API Key/密码,也没有执行命令的接口。',
    '',
    `装好之后不用重启工作台:窗位叠那一排最右边会自己多出一个叫「${input.name}」的标签`,
    '(工作台每秒读一次清单),点它就能用。',
    '',
    `(服务端地址:${input.serviceOrigin})`,
  ].join('\n')
}

/**
 * 这台机器上一家能写代码的 Agent 都派不出去时那句话(2026-10-01,C2)。
 *
 * **常量导出**,断言用它、路由回它、技能里引它 —— 三处同一句。
 * 它说的是事实(哪一家能改本机文件由 `dispatchChoice.ts` 的选项表判),
 * 而**不是**「那我自己写吧」:那条退路 09-28 就被拍掉了。
 */
export const NO_CODER_FOR_MODULE
  = '这台电脑上没有能写代码的 Agent —— 小组件是代码,得派给能改你电脑上文件的那一家(Claude / Codex 的后台那条路)。'
  + '装上(或登上)一家再点「就这样」,这条需求我给你留着,一个字都没丢。'

/**
 * 派出去的一条(等着验收)。**落盘**,因为验收要跨重启。
 */
export interface DevToolDispatchRecord {
  /** 那张卡。 */
  task_id: string
  module_id: string
  name: string
  /** 派给了哪一家(登记表里的那个 id,比如 `codex`)。 */
  family: string
  /** 派出去的时刻(ISO)。 */
  at: string
}

/** 落盘那一份。 */
export interface DevToolFile {
  version: 1
  pending: DevToolProposalView[]
  /** 派出去、还没验收的那几条(2026-10-01)。老文件里没有这一格 = 一条都没有。 */
  dispatched?: DevToolDispatchRecord[]
}

/**
 * 验收那一下(2026-10-01,C2 的后半句:「事务官只写交代 + 验收」)。**纯函数、不经模型**:
 * 判据只有一条 —— **模块清单里有没有这一格**。
 *
 * 三种结果:
 * - 清单里有了 → `{ done: true }` + 那句「做好了」:这才叫做好了;
 * - 清单里没有、那张卡还在办 → `undefined`:**什么都不说**,接着等;
 * - 清单里没有、那张卡已经收尾了(回来了 / 阻塞了 / 被取消了)→ `{ done: true }` + 如实说
 *   它没照规范落盘。**不把「派完了」说成「做好了」**(D13)。
 */
export function devToolAcceptNote(
  record: DevToolDispatchRecord,
  input: { moduleIds: readonly string[], taskStatus?: string },
): { done: boolean, note: string } | undefined {
  if (input.moduleIds.includes(record.module_id)) {
    return { done: true, note: `「${record.name}」做好了:模块清单里读到了这一格(${record.module_id}),窗位叠最右边点它就能用` }
  }
  // 还在办(含"这张卡找不着了"——那多半是她刚把卡删了,下一拍再看)。
  if (input.taskStatus === undefined || !['confirm', 'done', 'blocked', 'canceled'].includes(input.taskStatus)) return undefined
  return {
    done: true,
    note: input.taskStatus === 'canceled'
      ? `「${record.name}」这件取消了,模块清单里没有这一格 —— 没落盘`
      : `「${record.name}」那边收工了,可模块清单里还是没有 ${record.module_id} 这一格 —— 它没按交代落到盘上,我没拿它当做好了`,
  }
}

/**
 * 验收隔多久看一次(2026-10-01)。挂在既有那根节拍上,所以这个数就是「一拍里最多做一次 I/O」——
 * 在等验收的时候每 10 秒读一次模块清单 + 一次看板,一条都没在等时连这两次都不做。
 */
export const DEV_TOOL_ACCEPT_EVERY_MS = 10_000

export interface DevToolStore {
  load: () => Promise<void>
  pending: () => readonly DevToolProposalView[]
  find: (id: string) => DevToolProposalView | undefined
  add: (proposal: DevToolProposalView) => Promise<{ ok: boolean, error?: string }>
  drop: (id: string) => Promise<boolean>
  /** 派出去了,记一条等验收(2026-10-01)。 */
  markDispatched: (record: DevToolDispatchRecord) => Promise<void>
  dispatched: () => readonly DevToolDispatchRecord[]
  /** 验收过了(不管是「做好了」还是「没落盘」),这一条不再等。 */
  dropDispatched: (moduleId: string) => Promise<boolean>
}

export function createDevToolStore(options: { file: string }): DevToolStore {
  let pending: DevToolProposalView[] = []
  let dispatched: DevToolDispatchRecord[] = []

  const save = async (): Promise<void> => {
    await mkdir(dirname(options.file), { recursive: true })
    const payload: DevToolFile = { version: 1, pending, ...(dispatched.length === 0 ? {} : { dispatched }) }
    await writeFile(options.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(options.file, 'utf8')) as Partial<DevToolFile>
        // 文件坏了 / 没有 = 一条待确认都没有。**不抛**:一份读不懂的 json 不该让工作台起不来。
        pending = Array.isArray(raw.pending)
          ? raw.pending.filter((item): item is DevToolProposalView =>
            typeof item?.id === 'string' && typeof item.request === 'string' && typeof item.module_id === 'string')
          : []
        dispatched = Array.isArray(raw.dispatched)
          ? raw.dispatched.filter((item): item is DevToolDispatchRecord =>
            typeof item?.task_id === 'string' && typeof item.module_id === 'string' && typeof item.name === 'string')
          : []
      }
      catch { pending = []; dispatched = [] }
    },
    pending() { return pending },
    find(id) { return pending.find(item => item.id === id) },
    async add(proposal) {
      if (pending.length >= MAX_PENDING) {
        return { ok: false, error: `还有 ${pending.length} 条没确认,先把它们处理掉` }
      }
      pending = [...pending, proposal]
      await save()
      return { ok: true }
    },
    async drop(id) {
      const next = pending.filter(item => item.id !== id)
      if (next.length === pending.length) return false
      pending = next
      await save()
      return true
    },
    async markDispatched(record) {
      dispatched = [...dispatched.filter(one => one.module_id !== record.module_id), record]
      await save()
    },
    dispatched() { return dispatched },
    async dropDispatched(moduleId) {
      const next = dispatched.filter(one => one.module_id !== moduleId)
      if (next.length === dispatched.length) return false
      dispatched = next
      await save()
      return true
    },
  }
}
