/**
 * **这一回合只下发用得上的那几件工具**(2026-10-03,卡「首声提速」甲;决策记录 10-03 早 ⑥丙)。
 *
 * ## 为什么
 *
 * Air 诊断包 10-02 那 326 个回合:act 路首声 p95 **3762ms**、真回答中位 **7860ms**,
 * 而 chat 路(**一件工具都不带**、同一份人设)首声 p95 **1934ms**。两条路的差就是
 * 「带全部工具 + 工具来回」那一笔。全部 16 件工具的说明书 + 参数表加起来
 * **9544 字**(`tests/intent-tools-1003.test.ts` 现数出来的),是人设本身(约 3090 字)的三倍 ——
 * 每一个要办事的回合都把这 9544 字重发一遍,而她那一句十有八九只用得上其中一件。
 *
 * ## 这个文件是什么
 *
 * **意图 → 那一组工具** 的对照表,**只有这一处**(卡上原话:「工具与意图的对照表放一处常量」)。
 * 意图是 `turnRoute.ts` 判出来的(关键词,不经模型);这里只回答「这个意图手上该有哪几件」。
 *
 * 三条纪律:
 *
 *   ① **分不出意图就退回全量**({@link toolsForIntent} 回 `undefined`)。
 *      少给一件工具的代价是「她本来能办的事办不了」—— 两种错里贵的那一种
 *      (turnRoute.ts 开头那句「宁可慢别错」)。Air 那 215 个 act 回合里
 *      认得出意图的占七成,剩下三成照旧带全套;
 *   ② **组里要带上「它会指过去的那几件」**。工具说明书里互相点名
 *      (`wb_remember_item` 写着「她要的是现在就去办,用 wb_dispatch_item」),
 *      点到的那一件不在手上,模型就会答应一件它办不成的事。所以每组都宁可宽一点;
 *   ③ **挂断那一件永远在**({@link ALWAYS_TOOLS})。她在交代事情中间说一句「先这样吧」
 *      是常事,而挂断那件工具只有 252 字 —— 为它省这一点不值得。
 *
 * 纯数据 + 纯函数:不认识 LiveKit、不认识 `session`。工具名一律从 `tools.ts` / `farewell.ts`
 * 的常量取(**不抄字符串**:抄错的那一行会静默地变成「这一组少一件」)。
 */
import { TOOL_END_CALL } from './farewell.ts'
import { HUB_TOOLS } from './hubTools.ts'
import {
  TOOL_ASK_BUTLER,
  TOOL_DISPATCH,
  TOOL_DOING,
  TOOL_HAND,
  TOOL_ANSWER_MEETING,
  TOOL_LAYOUT,
  TOOL_PLAN_MEETING,
  TOOL_PREFERENCE,
  TOOL_PROGRESS,
  TOOL_PUBLISH_PLAN,
  TOOL_RELAY_SESSION,
  TOOL_REMEMBER,
  TOOL_SEARCH_FILES,
  TOOL_SEND_FILE,
  TOOL_SESSION_STATUS,
  TOOL_TODO_VIEW,
  TOOL_VOICE,
  TOOL_WATCH_REPLY,
} from './tools.ts'

/** 每一组都有的那几件。见文件头第 ③ 条。 */
export const ALWAYS_TOOLS: readonly string[] = [TOOL_END_CALL]

/**
 * ——— 几个搭着用的小捆 ———
 *
 * 不是为了少打字,是为了**让「这一组为什么是这几件」读得出来**:
 * 「查一眼」永远是那四件,「让别家动手」永远是那四件 —— 哪一组用了哪几捆,一行就看完。
 */
/** 查一眼(看板上的事、某条对话、我以前说过的话)。 */
const LOOKUP_BUNDLE: readonly string[] = [TOOL_DOING, TOOL_PROGRESS, TOOL_ASK_BUTLER, TOOL_SESSION_STATUS, ...HUB_TOOLS]
/**
 * 让别家动手 / 捎句话 / 盯回复 / 给在办的那件事补一句。
 *
 * 2026-10-13 下午跟着带上**记发布计划**那一件:派活那件工具的说明书与它门口那道拦
 * (「记到日历的不是派活,改用 `wb_publish_plan`」)都点着它的名 —— 按文件头第 ② 条,
 * 点到的那一件必须在手上,不然模型会答应一件它办不成的事。
 */
