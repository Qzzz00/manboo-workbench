// @vitest-environment node
/**
 * 派出去的活,回答怎么从那家的窗口里读回来(2026-09-24,卡 F「手机远程派活六家」)。
 *
 * 每一组输入都是 **2026-09-24 在这台 Mac 上六家真跑出来的那一串**(壳 `read_reply` 原样交回来的,
 * 交接-0925-远程派活六家 第二节贴了原样),不是编的 —— 界面字换了、规则就得跟着换,
 * 这里红了就是那家界面变了。
 */
import { describe, expect, it } from 'vitest'
import {
  dispatchMarker, dispatchPrompt, dropAdjacentDuplicates, echoedLine, extractReply, instructionOf, joinFragments, ownMessageEnd, promptLeaked,
  replySettled,
} from '../src/server/dispatchReply.ts'

const prompt = (said: string, taskId = 't-1a2b3c4d'): string => dispatchPrompt({ taskId, said })

describe('送进去的那段话', () => {
  it('记号 = 「工作台派活」+ 事项 id 前 6 位;同一件事项永远同一个记号', () => {
    expect(dispatchMarker('t-1a2b3c4d')).toBe('工作台派活 1a2b3c')
    expect(dispatchMarker('t-1a2b3c4d')).toBe(dispatchMarker('t-1a2b3c4d'))
  })

  it('★他的原话一个字不改,前面是记号,后面一句交代;挂了项目才写工作目录', () => {
    const plain = dispatchPrompt({ taskId: 't-1a2b3c4d', said: '  用一句话说说 README 第一段  ' })
    expect(plain.startsWith('【工作台派活 1a2b3c】用一句话说说 README 第一段\n')).toBe(true)
    expect(plain).not.toContain('工作目录')
    const withCwd = dispatchPrompt({ taskId: 't-1a2b3c4d', said: '改一下', cwd: '/Users/x/repo', project: '工作台' })
    expect(withCwd).toContain('工作目录:/Users/x/repo(「工作台」项目)')
  })

  it('★交代里**不提"批准 / 确认框"**(实测 Manus 会把这种话存成它记忆里的一条偏好)', () => {
    const text = dispatchPrompt({ taskId: 't-1', said: 'x' })
    expect(text).not.toContain('批准')
    expect(text).not.toContain('确认框')
  })

  /**
   * 命令行那只手的说明书多带三行(2026-10-22,卡「名片补四样与Kimi命令行手」D):
   * 仓库(独立工作区绝对路径与分支)、卡文件(from.ref 指向 docs/卡/… 时)、交回格式。
   * 窗口手与接口手的说明书一字不变(cli 字段缺席不加)。
   */
  it('命令行手多带三行:仓库(工作区+分支)、卡文件、交回格式;窗口手一字不变', () => {
    const cli = dispatchPrompt({
      taskId: 't-1', said: '改一下', cwd: '/repo',
      cli: { worktree: '/repo/.claude/worktrees/改一下', branch: 'kimi/改一下', cardFile: 'docs/卡/试跑-记日历认法对照.md' },
    })
    expect(cli).toContain('仓库:在独立工作区 /repo/.claude/worktrees/改一下 里改,分支 kimi/改一下(不动你正用的那份目录)')
    expect(cli).toContain('卡:先读 docs/卡/试跑-记日历认法对照.md')
    expect(cli).toContain('交回:')
    expect(cli).toContain('做完:')
    expect(cli).toContain('有异议:')
    expect(cli).toContain('卡住:')
    // 没有分支(老宿主没接 workdirFor)就不编分支那一行;卡文件只在 from.ref 指向 docs/卡/ 时带
    const noBranch = dispatchPrompt({ taskId: 't-1', said: '改一下', cwd: '/repo', cli: {} })
    expect(noBranch).not.toContain('仓库:')
    expect(noBranch).not.toContain('卡:')
    expect(noBranch).toContain('交回:')
    // 窗口手 / 接口手:一字不变
    const window = dispatchPrompt({ taskId: 't-1', said: '改一下', cwd: '/repo' })
    expect(window).not.toContain('仓库:')
    expect(window).not.toContain('交回:')
  })
})

