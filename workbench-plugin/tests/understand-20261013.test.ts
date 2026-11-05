// @vitest-environment node
/**
 * **一个「听懂」入口 + 四个演示场景的固定流程**(2026-10-13,卡「三个入口一套管线」;
 * 交接 `docs/交接-1013-一套管线与演示固定流程.md`)。
 *
 * 钉四件:
 *   ① `understand()` 对那一批句子的判定(四个演示场景、补细节、答挂着的那一问、派活、认不出);
 *   ② 《需求确认点》只念给真的产品需求(`looksLikeProductRequirement`;10-13 早那一通的第 ③ 处毛病);
 *   ③ `POST /butler/understand` 不办事、回的就是那一份判定;
 *   ④ **三个入口一致**:同一句话,`/butler/understand` 的 `kind` 与 `/butler/item` 真走的那一道岔口对得上。
 *
 * 10-13 早那一通的原话(ASR)逐句在「真机那一通」一节里。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import {
  APPEND_WINDOW_MS,
  answerAskVerdict,
  asksToRemember,
  looksLikeFollowUp,
  looksLikeProductRequirement,
  understand,
  type UnderstandContext,
} from '../src/server/understand.ts'
import { createAppendGate, looksLikeAppendDetail, notAppendDetailWhy } from '../src/server/followUp.ts'
import { DEMO_ANSWER_ASK_SAY, DEMO_PLAYBOOK, DEMO_SAY_MAX_CHARS, todayViewAsked } from '../src/server/demoPlaybook.ts'
import { PUBLISH_PLAN_ASK_DAY, PUBLISH_PLAN_ASK_SUBJECT } from '../src/server/publishPlan.ts'
import { SESSION_ASK_STALE_MS, sessionAskCallOutEvents, sessionAskTooOld } from '../src/server/sessionAskCalls.ts'

/** 钉死的工作台钟:2026-10-13(周二)上午 11 点。 */
const NOW = new Date(2026, 9, 13, 11, 0).getTime()

function ctx(over: Partial<UnderstandContext> = {}): UnderstandContext {
  return { nowMs: NOW, source: 'call', ...over }
}

/* ──────────────────────── ① 四个演示场景 ──────────────────────── */