const SEND_BUNDLE: readonly string[] = [TOOL_DISPATCH, TOOL_RELAY_SESSION, TOOL_WATCH_REPLY, TOOL_HAND, TOOL_PUBLISH_PLAN]
/**
 * 记一笔 / 记成规矩 / 开一张需求卡 / 登记一场待开的会(2026-10-10:「记一下,下午三点跟 B 客户谈」)/
 * 排进发布计划(2026-10-13 下午:「记一下,20 号发一个大赛回顾的视频」)。
 */
/*
 * 2026-10-28(A2,理解中枢):查一眼、记一笔两捆与派活那一组带上写板子的整张命令表(hubTools.ts)——
 * 意图是关键词判的,判成「问一眼」就把建卡 / 派活的工具摘掉,正是 10-22「帮我建一个待办」被回
 * 「这一回合没有能建待办的活」的那一下。是问是办由模型定,手上得有那几件。
 */
const NOTE_BUNDLE: readonly string[] = [
  ...HUB_TOOLS,
  TOOL_REMEMBER,
  TOOL_PREFERENCE,
  TOOL_PLAN_MEETING,
  TOOL_ANSWER_MEETING,
  TOOL_PUBLISH_PLAN,
]
/** 找文件 / 传文件。 */
const FILE_BUNDLE: readonly string[] = [TOOL_SEARCH_FILES, TOOL_SEND_FILE]

/** 一个意图配哪几件工具,外加一句「为什么是这几件」。 */
export interface IntentTools {
  /** 意图 id —— 与 `turnRoute.ts` 里 {@link ActIntent.id} 同一个字符串。 */
  readonly id: string
  /** 这一组手上有哪几件({@link ALWAYS_TOOLS} 之外的)。 */
  readonly tools: readonly string[]
  /** 这一组**故意不给**哪一类,一句话。只给人看(交接与日志),代码不读它。 */
  readonly without: string
}

/**
 * ★ **对照表就这一张**。
 *
 * 意图 id 全来自 `turnRoute.ts`:`ACT_INTENTS`(记 / 派 / 换音色 / 文件)、
 * `LOOKUP_INTENT` / `RELAY_INTENT`(butlerRoute 那三类)、`FOLLOW_ACT_INTENTS`
 * (动作词那七组)。**那边有一个 id,这边就得有一行** —— `tests/intent-tools-1003.test.ts`
 * 盯着这件事(漏一行就是「这个意图悄悄退回全量」,省不下来还查不出来)。
 */