describe('extractReply:六家真跑出来的那一串', () => {
  it('Kimi:摘掉时间戳与「复制 / 点赞 / 点踩 / 从此处创建分支」', () => {
    const p = prompt('这是工作台派活的连通测试,不用做别的:请只用一句话回答——1+1 等于几?')
    const got = extractReply([p, '20:25', '1 + 1 等于 2。', '复制', '点赞', '点踩', '从此处创建分支', '20:26'], { family: 'kimi', prompt: p })
    expect(got.text).toBe('1 + 1 等于 2。')
  })

  it('★Kimi:加粗把一句话切成三截 —— 拼回一句,不是一截一行', () => {
    const p = prompt('一年有几个季节?')
    const got = extractReply([p, '一年有', '4 个季节', '（春、夏、秋、冬）。'], { family: 'kimi', prompt: p })
    expect(got.text).toBe('一年有4 个季节（春、夏、秋、冬）。')
  })

  it('Codex:摘掉「Worked for 19s」「ChatGPT said:」', () => {
    const p = prompt('只读:用一句话告诉我 README.md 第一段讲什么。')
    const got = extractReply([
      p, '20:30', 'Worked for 19s', 'ChatGPT said:', 'README.md (line 3)',
      ' 第一段介绍工作台是一个记得你、替你组织工作、随叫随到的事务官，让你只需做判断，其余交给它。', '20:30',
    ], { family: 'codex', prompt: p })
    expect(got.text).toBe('README.md (line 3)\n第一段介绍工作台是一个记得你、替你组织工作、随叫随到的事务官，让你只需做判断，其余交给它。')
  })

  it('Claude:有「Claude responded: <全文>」那一行就用它(后面拆开的几段是同一段话)', () => {
    const p = prompt('只读:用一句话告诉我 README.md 第一段讲什么。')
    const got = extractReply([
      p, 'Claude responded: README 第一段介绍这个产品:一个随叫随到的"事务官"。',
      'Read', 'README 第一段介绍这个产品:一个随叫随到的"事务官"。', '我只读了这个文件,没有改动任何东西。',
    ], { family: 'claude', prompt: p })
    expect(got.text).toBe('README 第一段介绍这个产品:一个随叫随到的"事务官"。')
  })

  it('Manus:读到「Task completed」为止(后面是推荐问题)', () => {
    const p = prompt('请只用一句话回答——中秋节是农历几月几日?')
    const got = extractReply([
      p, '中秋节是农历八月十五。', 'Task completed', '中秋节都有哪些传统的习俗和庆祝方式？',
      '今年（2026年）的中秋节对应的公历日期是哪一天？', '请讲一个关于中秋节起源的经典神话故事。', 'Agent todo completed',
    ], { family: 'manus', prompt: p })
    expect(got.text).toBe('中秋节是农历八月十五。')
  })

  it('豆包:摘掉「搜索 1 个关键词,参考 5 篇资料」、末尾三条猜你想问、输入区上面那排按钮', () => {
    const p = prompt('请只用一句话回答——中秋节是农历几月几日?')
    const got = extractReply([
      p, '搜索 1 个关键词，参考 5 篇资料', '中秋节是农历八月十五。', '中秋节有哪些传统习俗？',
      '中秋节的起源和发展历史是怎样的？', '中秋节的传说故事有哪些？', '快速', '图像生成', '帮我写作', '解题答疑', '音乐生成', '翻译', '更多',
    ], { family: 'doubao', prompt: p })
    expect(got.text).toBe('中秋节是农历八月十五。')
  })

  /**
   * ★ 2026-10-13(卡 F,四场景验收第 8 条):真机 13:46 那一条派给豆包办公的回话,
   * 卡上 `client_dispatch.reply` 是「今天 13:46我会把小猫…不加任何文正在生成图片对话豆包 快速」——
   * 时间戳行、状态行、输入栏的模式 / 模型标签都拼进了回话,手机上显示的与电话里念的都是这一格。
   * 维护者原话:「去掉豆包,快速这样的描述」。(「不加任何文」是那一刻窗上还没画完的字,照留。)
   */
  it('★豆包办公(真机 2026-10-13 13:46):时间戳行、状态行、输入栏的「对话 / 豆包 / 快速」都不进回话', () => {
    const p = prompt('请帮我生成一张图片:小猫在海边。画面完整、主体清晰,适合作为视频的第一帧,横版 16:9,不要文字和水印。只要一张。')
    const got = extractReply([
      p, '今天 13:46',
      '我会把小猫作为清晰主体,海边浪花做成有动感的开场画面,横版16:9,不加任何文',
      '正在生成图片', '对话', '豆包 快速',
    ], { family: 'doubao', prompt: p })
    expect(got.text).toBe('我会把小猫作为清晰主体,海边浪花做成有动感的开场画面,横版16:9,不加任何文')
  })

  it('★「豆包」「对话」在正文里的不动 —— 只剔紧挨输入区那一段尾巴', () => {
    const p = prompt('问一下豆包那边怎么说')
    const got = extractReply([
      p, '我问了豆包,它说先出图。', '这条对话我留着。', '对话', '豆包 快速',
    ], { family: 'doubao', prompt: p })
    expect(got.text).toBe('我问了豆包,它说先出图。\n这条对话我留着。')
  })

  /**
   * ★ **新版豆包的输入栏**(2026-10-13 晚演示机 20:55,模型页签写「豆包 2.1 Lite」;卡 Q)。
   *
   * 那一单卡上 `client_dispatch.reply` 是「调用工具生成图片本地电脑项目豆包 2.1 Lite中」,
   * 同一台 20:31 那一单是「本地电脑项目按需确认豆包 2.1 Lite中」(`channel-worker.log` 里念过) ——
   * 尾巴那几截是输入栏的「本地电脑 / 项目 / 按需确认」加模型选择「豆包 2.1 Lite」,
   * 最后那个「中」紧挨着模型标签。**进度行「调用工具生成图片」照留**:接力那一层靠它判「它还在出图」。
   *
   * 版本号写成「豆包 + 空格 + 数字」那个样子,不只列 2.1 Lite 这一个。
   */
  it('★新版豆包(演示机 2026-10-13 20:55):「本地电脑 / 项目 / 按需确认 / 豆包 2.1 Lite」与紧跟模型那个「中」都不进回话', () => {
    const p = prompt('请帮我生成一张图片:骆驼在沙漠里散步。只要一张。')
    expect(extractReply([p, '调用工具生成图片', '本地电脑', '项目', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('调用工具生成图片')
    expect(extractReply([p, '本地电脑', '项目', '按需确认', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('')
    // ★ 演示机 22:18 那单(卡 U):多一个「技能插件」。
    expect(extractReply([p, '本地电脑', '项目', '按需确认', '技能插件', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('')
    expect(extractReply([p, '工作台派发验证收到。', '本地电脑', '项目', '按需确认', '技能插件', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('工作台派发验证收到。')
    // 别的版本号同样认(真机只量到 2.1 Lite 这一个,所以判的是形状)。
    expect(extractReply([p, '好了。', '豆包 1.5 Pro', '中'], { family: 'doubao', prompt: p }).text).toBe('好了。')
    expect(extractReply([p, '好了。', '豆包 2.1', '中'], { family: 'doubao', prompt: p }).text).toBe('好了。')
  })

  it('★正文最后一个字是「中」的真回话不误伤(只剔紧挨模型标签那一个)', () => {
    const p = prompt('图放哪儿了?')
    expect(extractReply([p, '图我放在素材文件夹中', '本地电脑', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('图我放在素材文件夹中')
    // 「中」单独一截、前面不是模型标签 → 那是它自己的字,照留。
    expect(extractReply([p, '还在处理', '中'], { family: 'doubao', prompt: p }).text).toBe('还在处理中')
  })

  it('★正文里的「本地电脑」「项目」不动 —— 照旧只剔紧挨输入区那一段尾巴', () => {
    const p = prompt('本地那几个项目跑过了吗')
    expect(extractReply([p, '本地电脑上的项目都跑过了。', '本地电脑', '项目', '豆包 2.1 Lite', '中'], { family: 'doubao', prompt: p }).text)
      .toBe('本地电脑上的项目都跑过了。')
  })

  it('★时间戳那一道不许吞掉回答里的「16:9」(加粗会把比例单独切成一截)', () => {
    const p = prompt('横版还是竖版?')
    const got = extractReply([p, '横版', '16:9', ',不加文字。'], { family: 'doubao', prompt: p })
    expect(got.text).toContain('16:9')
  })

  it('★别家的回话读法没被误伤:同样这几截字在 Kimi / Claude 那边照留', () => {
    const p = prompt('x')
    expect(extractReply([p, '好了。', '对话', '豆包 快速'], { family: 'kimi', prompt: p }).text)
      .toBe('好了。\n对话豆包 快速')
  })

  it('Muse:只有回答那一行;读屏前缀「助手消息:」要摘掉', () => {
    const p = prompt('请只用一句话回答——中秋节是农历几月几日?')
    expect(extractReply([p, '中秋节是农历八月十五。'], { family: 'muse', prompt: p }).text).toBe('中秋节是农历八月十五。')
    expect(extractReply([p, '助手消息：一周有七天。'], { family: 'muse', prompt: p }).text).toBe('一周有七天。')
  })

  it('★我们那一句被界面拆成几段显示:开头那几段都摘掉;回答里恰好有一句和原话一样的不吞', () => {
    const p = prompt('第一行\n第二行说明')
    const got = extractReply(['【工作台派活 1a2b3c】第一行', '第二行说明', '好的。', '第二行说明'], { family: 'kimi', prompt: p })
    expect(got.text).toBe('好的。\n第二行说明')
  })

  it('一个字都没有(还没开始答)→ 空串', () => {
    const p = prompt('x')
    expect(extractReply([p], { family: 'kimi', prompt: p }).text).toBe('')
  })

  it('★只有一条问句收尾的不当成"猜你想问"(那可能是回答自己在问)', () => {
    const p = prompt('x')
    expect(extractReply([p, '改好了。', '要我顺手把测试也补上吗？'], { family: 'doubao', prompt: p }).text)
      .toBe('改好了。\n要我顺手把测试也补上吗？')
  })

  it('超过 4000 字截断,并且说清楚截了', () => {
    const p = prompt('x')
    const got = extractReply([p, '长'.repeat(5000)], { family: 'kimi', prompt: p })
    expect(got.truncated).toBe(true)
    expect(got.text.endsWith('…')).toBe(true)
  })
})

describe('joinFragments', () => {
  it('说完一句另起一行;列表另起一行;英文两截之间补空格', () => {
    expect(joinFragments(['第一句。', '第二句'])).toBe('第一句。\n第二句')
    expect(joinFragments(['要点', '- 一', '- 二'])).toBe('要点\n- 一\n- 二')
    expect(joinFragments(['README', 'md'])).toBe('README md')
    expect(joinFragments(['改了', 'app.ts', '里的一行'])).toBe('改了app.ts里的一行')
  })
})

describe('replySettled:回答说完了没有', () => {
  it('★连着两次一字不差、而且没有「停止」键,才算说完', () => {
    expect(replySettled({ current: '好。', busy: false })).toBe(false)
    expect(replySettled({ previous: '好', current: '好。', busy: false })).toBe(false)
    expect(replySettled({ previous: '好。', current: '好。', busy: true })).toBe(false)
    expect(replySettled({ previous: '好。', current: '好。', busy: false })).toBe(true)
  })

  it('空的不算说完(还没开始答)', () => {
    expect(replySettled({ previous: '', current: '', busy: false })).toBe(false)
  })
})

/**
 * 0.2.96 真系统那一单(2026-09-25 02:43,事项 t-a7a07e82,小米打字派给 Codex)。
 * `REAL_PROMPT` 是卡上存的送出去的原文(一字不差);`REAL_CODEX_NODES` 是 Codex 窗口里读回来的那一串:
 * 它把我们的话当 markdown 画 ——「- 」单独一截、反引号里的 `**` 拆成「`」「*」「*」「`」四截、行内代码拆成三截。
 * 老办法只认开头那一句,于是交上去的「回答」前 190 字是我们自己附的规矩。
 */
const REAL_RULES = [
  '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
  '- 他说过一次的规矩全局生效:不分模板、不分渠道(电话、打字、在统筹会话里说的都算),派活、验收、摆界面、说话时处处照做;问题要我们先发现,不等他撞上',
  '- 不露内部的东西(`**` 这类符号、事项的出处说明、文件路径、英文键名)',
  '- 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 `taskpolicy -c utility`(别用 nice),一次只跑一个)',
].join('\n')
const REAL_PROMPT = `${dispatchPrompt({ taskId: 't-a7a07e82', said: '[派活测试] 让 Codex 用一句话回答:一天有几个小时?' })}\n\n${REAL_RULES}`
const REAL_CODEX_NODES = [
  '【工作台派活 a7a07e】[派活测试] 让 Codex 用一句话回答:一天有几个小时?',
  '(这是工作台转交的活,做完直接回结果,我在手机上看。)',
  '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
  '-',
  ' 他说过一次的规矩全局生效:不分模板、不分渠道(电话、打字、在统筹会话里说的都算),派活、验收、摆界面、说话时处处照做;问题要我们先发现,不等他撞上',
  '-',
  ' 不露内部的东西(',
  '`', '*', '*', '`',
  ' 这类符号、事项的出处说明、文件路径、英文键名)',
  '-',
  ' 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 ',
  '`', 'taskpolicy -c utility', '`',
  '(别用 nice),一次只跑一个)',
  '2:43',
  'ChatGPT said:',
  '一天有24个小时。',
  '2:43',
]

describe('★锚点 = 我们整条消息的末尾(2026-09-25,fix/reply-anchor)', () => {
  it('★0.2.96 真机 Codex 那一串:交上去的只有「一天有24个小时。」,一个字的规矩都不带', () => {
    expect(REAL_PROMPT.length).toBe(322)
    expect(ownMessageEnd(REAL_CODEX_NODES, REAL_PROMPT)).toBe(18)
    const got = extractReply(REAL_CODEX_NODES, { family: 'codex', prompt: REAL_PROMPT })
    expect(got.text).toBe('一天有24个小时。')
    expect(promptLeaked(got.text, REAL_PROMPT)).toBeUndefined()
  })

  it('★换成不带 markdown 记号的规矩段(星号说成「星号」)也一样', () => {
    const rules = REAL_RULES.replace('`**` ', '星号').replace('`taskpolicy -c utility`', 'taskpolicy -c utility')
    const p = `${dispatchPrompt({ taskId: 't-a7a07e82', said: '[派活测试] 让 Codex 用一句话回答:一天有几个小时?' })}\n\n${rules}`
    const nodes = [
      p.split('\n')[0] as string, '(这是工作台转交的活,做完直接回结果,我在手机上看。)', rules.split('\n')[0] as string,
      '-', ' 他说过一次的规矩全局生效:不分模板、不分渠道(电话、打字、在统筹会话里说的都算),派活、验收、摆界面、说话时处处照做;问题要我们先发现,不等他撞上',
      '-', ' 不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)',
      '-', ' 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 taskpolicy -c utility(别用 nice),一次只跑一个)',
      '2:51', 'ChatGPT said:', '一天有 24 个小时。', '2:51',
    ]
    expect(extractReply(nodes, { family: 'codex', prompt: p }).text).toBe('一天有 24 个小时。')
  })

  it('★加粗把我们消息里的两个字单独切出来(夹在两截我们的话中间)→ 仍算我们的', () => {
    const p = `${prompt('改一下按钮')}\n\n【他的规矩:这件活要守的】\n- 电话不能被构建挤卡(**做法**:构建一律低优先级跑)`
    const nodes = ['【工作台派活 1a2b3c】改一下按钮', '(这是工作台转交的活,做完直接回结果,我在手机上看。)', '【他的规矩:这件活要守的】',
      '-', ' 电话不能被构建挤卡(', '做法', ':构建一律低优先级跑)', 'ChatGPT said:', '改好了。']
    expect(extractReply(nodes, { family: 'codex', prompt: p }).text).toBe('改好了。')
  })

  it('★很短的回答恰好是我们原话里的字(「四个。」)不被当成我们的吞掉', () => {
    const p = prompt('一年有几个季节?只回答四个或者别的数字')
    expect(extractReply([p, '四个。'], { family: 'muse', prompt: p }).text).toBe('四个。')
    expect(extractReply([p, '10:02', '四个。'], { family: 'kimi', prompt: p }).text).toBe('四个。')
  })

  it('★回答里整行抄着我们附的规矩 → 那一行剥掉,答案留着', () => {
    const got = extractReply([
      ...REAL_CODEX_NODES.slice(0, 18), 'ChatGPT said:',
      '- 不露内部的东西(`**` 这类符号、事项的出处说明、文件路径、英文键名)', '一天有24个小时。',
    ], { family: 'codex', prompt: REAL_PROMPT })
    expect(got.text).toBe('一天有24个小时。')
  })

  it('★回答只是在复述他的原话(「原样回我这句」)→ 留着,不交空回答', () => {
    const p = prompt('请把这句话原样回我:今天适合出门散步晒太阳')
    expect(extractReply([p, 'ChatGPT said:', '今天适合出门散步晒太阳'], { family: 'codex', prompt: p }).text).toBe('今天适合出门散步晒太阳')
  })

  it('我们的指令 = 交代那一句(不含工作目录)+ 规矩那一段;返工那条记号之后整条都是', () => {
    const p = `${dispatchPrompt({ taskId: 't-1', said: '改一下', cwd: '/Users/x/repo', project: '工作台' })}\n\n【他的规矩:x】\n- 不要蓝`
    const ours = instructionOf(p)
    expect(ours.startsWith('这是工作台转交的活')).toBe(true)
    expect(ours).toContain('【他的规矩:x】')
    expect(ours).not.toContain('/Users/x/repo')
    expect(ours).not.toContain('改一下')
    expect(instructionOf('【工作台派活 000001 返工】按钮用了蓝色,改成黑白灰再交')).toBe('按钮用了蓝色,改成黑白灰再交')
  })

  it('★回答里夹着我们指令里的一句(整行或半行)→ 认得出来;提到仓库路径、taskpolicy 这种词不算', () => {
    const leaked = promptLeaked('好的,我会照做:不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)。一天有24个小时。',
      REAL_PROMPT.replace('`**` ', '星号'))
    expect(leaked).toBe('不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)')
    // 只抄了半行(Codex 那次交上去的就是半行)也认得出来。
    expect(promptLeaked('这类符号、事项的出处说明、文件路径、英文键名)\n一天有24个小时。', REAL_PROMPT)).toBe('这类符号、事项的出处说明、文件路径、英文键名')
    expect(promptLeaked('(这是工作台转交的活,做完直接回结果,我在手机上看。)一天有24个小时。', REAL_PROMPT)).toContain('这是工作台转交的活')
    const withCwd = `${dispatchPrompt({ taskId: 't-1', said: '跑一下测试', cwd: '/Users/example/Documents/GitHub/desktop-workbench' })}\n\n${REAL_RULES}`
    expect(promptLeaked('在 /Users/example/Documents/GitHub/desktop-workbench 里用 taskpolicy -c utility 跑了测试,全过。', withCwd)).toBeUndefined()
    expect(promptLeaked('一天有24个小时。', REAL_PROMPT)).toBeUndefined()
    expect(echoedLine('', REAL_RULES)).toBeUndefined()
  })
})

/**
 * 0.2.97 真系统那一单(2026-09-25 03:21,事项 t-fc1ed853,Codex 在窗口槽里):答完那几秒,Codex 给读屏挂了一个
 * 「Response complete: 一天有24个小时。」,连着两次读都在 → 交上去的是「Response complete: 一天有24个小时。\n一天有24个小时。」。
 * 我们那条消息是新的规矩段(不带 markdown 记号),Codex 画成 9 截(03:22 事后只读核过,那时播报已经没了)。
 */
const RULES_0297 = [
  '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
  '- 他说过一次的规矩全局生效:不分模板、不分渠道(电话、打字、在统筹会话里说的都算),派活、验收、摆界面、说话时处处照做;问题要我们先发现,不等他撞上',
  '- 不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)',
  '- 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 taskpolicy -c utility(别用 nice),一次只跑一个)',
].join('\n')
const PROMPT_0297 = `${dispatchPrompt({ taskId: 't-fc1ed853', said: '[派活测试] 让 Codex 用一句话回答:一天有几个小时?' })}\n\n${RULES_0297}`
const OURS_0297 = [
  '【工作台派活 fc1ed8】[派活测试] 让 Codex 用一句话回答:一天有几个小时?', '(这是工作台转交的活,做完直接回结果,我在手机上看。)',
  RULES_0297.split('\n')[0] as string,
  '-', ' 他说过一次的规矩全局生效:不分模板、不分渠道(电话、打字、在统筹会话里说的都算),派活、验收、摆界面、说话时处处照做;问题要我们先发现,不等他撞上',
  '-', ' 不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)',
  '-', ' 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 taskpolicy -c utility(别用 nice),一次只跑一个)',
]

describe('★读屏播报、状态字、相邻重复(2026-09-25,fix/reply-polish)', () => {
  it('★0.2.97 真机 Codex:「Response complete: …」那一行不进交付物,回答不重两遍(播报在前、在后都一样)', () => {
    const before = [...OURS_0297, '3:21', 'Response complete: 一天有24个小时。', 'ChatGPT said:', '一天有24个小时。', '3:22']
    expect(extractReply(before, { family: 'codex', prompt: PROMPT_0297 }).text).toBe('一天有24个小时。')
    const after = [...OURS_0297, '3:21', 'ChatGPT said:', '一天有24个小时。', 'Response complete: 一天有24个小时。', '3:22']
    expect(extractReply(after, { family: 'codex', prompt: PROMPT_0297 }).text).toBe('一天有24个小时。')
    // 播报过去之后(03:22 事后核的那一串)也是同一句 —— 前后两次读一字不差,不会因为播报没了就当它还没说完。
    const later = [...OURS_0297, '3:21', 'ChatGPT said:', '一天有24个小时。', '3:22']
    expect(extractReply(later, { family: 'codex', prompt: PROMPT_0297 }).text).toBe('一天有24个小时。')
  })

  it('★灰度 03:40 逐拍读到的那几串(Codex 在前):Thinking / Working for 8s → ChatGPT said: + 播报 + 回答 → 播报没了;收回来的都是那一句', () => {
    const p = `${dispatchPrompt({ taskId: 't-a1756763', said: '[派活测试] 让 Codex 用一句话回答:一天有几个小时?' })}\n\n${RULES_0297}`
    const ours = [`【工作台派活 a17567】[派活测试] 让 Codex 用一句话回答:一天有几个小时?`, ...OURS_0297.slice(1)]
    expect(extractReply([...ours, '3:40', 'Thinking'], { family: 'codex', prompt: p }).text).toBe('')
    expect(extractReply([...ours, '3:40', 'Working for 8s', 'Thinking'], { family: 'codex', prompt: p }).text).toBe('')
    const withAnnounce = extractReply([...ours, '3:40', 'ChatGPT said:', 'Response complete: 一天有24个小时。', '一天有24个小时。', '3:40'], { family: 'codex', prompt: p })
    const afterAnnounce = extractReply([...ours, '3:40', 'ChatGPT said:', '一天有24个小时。', '3:40'], { family: 'codex', prompt: p })
    expect(withAnnounce.text).toBe('一天有24个小时。')
    expect(afterAnnounce.text).toBe(withAnnounce.text)
  })

  it('★长回答:播报是整段挤成一行,真回答拆成几行 —— 用真回答那几行,播报不要', () => {
    const got = extractReply([
      ...OURS_0297, 'Response complete: 改了两处。第一处是按钮颜色。第二处是标题。', 'ChatGPT said:', '改了两处。', '- 第一处是按钮颜色。', '- 第二处是标题。',
    ], { family: 'codex', prompt: PROMPT_0297 })
    expect(got.text).toBe('改了两处。\n- 第一处是按钮颜色。\n- 第二处是标题。')
  })

  it('真回答一行都没有、只有播报 → 用播报里那段(去掉前缀)', () => {
    expect(extractReply([...OURS_0297, 'Response complete: 一天有24个小时。'], { family: 'codex', prompt: PROMPT_0297 }).text).toBe('一天有24个小时。')
  })

  it('状态字(Copied / Responding / 已复制)整行摘掉;回答里正常的英文句子不动', () => {
    const p = prompt('x')
    expect(extractReply([p, 'Responding…', '好了。', 'Copied!'], { family: 'codex', prompt: p }).text).toBe('好了。')
    expect(extractReply([p, '一小时有 60 分钟。', '已复制'], { family: 'kimi', prompt: p }).text).toBe('一小时有 60 分钟。')
    expect(extractReply([p, 'Response complete'], { family: 'codex', prompt: p }).text).toBe('')
    expect(extractReply([p, 'Loading the page takes 2 seconds.'], { family: 'codex', prompt: p }).text).toBe('Loading the page takes 2 seconds.')
  })

  it('★相邻两行一模一样(空格、标点不同也算)只留一行;隔着别的行的不动', () => {
    expect(dropAdjacentDuplicates(['一天有24个小时。', '一天有 24 个小时。'])).toEqual(['一天有24个小时。'])
    expect(dropAdjacentDuplicates(['A。', 'B。', 'A。'])).toEqual(['A。', 'B。', 'A。'])
    expect(dropAdjacentDuplicates(['😀', '😀'])).toEqual(['😀', '😀'])
    const p = prompt('x')
    expect(extractReply([p, '一周有七天。', '一周有七天。', '复制'], { family: 'doubao', prompt: p }).text).toBe('一周有七天。')
  })
})