describe('四个演示场景:认出来就办,不确认、不反问', () => {
  it('★① 做视频:10-13 早真机那一句认得出,固定流程、不要确认', () => {
    const got = understand('帮我生成一个小女孩在花海里面漫步的视频。', ctx())
    expect(got.kind).toBe('video')
    expect(got.mode).toBe('demo')
    expect(got.confirm.needed).toBe(false)
    expect(got.route).toEqual({ path: '/butler/item', body: {} })
    expect(got.video?.subject).toBe('小女孩在花海里面漫步')
    expect(got.say.start).toContain('先让豆包出参考图')
    expect(got.say.start).toContain('可灵')
  })

  it('★② 切待办版本:卡片 / 列表两个方向都认,打的是 /today/view', () => {
    const up = understand('把待办改成卡片', ctx())
    expect([up.kind, up.mode, up.today_view]).toEqual(['today_view', 'demo', 'by_date'])
    // `said` 自 2026-10-13 起带着她那句原话(留痕用,见 `tests/understood-trace-20261013.test.ts`)。
    expect(up.route).toEqual({ path: '/today/view', body: { view: 'by_date', said: '把待办改成卡片' } })
    expect(up.say.start).toBe('好,改成卡片了。')
    const down = understand('待办改回列表', ctx())
    expect([down.kind, down.today_view]).toEqual(['today_view', 'flat'])
    expect(down.say.start).toBe('好,改回列表了。')
    // 「改回去」要同时提到待办那一格(光一句「改回去」什么都能指 → 交给模型)
    expect(todayViewAsked('把今天的待办改回去')).toBe('flat')
    expect(todayViewAsked('改回去')).toBeUndefined()
    expect(understand('改回去', ctx()).kind).toBe('none')
    // 问话不切版面
    expect(todayViewAsked('待办是卡片的吗?')).toBeUndefined()
  })

  it('★② 老说法还认:「按日期汇总」= 卡片,「不汇总」= 列表(10-12 那两天的句子)', () => {
    const up = understand('把待办改成按日期汇总', ctx())
    expect([up.kind, up.today_view]).toEqual(['today_view', 'by_date'])
    expect(up.say.start).toBe('好,改成卡片了。')
    const down = understand('待办改回不汇总', ctx())
    expect([down.kind, down.today_view]).toEqual(['today_view', 'flat'])
    expect(down.say.start).toBe('好,改回列表了。')
  })

  it('★③ 记发布计划:说清了日子直接记;说不清只回问一句、一张卡都不建', () => {
    const got = understand('计划 18 号发一条关于秋天穿搭的视频', ctx())
    expect([got.kind, got.mode, got.confirm.needed]).toEqual(['publish_plan', 'demo', false])
    expect(got.publish?.day).toBe('2026-10-18')
    expect(got.say.start).toContain('记进发布计划了')
    expect(got.route?.path).toBe('/butler/item')
    const vague = understand('月底发一条关于年终总结的视频', ctx())
    expect(vague.kind).toBe('publish_plan')
    expect(vague.route).toBeUndefined()
    expect(vague.ask).toBe(PUBLISH_PLAN_ASK_DAY)
  })

  it('★③ 10-13 下午真机那一句:不带「发布」的自然说法也进日历(维护者当天拍板)', () => {
    const got = understand('呃,我20号计划要发一个视频,是做我们大赛的整个回顾。', ctx())
    expect([got.kind, got.mode, got.confirm.needed]).toEqual(['publish_plan', 'demo', false])
    expect(got.publish?.day).toBe('2026-10-20')
    expect(got.publish?.title).toBe('我们大赛的整个回顾的视频')
    expect(got.route?.path).toBe('/butler/item')
    expect(got.say.start).toContain('记进发布计划了')
  })

  it('★③ 主题认不出:只回问一句「这条是关于什么的?」,一张卡都不建、一个主题都不猜', () => {
    const got = understand('我 20 号要发一个视频', ctx())
    expect(got.kind).toBe('publish_plan')
    expect(got.route).toBeUndefined()
    expect(got.ask).toBe(PUBLISH_PLAN_ASK_SUBJECT)
    expect(got.say.start).toBe('')
  })

  it('★③ 「记一下,18 号发一条关于 XXX 的视频」也进日历(发布计划排在「记一笔」前面)', () => {
    const got = understand('记一下,18 号发一条关于露营装备的视频', ctx())
    expect(got.kind).toBe('publish_plan')
    expect(got.publish?.day).toBe('2026-10-18')
  })

  it('★④ 答挂着的那一问:不经模型,直接打 /asks/voice', () => {
    const openAsk = { item_id: 'session:doubao/window:1', title: '豆包 在等你选' }
    const picked = understand('绿茶', ctx({ openAsk }))
    expect([picked.kind, picked.mode]).toEqual(['answer_ask', 'demo'])
    expect(picked.route).toEqual({ path: '/asks/voice', body: { item_id: openAsk.item_id, said: '绿茶' } })
    expect(picked.say.start).toBe(DEMO_ANSWER_ASK_SAY)
    expect(understand('第二个', ctx({ openAsk })).kind).toBe('answer_ask')
    // 没有挂着的问 → 认不出,交给模型
    expect(understand('绿茶', ctx()).kind).toBe('none')
    // 她在反问 / 光一句应答 → 不替她拿去答
    expect(understand('你派出去了吗?', ctx({ openAsk })).kind).toBe('none')
    expect(understand('好的', ctx({ openAsk })).kind).toBe('none')
  })

  /*
   * ★ 2026-10-13 下午,卡 C:14:3x 那一通里他说「看见了,嗯」—— 此刻挂着「到上限了」那一问,
   * 旧判据(「挂着一问 + 这一句不是新意图」)把它当成了答案,`/asks/voice` 回了 ok,
   * 她于是说「好了,替你选上了」,而那张卡仍然 blocked。收紧成:**对得上某一项**才算。
   */
  it('★④ 收紧:说中那几项里的一项才算答案,应答 / 感叹 / 闲话一律不算', () => {
    const openAsk = { item_id: 'session:doubao/window:1', title: '豆包 在等你选', options: ['可乐', '茶', '咖啡', '果汁'] }
    for (const said of ['咖啡', '茶', '我要咖啡', '第二个', '最后一个', '第3个']) {
      expect(understand(said, ctx({ openAsk })).kind).toBe('answer_ask')
    }
    // 14:3x 真机那一句,以及一整排应答 / 感叹 / 闲话
    for (const said of ['看见了,嗯', '看见了', '嗯', '嗯嗯', '好的', '行', '知道了', '明白了', '哦', '收到', '我看到了']) {
      expect(understand(said, ctx({ openAsk })).kind).toBe('none')
    }
    // 对不上那几项(听错 / 她说的是别的) → 交给模型,**不替她挑、也不自己回问**
    expect(understand('可可', ctx({ openAsk })).kind).toBe('none')
    expect(understand('都行', ctx({ openAsk })).kind).toBe('none')
    // 带着办事动词的那一句不是答案(即使里头有选项的字)
    expect(understand('把咖啡那个方案记一下', ctx({ openAsk })).kind).not.toBe('answer_ask')
  })

  it('★④ 那一问没有选项时:一句实答才算(应答照旧不算)', () => {
    const openAsk = { item_id: 'session:doubao/window:2', title: '豆包 在问你' }
    expect(understand('绿茶', ctx({ openAsk })).kind).toBe('answer_ask')
    expect(understand('看见了,嗯', ctx({ openAsk })).kind).toBe('none')
    expect(understand('知道了', ctx({ openAsk })).kind).toBe('none')
  })

  it('★④ 判据本身(纯函数):对上哪一项、为什么不算', () => {
    const options = ['可乐', '茶', '咖啡', '果汁']
    expect(answerAskVerdict('咖啡', { options })).toEqual({ how: 'option', option: '咖啡' })
    expect(answerAskVerdict('第二个', { options })).toEqual({ how: 'option', option: '茶' })
    expect(answerAskVerdict('看见了,嗯', { options }).how).toBe('no')
    expect(answerAskVerdict('可可', { options }).how).toBe('no')
    // 没有选项的那一问:一句实答算、应答不算
    expect(answerAskVerdict('绿茶', {}).how).toBe('said')
    expect(answerAskVerdict('嗯', {}).how).toBe('no')
    expect(answerAskVerdict('  ', {}).how).toBe('no')
  })

  it('★应答 / 感叹 / 闲话也不当「补细节」(同一张表,两档共用)', () => {
    expect(looksLikeFollowUp('看见了,嗯')).toBe(false)
    expect(looksLikeFollowUp('知道了')).toBe(false)
    expect(looksLikeFollowUp('哦')).toBe(false)
    // 真的细节照旧是细节
    expect(looksLikeFollowUp('七八岁吧,穿小碎花连衣裙')).toBe(true)
  })

  it('★四个场景说的每一句都短(TTS 流在长句上卡过)', () => {
    const subject = '小女孩在花海漫步'
    const lines = [
      understand('把待办改成卡片', ctx()).say.start,
      understand('待办改回列表', ctx()).say.start,
      DEMO_ANSWER_ASK_SAY,
      // 做视频那一句是两句话:逐句量
      ...understand(`帮我做一个${subject}的视频`, ctx()).say.start.split('。').filter(one => one !== ''),
    ]
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(DEMO_SAY_MAX_CHARS)
  })

  it('固定流程表四行都在(交接与彩排页照它写)', () => {
    expect(DEMO_PLAYBOOK.map(one => one.scene)).toEqual(['video', 'today_view', 'publish_plan', 'answer_ask'])
  })
})