export const INTENT_TOOLS: readonly IntentTools[] = [
  {
    // 「记下 / 记一下 / 记住」。说明书里它自己就指着另外三件(去办 / 规矩 / 需求卡),所以一起给。
    id: 'remember',
    tools: [...NOTE_BUNDLE, TOOL_DISPATCH],
    without: '不给查一眼那四件、不给文件、不给版面、不给换音色',
  },
  {
    // 「派单 / 派给 / 开一张 / 交给事务官」。
    id: 'dispatch',
    tools: [...SEND_BUNDLE, ...HUB_TOOLS, TOOL_DOING],
    without: '不给文件、不给版面、不给换音色',
  },
  {
    // 「换音色 / 换嗓子」——**只有一件**。这一组是省得最干净的那一组(641 字 vs 9544 字)。
    id: 'voice',
    tools: [TOOL_VOICE],
    without: '别的一件都不给',
  },
  {
    // 「发给我 / 找一下文件 / 把文件」。
    id: 'file',
    tools: [...FILE_BUNDLE],
    without: '别的一件都不给(找文件与传文件是闭着的一对)',
  },
  {
    // 「什么事 / 有什么要我确认 / 进度 / 做到哪了 / 我以前说过」(butlerRoute 的 item + memory)。
    id: 'lookup',
    tools: [...LOOKUP_BUNDLE],
    without: '不给派活捎话(她只是问一眼;真要派,下一句自己会说)、不给文件、不给版面',
  },
  {
    // 「给那条会话捎句话 / 给豆包发个信息」(butlerRoute 的 relay)。
    id: 'relay',
    tools: [...SEND_BUNDLE, TOOL_SESSION_STATUS, TOOL_DOING],
    without: '不给文件、不给版面、不给换音色、不给记规矩',
  },
  {
    // 动作词第一组:「打开 / 关掉 / 盖掉 / 新开一条 / 播放 / 发布 / 导出 / 安装」——
    // 在电脑上动手,而她自己不动手(09-28 拍板),所以一律是让别家去做。
    id: 'operate',
    tools: [...SEND_BUNDLE, TOOL_DOING, TOOL_SESSION_STATUS],
    without: '不给文件、不给版面、不给换音色、不给记规矩',
  },
  {
    // 动作词第二组:「换成 / 换一个 / 改成 / 挪到 / 放进 / 加一个 / 做一个」——
    // **这一组是最含糊的一组**:同一个「挪到」可能是「把那条挪到发布计划里」(看板上的事),
    // 也可能是「把消耗数据挪到项目区下面」(屏幕上的版面),还可能是「换个女声」(音色)。
    // 词分不开,所以三样都给 —— 认错的方向宁可宽。
    // 2026-10-12:「把待办改成卡片 / 改回列表」换的是「今天的待办」那一格的显示,同属版面这一类。
    id: 'change',
    tools: [...SEND_BUNDLE, TOOL_LAYOUT, TOOL_TODO_VIEW, TOOL_VOICE, TOOL_DOING],
    without: '不给文件、不给查进度那两件、不给记规矩',
  },
  {
    // 动作词第三组:「来个 / 给我来 / 要一个」(真机换音色第二步「那给我来个调皮公主」)。
    id: 'pick',
    tools: [TOOL_VOICE, ...SEND_BUNDLE],
    without: '不给文件、不给版面、不给查一眼那几件',
  },
  {
    // 动作词第四组:「打电话 / 给我打 / 提醒我 / 汇报」—— 排一通回电要先落到一件事上。
    id: 'callout',
    tools: [...SEND_BUNDLE, ...NOTE_BUNDLE, TOOL_DOING],
    without: '不给文件、不给版面、不给换音色',
  },
  {
    // 动作词第五组:「以后叫 / 你叫 / 叫我 / 改名」—— 称呼走的是「记一条规矩」那一件(kind:'address')。
    id: 'address',
    tools: [TOOL_PREFERENCE, TOOL_REMEMBER],
    without: '别的一件都不给',
  },
  {
    // 动作词第六组:「查 / 搜 / 找一下 / 看一下 / 总结 / 核对」—— 自己查不到的就去问别家。
    id: 'find',
    tools: [...LOOKUP_BUNDLE, ...SEND_BUNDLE],
    without: '不给文件(「找文件」有自己那一组)、不给版面、不给换音色、不给记规矩',
  },
  {
    // 动作词第七组:「还剩 / 额度 / 进度 / 跑完了 / 有哪几家 / 天气」——
    // 额度与进度在工作台这边查,天气那种得让别家去跑。
    id: 'status',
    tools: [...LOOKUP_BUNDLE, ...SEND_BUNDLE],
    without: '不给文件、不给版面、不给换音色、不给记规矩',
  },
  {
    // ★ 「介绍一下自己 / 你是谁 / 你能做什么」(2026-10-13 夜,卡 V):闲聊路、**零工具**,
    // 只为让人设里【介绍自己】那一段(8791 标 `intro`)跟着这一回合带上。这一行在是为了对照用例「那边有一个 id,这边就得有一行」。
    id: 'intro',
    tools: [],
    without: '一件都不给:介绍自己只说话',
  },
]

/**
 * 这个意图手上该有哪几件。**认不出的意图 / 没有意图 → `undefined` = 全量**(文件头第 ① 条)。
 * 回来的那一份含 {@link ALWAYS_TOOLS},去过重,顺序照表上的。
 */
export function toolsForIntent(intent: string | undefined): readonly string[] | undefined {
  if (intent === undefined || intent === '') return undefined
  const row = INTENT_TOOLS.find(one => one.id === intent)
  if (row === undefined) return undefined
  return [...new Set([...row.tools, ...ALWAYS_TOOLS])]
}