/* ──────────────────────── ② 补细节 / 派活 / 记一笔 ──────────────────────── */

describe('补细节:并进刚开始那件事', () => {
  const open = { item_id: 't-1', said: '帮我生成一个小女孩在花海里面漫步的视频', at_ms: NOW - 20_000 }

  it('★「七八岁吧,穿小碎花连衣裙。」并进去,回一句「加上了」', () => {
    const got = understand('七八岁吧,穿小碎花连衣裙。', ctx({ open }))
    expect(got.kind).toBe('append')
    // `append:true` 自 2026-10-13 起标出「这一句是她在补细节」(留痕只认这一格)。
    expect(got.route).toEqual({ path: '/butler/item/say', body: { id: 't-1', text: '七八岁吧,穿小碎花连衣裙。', append: true } })
    expect(got.say.start).toBe('加上了:七八岁吧,穿小碎花连衣裙。')
  })

  it('过了那扇窗(20 秒,2026-10-13 晚卡 P 从 60 秒收到 20 秒)就不并了', () => {
    expect(understand('七八岁吧', ctx({ open: { ...open, at_ms: NOW - APPEND_WINDOW_MS - 1 } })).kind).toBe('none')
  })

  it('★「我是说记一下,哎呀。」不是补细节(带着办事的动词)—— 交给模型', () => {
    const got = understand('我是说记一下,哎呀。', ctx({ open }))
    expect(got.kind).toBe('none')
    expect(got.why).toContain('记一笔')
  })

  it('能不能当补细节:短、不是应答、不是反问、不带办事的动词', () => {
    expect(looksLikeFollowUp('向日葵吧,吉卜力风格,5 秒,横屏')).toBe(true)
    expect(looksLikeFollowUp('好的')).toBe(false)
    expect(looksLikeFollowUp('你派出去了吗?')).toBe(false)
    expect(looksLikeFollowUp('帮我把这条派给 Codex')).toBe(false)
  })

  it('文字入口(电脑 / 手机)不走补细节与答那一问那两档', () => {
    expect(understand('七八岁吧,穿小碎花连衣裙。', ctx({ open, source: 'desk' })).kind).toBe('none')
    expect(understand('绿茶', ctx({ openAsk: { item_id: 'x', title: 'y' }, source: 'phone' })).kind).toBe('none')
  })
})

/* ──────────── ★ 补细节那道门不许把别的话吞进来:演示机 20:30(卡 P)──────────── */

/**
 * 演示机 2026-10-13 20:30 真机原文(诊断包 `日志/channel-worker.log`):
 * 一句切待办的话被 ASR 切成两段,两段都落在「做视频」那件事的窗口里 ——
 * 都认成了 `append`、记在卡上,还并进了可灵那句提示词
 * (可灵拿到的提示词里夹着「帮我把待办的组件改为。的形式。」)。
 *
 * 这一节钉:四句原话各自该认成什么、真补细节那一句照旧认、20 秒之外不认、中间插了别的话不认。
 */
describe('★补细节那道门:演示机 20:30 那四句', () => {
  /** 做视频那一件刚起来 8 秒(窗口之内),工人带来的就是这一份。 */
  const open = { item_id: 't-1', said: '帮我生成一个小女孩在路边奔跑的视频。', at_ms: NOW - 8_000, first: true }

  it('★① 做视频那一句照旧按视频认(固定流程永远排在补细节前面)', () => {
    expect(understand('帮我生成一个小女孩在路边奔跑的视频。', ctx({ open })).kind).toBe('video')
  })

  it('★② 「帮我把待办的组件改为。」不当补细节 —— 交给后面的认法', () => {
    const got = understand('帮我把待办的组件改为。', ctx({ open }))
    expect(got.kind).toBe('none')
    expect(got.why).toContain('没当补细节')
  })

  it('★③ 「的形式。」太短,不当补细节', () => {
    expect(understand('的形式。', ctx({ open })).kind).toBe('none')
  })

  it('★④ 「改为卡片的形式,要平铺。」照旧按切待办认', () => {
    expect(understand('改为卡片的形式,要平铺。', ctx({ open })).kind).toBe('today_view')
  })

  it('★真补细节那一句照旧认、照旧说「加上了」', () => {
    const got = understand('七八岁吧,穿小碎花连衣裙。', ctx({ open }))
    expect(got.kind).toBe('append')
    expect(got.say.start).toBe('加上了:七八岁吧,穿小碎花连衣裙。')
  })

  it('★窗口是 20 秒(统筹定):20 秒之外那一句不并', () => {
    expect(APPEND_WINDOW_MS).toBe(20_000)
    expect(understand('七八岁吧,穿小碎花连衣裙。', ctx({ open: { ...open, at_ms: NOW - 19_000 } })).kind).toBe('append')
    expect(understand('七八岁吧,穿小碎花连衣裙。', ctx({ open: { ...open, at_ms: NOW - 21_000 } })).kind).toBe('none')
  })

  it('★只认紧跟着那件事之后的第一句:中间插过别的话就不再往那件事上并', () => {
    expect(understand('七八岁吧,穿小碎花连衣裙。', ctx({ open: { ...open, first: false } })).kind).toBe('none')
    // `first` 缺席 = 调用方没数(老回包)—— 按第一句算,与这一版之前一字不差
    expect(understand('七八岁吧,穿小碎花连衣裙。', ctx({ open: { item_id: 't-1', said: open.said, at_ms: open.at_ms } })).kind).toBe('append')
  })

  it('★判据本身(纯函数):不算补细节的五种', () => {
    // ① 太短;② 话没说完;③ 别的那件事的词;④ 吩咐句;⑤ 对得上固定流程
    for (const one of ['的形式。', '嗯', '把它改成', '改为', '待办改一下', '换个音色', '帮我把待办的组件改为。', '把灯关上', '待办改回列表']) {
      expect(looksLikeAppendDetail(one, { nowMs: NOW })).toBe(false)
    }
    for (const one of ['七八岁吧,穿小碎花连衣裙', '向日葵吧,吉卜力风格,5 秒,横屏', '要黑猫,逆光', '七八岁吧']) {
      expect(looksLikeAppendDetail(one, { nowMs: NOW })).toBe(true)
    }
    // 不算的那几句各自说得出为什么(日志那一行读它)
    expect(notAppendDetailWhy('的形式。')).toContain('太短')
    expect(notAppendDetailWhy('把它改成')).not.toBeUndefined()
    expect(notAppendDetailWhy('七八岁吧,穿小碎花连衣裙')).toBeUndefined()
  })

  it('★那道闸:同一句再问一遍答案不变,插过别的话就不是第一句了', () => {
    const gate = createAppendGate()
    const open1 = { item_id: 't-1', at_ms: NOW }
    expect(gate.firstAfter(open1, '七八岁吧')).toBe(true)
    // 同一句再问一遍(工人重问 / 重试):还是第一句
    expect(gate.firstAfter(open1, '七八岁吧')).toBe(true)
    // 中间已经插过一句了:这一句不再算第一句
    expect(gate.firstAfter(open1, '穿小碎花连衣裙')).toBe(false)
    // 那件事又被动过(工人带来新的时刻)→ 重新算第一句
    expect(gate.firstAfter({ item_id: 't-1', at_ms: NOW + 1 }, '穿小碎花连衣裙')).toBe(true)
    // 换了另一件事 → 也重新算
    expect(gate.firstAfter({ item_id: 't-2', at_ms: NOW + 1 }, '穿小碎花连衣裙')).toBe(true)
  })
})