/**
 * ★ **这一句交代了好几件事:那几组的工具一起给**(2026-10-03,卡 fix/voice-route-zh;
 * 审计 voice.md 第 3 条)。
 *
 * 一句「把文件发给我,再换个音色」命中两个意图,而上面那个单意图版只认第一个 ——
 * 手上只剩换音色那一件,文件那两件直接消失;工具说明书里那句话于是让模型
 * 「只说打算」({@link intentToolNote}),也就是她应了、事情只办一半。
 *
 * 两条纪律照旧(与 {@link toolsForIntent} 同一条道理):
 *   · **里头有一个认不出的意图 → 整个退回全量**(`undefined`)。
 *     不知道那一件要什么,就不能替它裁 —— 「不许漏能力」是文件头第 ① 条;
 *   · 回来的那一份含 {@link ALWAYS_TOOLS}、去过重,顺序按 `intents` 的顺序。
 */
export function toolsForIntents(intents: readonly string[] | undefined): readonly string[] | undefined {
  if (intents === undefined || intents.length === 0) return undefined
  const union: string[] = []
  for (const intent of intents) {
    const want = toolsForIntent(intent)
    if (want === undefined) return undefined
    union.push(...want)
  }
  return [...new Set(union)]
}

/**
 * 从「全套」里挑出这几件。**挑不着的名字一律跳过**(不抛):
 * 某件工具这台机器上本来就没有(没配音色服务、没有设备目录),那就是真的没有。
 *
 * 挑完一件都不剩 → 回 `undefined`,调用方按**全量**走:
 * 「这一回合一件工具都没有」在 act 路上是另一种错(她会答应一件办不成的事)。
 */
export function pickTools<T>(
  all: Readonly<Record<string, T>>,
  names: readonly string[],
): Record<string, T> | undefined {
  const picked: Record<string, T> = {}
  for (const name of names) {
    const tool = all[name]
    if (tool !== undefined) picked[name] = tool
  }
  return Object.keys(picked).length === 0 ? undefined : picked
}

/**
 * ★ **这一回合到底递哪几件**(2026-10-03)。一个纯函数,`agent.ts` 的 `llmNode` 只照它办 ——
 * 判断在这儿才有用例看得着(那一层要真起一个 LiveKit 会话才跑得到)。
 *
 * 回 `undefined` 的三种情况,意思都是**照旧全量**:
 *   · 开关关着(`WORKBENCH_CHANNEL_TOOLS_BY_INTENT=off`);
 *   · 认不出意图(卡上原话「分不出意图时退回全量(不许漏能力)」);
 *   · 这台机器上那一组一件都没装上(没配音色服务、没有设备目录 —— 见 {@link pickTools})。
 *
 * `intents`(2026-10-03,卡 fix/voice-route-zh):这一句命中的**全部**意图。
 * 有它就按**并集**({@link toolsForIntents});没有才退回单个 `intent`;两样都没有 → 全量。
 */
export function planTurnTools<T>(input: {
  on: boolean
  intent?: string
  intents?: readonly string[]
  all?: Readonly<Record<string, T>>
}): { names: readonly string[], tools: Record<string, T> } | undefined {
  if (!input.on || input.all === undefined) return undefined
  const want = input.intents !== undefined && input.intents.length > 0
    ? toolsForIntents(input.intents)
    : toolsForIntent(input.intent)
  if (want === undefined) return undefined
  const tools = pickTools(input.all, want)
  if (tools === undefined) return undefined
  return { names: Object.keys(tools), tools }
}

/**
 * **人设里跟着只讲那几件**(卡上原话)那一行。
 *
 * 为什么是「一行补在这一次的上下文里」而不是改人设:人设由 8791 下发
 * (`GET /channel/persona`,`workbench-plugin/src/server/channel.ts` 拼的),
 * 这张卡只动 `channel-worker/`;而且这一行**一个回合就过期** ——
 * 和 `turnRoute.ts` 的 `ackedNote` 同一条道理(`updateInstructions` 是异步的,
 * 抢不赢回合提交,也不该留到下一回合)。所以它走的是 `llmNode` 里那份 chatCtx 的副本。
 *
 * 话里**只说手上有什么**,不说「别的工具被收走了」—— 后半句会让它去解释系统内部的事
 * (10-02 那张卡刚把「卡 / 看板 / 栏位」那些词从她嘴里删掉)。
 */
export function intentToolNote(tools: readonly string[]): string {
  return `这一回合你手上就这几件工具:${tools.join('、')}。`
    + '用得上就直接调,不用就直接说话。'
    + '**这几件里没有能办这件事的,就只说你接下来打算怎么办,一个结果都不许说成已经办了。**'
}