describe('点了名的派活:要不要先问一句由 callAsk.ts 说', () => {
  const codex = { family: 'codex', title: 'Codex' }

  it('★说清了就直接办,不问(维护者 10-12:电话里只在拿不准时先确认)', () => {
    const got = understand('让 Codex 把工作台首页那颗球改一下', ctx({ named: codex }))
    expect(got.kind).toBe('dispatch')
    expect(got.confirm.needed).toBe(false)
    expect(got.confirm.why).toBe('clear')
    expect(got.route?.path).toBe('/butler/item')
  })

  it('★撤不回的那种照旧问一句 —— 一句,不是那三条需求确认点', () => {
    const got = understand('让 Codex 把工作台发个版', ctx({ named: codex }))
    expect(got.confirm.needed).toBe(true)
    expect(got.confirm.why).toBe('irreversible')
    expect(got.confirm.spoken).not.toContain('从哪儿触发')
    expect([...(got.confirm.spoken ?? '')].length).toBeLessThan(40)
  })

  it('★她说「先跟我确认」就问', () => {
    expect(understand('让 Codex 改一下首页,先跟我确认一下', ctx({ named: codex })).confirm.why).toBe('asked')
  })

  it('问话不算派活', () => {
    expect(understand('Codex 那边额度还剩多少?', ctx({ named: codex })).kind).toBe('none')
  })
})

/* ──────────────────────── ③《需求确认点》的判据 ──────────────────────── */

describe('《需求确认点》只念给真的产品需求', () => {
  it('★「帮我生成一个小女孩在花海里面漫步的视频」不是产品需求', () => {
    expect(looksLikeProductRequirement('帮我生成一个小女孩在花海里面漫步的视频')).toBe(false)
  })

  it('★「把发布计划那个页面加一个今天的标记」是产品需求', () => {
    expect(looksLikeProductRequirement('把发布计划那个页面加一个今天的标记,现在看不出今天是哪天')).toBe(true)
  })

  it('造东西的动词、产品那一头的对象、话不短 —— 三条缺一不算', () => {
    expect(looksLikeProductRequirement('这个页面不好看')).toBe(false)          // 没有造东西的动词
    expect(looksLikeProductRequirement('做一个番茄钟,25 分钟一轮,响铃提醒')).toBe(false) // 不是产品那一头的对象
    expect(looksLikeProductRequirement('改一下界面')).toBe(false)              // 太短
  })
})

/* ──────────────────────── ④ 10-13 早真机那一通 ──────────────────────── */

describe('真机那一通(10-13 早,手机 App):逐句都不该再出毛病', () => {
  const heard = [
    '帮我生成一个小女孩在花海里面漫步的视频。',
    '为什么要这么说话?呃,我要一个,嗯,向日葵吧,然后是吉普力风格的,然后5秒,5秒钟就可以了,横屏。',
    '七八岁吧,穿小碎花连衣裙。',
    '我是说记一下,哎呀。',
    '你派出去了吗?',
  ]

  it('★第一句认成做视频(不是闲聊、不反问细节)', () => {
    expect(understand(heard[0] as string, ctx()).kind).toBe('video')
  })

  it('★第二句太长、不当补细节(里头是她在抱怨 + 细节)—— 交给模型,不乱并', () => {
    const open = { item_id: 't-1', said: heard[0] as string, at_ms: NOW - 5000 }
    expect(understand(heard[1] as string, ctx({ open })).kind).toBe('none')
  })

  it('★第三句并进那件事', () => {
    const open = { item_id: 't-1', said: heard[0] as string, at_ms: NOW - 5000 }
    expect(understand(heard[2] as string, ctx({ open })).kind).toBe('append')
  })

  it('★那几句里一个字都不许出现「从哪儿触发」', () => {
    for (const said of heard) {
      const got = understand(said, ctx())
      expect(JSON.stringify(got)).not.toContain('从哪儿触发')
      expect(got.say.start).not.toContain('我这就去')
      expect(got.say.start).not.toContain('我还没记下')
    }
  })
})

/* ──────────────────────── ⑤ 三个入口一致 ──────────────────────── */

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-understand-'))
  dirs.push(dir)
  let saved: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(saved),
    writeLayout: (next) => { saved = next; return Promise.resolve() },
  })
  await template.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const opened: string[] = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    template,
    tasks,
    butlerSession: { open: async (text: string) => { opened.push(text); return 's-1' } },
    projects: {
      getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date().toISOString() }),
      confirmStatus: () => Promise.resolve(false),
      setDdl: () => Promise.resolve(false),
      addRule: () => Promise.resolve(),
      getLayout: () => Promise.resolve(saved),
      setLayout: (next: WorkbenchLayout) => { saved = next; return Promise.resolve() },
      invalidateScanCache: () => {},
    },
  } as never)
  started.push(server)
  return { url: server.url, tasks, opened, layout: () => saved }
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number, body: any }> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

describe('POST /butler/understand', () => {
  it('★只回判定,什么都不办(看板上一张卡都没多)', async () => {
    const { url, tasks, opened } = await serve()
    const res = await post(url, '/butler/understand', { text: '12 月 31 号发布一条关于年终总结的视频', source: 'call' })
    expect(res.status).toBe(200)
    expect(res.body.understanding.kind).toBe('publish_plan')
    expect(res.body.understanding.mode).toBe('demo')
    expect((await tasks.list()).tasks.length).toBe(0)
    expect(opened).toEqual([])
  })

  it('空的一句 400', async () => {
    const { url } = await serve()
    expect((await post(url, '/butler/understand', { text: '  ' })).status).toBe(400)
  })

  it('★认不出的那一句回 none(工人照老路交给模型)', async () => {
    const { url } = await serve()
    const res = await post(url, '/butler/understand', { text: '你今天怎么样啊', source: 'call' })
    expect(res.body.understanding.kind).toBe('none')
    expect(res.body.understanding.route).toBeUndefined()
  })
})


/* ──────────────────────── ⑤′ 不误派(2026-10-13 下午,卡 B′)──────────────────────── */



describe('POST /confirm/points:不是产品需求就只念一句', () => {
  it('★「帮我生成一个小女孩在花海里面漫步的视频」不回那三条', async () => {
    const { url } = await serve()
    const res = await post(url, '/confirm/points', { text: '帮我生成一个小女孩在花海里面漫步的视频,向日葵,吉卜力风格,5 秒,横屏' })
    expect(res.status).toBe(200)
    expect(res.body.simple).toBe(true)
    expect(res.body.spoken).not.toContain('从哪儿触发')
    // 卡上那几条确认点一个字没动(`block` 照旧是整份,它进的是卡,不是电话)
    expect(res.body.points.length).toBeGreaterThan(0)
    expect(res.body.block).toContain('从哪儿触发')
  })

  it('真的产品需求照旧念那三条', async () => {
    const { url } = await serve()
    const res = await post(url, '/confirm/points', { text: '把发布计划那个页面加一个今天的标记,现在看不出今天是哪天' })
    expect(res.body.simple).toBe(false)
    expect(res.body.spoken.length).toBeGreaterThan(20)
  })
})

/* ──────────────────────── ⑥ 来电那一头:开场要说得清事 + 旧会话的框不响 ──────────────────────── */

describe('别家会话那一问:权限弹窗也带上原题(来电开场才说得清事)', () => {
  const since = new Date(NOW - 60_000).toISOString()

  it('★权限弹窗那一问:从前故意不带 ask,现在一律带 + permission:true', () => {
    const out = sessionAskCallOutEvents({
      sessions: [{
        agent: 'claude',
        session_id: 's-1',
        name: 'Claude',
        ask: { kind: 'nod', by: 'form', question: '要不要合进 main', since, options: [], permission: { readable: true } },
      } as never],
      nowMs: NOW,
    })
    expect(out.length).toBe(1)
    expect(out[0]?.ask).toEqual({ from: 'Claude', question: '要不要合进 main', options: [], permission: true })
  })

  it('选择题那一问照旧带(没有 permission 这一格)', () => {
    const out = sessionAskCallOutEvents({
      sessions: [{
        agent: 'doubao',
        session_id: 's-2',
        name: '豆包',
        ask: { kind: 'pick', by: 'form', question: '你喜欢喝什么饮料?', since, options: [{ label: '绿茶' }, { label: '咖啡' }] },
      } as never],
      nowMs: NOW,
    })
    expect(out[0]?.ask).toEqual({ from: '豆包', question: '你喜欢喝什么饮料?', options: ['绿茶', '咖啡'] })
  })
})

describe('★超过一天没动的会话里的弹窗不响铃(2026-10-13,统筹定)', () => {
  const askAt = (since: string) => ({ kind: 'nod', by: 'form', question: '要不要合进 main', since, options: [] })
  const one = (since: string) => ({ agent: 'claude', session_id: 's-1', ask: askAt(since) } as never)

  it('当天 / 隔夜的照响', () => {
    expect(sessionAskCallOutEvents({ sessions: [one(new Date(NOW - 20 * 60 * 60 * 1000).toISOString())], nowMs: NOW }).length).toBe(1)
  })

  it('★四天前那个框不响(10-13 上午那几通就是 10-04、10-12 的旧会话打来的)', () => {
    expect(sessionAskCallOutEvents({ sessions: [one(new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString())], nowMs: NOW })).toEqual([])
  })

  it('不传 nowMs = 不按时间筛(与这一版之前逐字相同)', () => {
    expect(sessionAskCallOutEvents({ sessions: [one(new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString())] }).length).toBe(1)
  })

  it('读不出时刻就照响(宁可响:漏响的代价是一件真卡住的事没人管)', () => {
    expect(sessionAskTooOld({}, NOW)).toBe(false)
    // 这一问没时刻、但会话最后动过的时刻在 → 按会话那一格算
    expect(sessionAskTooOld({ updated_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() }, NOW)).toBe(true)
    expect(SESSION_ASK_STALE_MS).toBe(24 * 60 * 60 * 1000)
  })
})
