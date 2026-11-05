// @vitest-environment node
/**
 * **图和提示词交给可灵桌面版、按下生成**(2026-10-12,卡「演示 · 出图进可灵」)。
 *
 * 10-12 端到端真跑之后的路:把可灵叫到前面 → 在**当前标签页**里按名字点「生成」(导航链接)→「视频生成」(页签)→
 * 贴图(壳 `paste_image`)→ 写提示词(`send_text`,只写不发;框里上一回留下的字照盖、原文交回)→
 * 按底部那颗「生成」(只认 `AXButton`)。不开新标签页(可灵自带入口每跑一次开一个,背后标签页的同名键分不出)。
 * 进入生成就算完成,看不到「生成中」不说成在生成。
 *
 * ## ★ 2026-10-13 晚:判据收紧(卡 O)
 *
 * 两次真机都在「说了已经开始生成、可灵其实没接单」上栽:本机 17:22(可灵页报错重载,首帧与提示词被清空)、
 * 演示机 20:31(壳每一步都回成功、可灵那边任务卡住)。所以:按之前读一眼留底,按完 2 / 5 / 10 秒各读一眼,
 * 只认**新出现**的「创作中 / 排队」行或者**多出来**的结果卡;看不到就当没接单 —— 核图和词、少的那样重做、
 * 再按一次,还不成就 `failed` 说实话(从前那一档 `pressed` 照旧收卡说「办完了」,现在没有这一档了)。
 * 贴图也要核:首帧格那一句没从「添加 首尾帧图」变成「添加 尾帧图(可选)」就重贴一次。
 *
 * ## ★ 2026-10-13 晚:按生成之前先确认图传完了(卡 Q)
 *
 * 演示机那一单**坐实**了:可灵出的片子与参考图无关,而维护者在同一页(首帧格已有图)手按「60 生成」
 * 就按参考图生成了 —— 贴完图立刻按生成 = 图还在往可灵传,按下去等于没图。
 * 所以贴图之后要等:首帧格不空、页面上没有「上传中」那类字、底部生成键读回来**带数字**(「🔥 60 生成」),
 * 每秒读一眼,最少 2 秒、最多 20 秒;等不出来照卡 O 那条路走,但卡上留一句「图可能没传完」。
 */
import { describe, expect, it } from 'vitest'
import {
  KLING_BUNDLE, KLING_GENERATE_ROLE, KLING_IMAGE_MISSING_WHY, KLING_IMAGE_SLOW_NOTE,
  KLING_IMAGE_UNREADABLE_NOTE, KLING_LATE_TRIES, KLING_NAV, KLING_NAV_TRIES, KLING_NOT_TAKEN_WHY,
  KLING_STARTED_BY_CARD, KLING_STARTED_BY_LOG, KLING_TICK_MS, KLING_UNREADABLE_WHY, KLING_UPLOAD_MIN_MS,
  KLING_UPLOAD_MAX_MS, KLING_UPLOAD_TICK_MS, klingDoneBar, klingNewWorking, klingPageLook, klingUploadVerdict, klingUploadedImage, runKlingStep,
} from '../src/server/klingStep.ts'
import type { KlingHelper } from '../src/server/klingStep.ts'

type Req = Record<string, unknown> & { op: string }

function fakeHelper(script: (req: Req) => Record<string, unknown>): { helper: KlingHelper, calls: Req[] } {
  const calls: Req[] = []
  return { calls, helper: { request: async (req) => { calls.push(req); return script(req) } } }
}

const deps = (helper: KlingHelper, opened: { n: number } = { n: 0 }) => ({
  helper, openApp: async () => { opened.n += 1 }, sleep: async () => {}, pollMs: 1, loadTries: 3,
})

const PROMPT = '以这张图为第一帧,构图、主体外观和光线保持不变。镜头缓慢推进。'
/** 首帧填上了那一句(10-12 真量:贴之前是「添加 首尾帧图」)。 */
const FRAME_FILLED = { t: '添加 尾帧图(可选)' }
const FRAME_EMPTY = { t: '添加 首尾帧图' }
/** 新那条任务卡上的字(10-12 真量)。 */
const WORKING = { t: '创作中,预计等待 1 分钟' }
/**
 * ★ 底部那颗生成键的两种读法(10-13 真量 + 21:5x 演示机截图原字):
 * 图和词都齐了带点数「🔥 60 生成」,空着时光一个「生成」(17:27 真量)。
 */
const KEY_READY = { t: '🔥 60 生成' }
const KEY_BARE = { t: '生成' }

/**
 * 一页正常的可灵:导航两下点得到、框认得出、贴图写字都成、生成键按得下,
 * **而且按完它真接下了**(读窗里多出「创作中」那一行)。`page` 可以改每一眼读到什么。
 *
 * ★ 默认那一页带上生成键「🔥 60 生成」(卡 Q:图传完了的旁证);
 * 自己给 `page` 的用例多半不带它 —— 那是「这颗键读不出来」,照旧不当拦路(等满最少那两秒就走)。
 */
function happy(overrides: (req: Req) => Record<string, unknown> | undefined = () => undefined, page?: (ctx: { pressed: boolean, pastes: number, look: number }) => readonly { t: string, y?: number }[]) {
  let finds = 0
  let pressed = false
  let pastes = 0
  let look = 0
  const rows = page ?? (ctx => (ctx.pressed ? [FRAME_FILLED, { t: PROMPT }, KEY_READY, WORKING] : [FRAME_FILLED, { t: PROMPT }, KEY_READY]))
  const made = fakeHelper((req) => {
    const over = overrides(req)
    if (over !== undefined) return over
    if (req.op === 'unhide_app') return { ok: true, result: {} }
    if (req.op === 'agent_press') {
      if (req.role === KLING_GENERATE_ROLE) pressed = true
      return { ok: true, result: { found: true, pressed: true, how: 'ax_press' } }
    }
    if (req.op === 'focus_input') { finds += 1; return finds === 1 ? { ok: true, result: { candidates: [] } } : { ok: true, result: { picked: { writable: true } } } }
    if (req.op === 'clear_frames') return { ok: true, result: { deleted: 1, left: 0 } }
    if (req.op === 'paste_image') { pastes += 1; return { ok: true, result: { pasted: true, clipboard_restored: true } } }
    if (req.op === 'send_text') return { ok: true, result: { method: 'ax_value', draft: '上一回留下的那句' } }
    if (req.op === 'agent_read') { look += 1; return { ok: true, result: { tail: rows({ pressed, pastes, look }) } } }
    return { ok: false, error: 'unknown' }
  })
  return { ...made, generates: () => made.calls.filter(one => one.op === 'agent_press' && one.role === KLING_GENERATE_ROLE).length }
}

describe('一条路走完', () => {
  it('叫到前面 → 当前页里点「生成」→「视频生成」→ 贴图 → 写提示词(不发)→ 按「生成」键 → 看到「生成中」= started', async () => {
    const opened = { n: 0 }
    const { helper, calls } = happy()
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: '海边日落,镜头推进' }, deps(helper, opened))
    /*
     * ★ `seen` = 判成「开始了」的是读窗里哪一行字(卡 M);2026-10-13 晚起它必须是**按完才新出现**的那一行(卡 O)。
     * `cards` = 按之前结果列里有几条做完的卡(等出片那一层拿它当底)。
     */
    expect(got).toEqual({ kind: 'started', how: 'ax_press', label: '生成', seen: WORKING.t, cards: 0, replaced: '上一回留下的那句' })
    expect(opened.n).toBe(1)
    const presses = calls.filter(one => one.op === 'agent_press').map(one => ({ label: one.label, role: one.role }))
    expect(presses).toEqual([...KLING_NAV, { label: '生成', role: KLING_GENERATE_ROLE }])
    const ops = calls.map(one => one.op)
    // 先点到那一页,再等框;先贴图、再写字、最后按生成。
    expect(ops.indexOf('focus_input')).toBeGreaterThan(ops.indexOf('agent_press'))
    expect(ops.indexOf('paste_image')).toBeLessThan(ops.indexOf('send_text'))
    // 贴图之前先删上一回留下的帧图(不然新图贴成尾帧)。
    expect(ops.indexOf('clear_frames')).toBeGreaterThan(ops.indexOf('focus_input'))
    expect(ops.indexOf('clear_frames')).toBeLessThan(ops.indexOf('paste_image'))
    expect(ops.lastIndexOf('agent_press')).toBeGreaterThan(ops.indexOf('send_text'))
    // 每次找框之前先把它从藏起来里放出来(藏着时 Chromium 的树停在旧画面)。
    expect(ops[ops.indexOf('focus_input') - 1]).toBe('unhide_app')
    expect(calls.find(one => one.op === 'paste_image')).toMatchObject({ bundle_id: KLING_BUNDLE, path: '/tmp/a.png' })
    expect(calls.find(one => one.op === 'send_text')).toMatchObject({ bundle_id: KLING_BUNDLE, text: '海边日落,镜头推进', submit: false, save_draft: true })
  })

  it('★切过去就动:每两步之间不再固定干等(10-13 维护者:切到可灵之后等了 5、6 秒才动)', async () => {
    let slept = 0
    let generated = false
    let pasted = false
    const marks: { op: string, slept: number }[] = []
    const base = happy()
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, {
      openApp: async () => {},
      helper: {
        request: async (req, timeoutMs) => {
          marks.push({ op: req.op, slept })
          if (req.op === 'paste_image') pasted = true
          if (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE) generated = true
          return await base.helper.request(req, timeoutMs)
        },
      },
      /*
       * 贴图**之前**一拍最多 {@link KLING_TICK_MS}(出现 1500 那种固定等待就红);
       * 贴完到按下那一段是**等图传完**那一拍({@link KLING_UPLOAD_TICK_MS},卡 Q:最少 2 秒,它是故意等的);
       * 按完那 10 秒也是故意等的(判「它接下了没有」要给可灵时间,见 `KLING_WATCH_AT_MS`)。
       */
      sleep: async (ms) => {
        if (!pasted) expect(ms).toBeLessThanOrEqual(KLING_TICK_MS)
        else if (!generated) expect(ms).toBeLessThanOrEqual(KLING_UPLOAD_TICK_MS)
        slept += ms
      },
    })
    expect(got.kind).toBe('started')
    // 开页之后第一下(点左侧「生成」)之前一拍都不等。
    expect((marks.find(one => one.op === 'agent_press') as { slept: number }).slept).toBe(0)
    // 从开页到贴上图,总共等不到两秒(真机上要在 1–2 秒内开始动)。
    expect((marks.find(one => one.op === 'paste_image') as { slept: number }).slept).toBeLessThan(2000)
  })

  /**
   * ★ **判成「开始了」的那一行字要留得下来**(2026-10-13,卡 M)。
   * 2026-10-13 晚(卡 O):那一行还必须是按完才**新出现**的 —— 判据见下面几条。
   */
  it('★判成 started 的是哪一行字,原样带回来', async () => {
    const w = happy(undefined, ctx => (ctx.pressed ? [{ t: '提示词' }, { t: '排队中,预计等待 1 分钟' }] : [{ t: '提示词' }]))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', seen: '排队中,预计等待 1 分钟' })
  })
})

/* ──────── ★ 判「它接下这一单了没有」:2026-10-13 两次真机(卡 O)──────── */

describe('★只认按完新出现的那一条', () => {
  /**
   * 17:22 本机那条的样子:按之前页面上**本来就有**一行「创作中」(上一条还在跑 / 旧画面),
   * 按完还是那一行 —— 老判据「命中任意一行」把它判成了 `started`,卡上写「已经在可灵里开始生成了」,
   * 可灵里从来没有这条任务。
   *
   * ★ 统筹 21:2x 收窄:这种「图和词都还在、只是没读到新那一行」**一下都不补按**
   * (可灵日志里没有「提交了任务」的记号,读窗那一行又没量过;台上多按一次 = 两份额度、两条任务),
   * 转去等 90 秒,等不到才如实说。
   */
  it('★按前就有一行旧的「创作中」、按完没多出来、图和词都还在 → 不补按、等满 90 秒 → failed 一句人话', async () => {
    const stale = { t: '创作中,预计等待 2 分钟' }
    const w = happy(undefined, () => [FRAME_FILLED, { t: PROMPT }, stale])
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toEqual({ kind: 'failed', step: 'press', why: KLING_NOT_TAKEN_WHY })
    // ★ 生成键只按了一下,图和词一样都没重做。
    expect(w.generates()).toBe(1)
    expect(w.calls.filter(one => one.op === 'paste_image')).toHaveLength(1)
    expect(w.calls.filter(one => one.op === 'send_text')).toHaveLength(1)
    // 等那 90 秒是真在读窗(一拍 5 秒 × 18 拍),不是干等。
    expect(w.calls.filter(one => one.op === 'agent_read').length).toBeGreaterThan(KLING_LATE_TRIES)
  })

  /**
   * ★ 等那 90 秒里认出来了:演示机 20:35 那种「其实做了」不能被误判成没接单。
   * 判据三样任一 —— 日志里按下之后的 `AllTaskFinish`、读窗新出现的那一行、结果卡变多。
   */
  it('★图和词都还在、读窗一直没新行,等着时可灵日志里出现「创作完成」→ started 接着走', async () => {
    const stale = { t: '创作中,预计等待 2 分钟' }
    const w = happy(undefined, () => [FRAME_FILLED, { t: PROMPT }, stale])
    const at = Date.parse('2026-10-13T12:31:00Z')
    let looks = 0
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, {
      ...deps(w.helper),
      now: () => at,
      // 头十来拍里什么都没有,之后日志里记上了按下之后那条「创作完成」。
      readLog: async () => ((looks += 1) < 12 ? '' : `[2026-10-13T12:32:00.000Z] [INFO] [Notification] 收到推送 {\n  "timestamp": ${at + 60_000},\n  "notixTopic": "AllTaskFinish"\n}\n`),
    })
    expect(got).toMatchObject({ kind: 'started', seen: KLING_STARTED_BY_LOG })
    expect(w.generates()).toBe(1)
  })

  // 第 13 眼之后才多出那一行:卡 Q 之后按下生成之前要多读几眼(贴图前留底 + 等图传完那几拍,
  // 22:2x 起最少等六秒 = 又多四眼),所以这个门槛跟着往后挪 —— 它要落在「按完盯 10 秒」之后,
  // 才验得到「接着等 90 秒」那一支。
  it('★图和词都还在、等着时读窗终于多出一条「创作中」→ started(凭那一行)', async () => {
    const stale = { t: '创作中,预计等待 2 分钟' }
    const w = happy(undefined, ctx => (ctx.look < 13 ? [FRAME_FILLED, { t: PROMPT }, stale] : [FRAME_FILLED, { t: PROMPT }, stale, { t: '排队中' }]))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))).toMatchObject({ kind: 'started', seen: '排队中' })
    expect(w.generates()).toBe(1)
  })

  it('按前就有一行旧的、按完同一句多了一条 → started(数字一样也按条数分得出来)', async () => {
    const stale = { t: '创作中,预计等待 2 分钟' }
    const w = happy(undefined, ctx => (ctx.pressed ? [FRAME_FILLED, { t: PROMPT }, stale, { ...stale }] : [FRAME_FILLED, { t: PROMPT }, stale]))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))).toMatchObject({ kind: 'started', seen: stale.t })
    expect(w.generates()).toBe(1)
  })

  it('★旧那条的百分比在跳(32% → 57%)不算新一条:数字抹掉再比', async () => {
    const w = happy(undefined, ctx => [FRAME_FILLED, { t: PROMPT }, { t: `视频生成中 ${30 + ctx.look * 9}%` }])
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'failed', why: KLING_NOT_TAKEN_WHY })
    // 图和词都还在 → 一下都不补按(统筹 21:2x)。
    expect(w.generates()).toBe(1)
  })

  it('★一行「创作中」都没有、但结果列里多了一条做完的卡 → 也算接下了', async () => {
    const w = happy(undefined, ctx => (ctx.pressed
      ? [FRAME_FILLED, { t: PROMPT }, { t: '00:01 / 00:05', y: 120 }, { t: '00:02 / 00:05', y: 300 }]
      : [FRAME_FILLED, { t: PROMPT }, { t: '00:02 / 00:05', y: 300 }]))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper)))
      .toMatchObject({ kind: 'started', seen: KLING_STARTED_BY_CARD, cards: 1 })
  })

  /**
   * 17:22 真机那一轮可灵自己在新开标签页、那个页 `Failed to load remote URL` 之后重载 ——
   * 重载把首帧与提示词都清空了。读得出来的样子:首帧格变回「添加 首尾帧图」、尾巴里没有我们那句。
   */
  it('★页面重载过(首帧格变回「添加 首尾帧图」、提示词没了)→ 重贴重写再按一次', async () => {
    let reloaded = false
    const w = happy(undefined, (ctx) => {
      if (ctx.pressed) reloaded = true
      // 重贴之后那一格又填上了(第二次贴图算成功)。
      return reloaded && ctx.pastes < 2 ? [FRAME_EMPTY] : [FRAME_FILLED, { t: PROMPT }, ...(ctx.pastes >= 2 && ctx.pressed ? [WORKING] : [])]
    })
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t })
    expect(w.calls.filter(one => one.op === 'paste_image')).toHaveLength(2)
    expect(w.calls.filter(one => one.op === 'send_text')).toHaveLength(2)
    expect(w.generates()).toBe(2)
  })

  it('★贴图没上(首帧格还写着「添加 首尾帧图」)→ 重贴一次;再不上 → failed,不写词不按生成', async () => {
    const once = happy(undefined, ctx => (ctx.pastes < 2 ? [FRAME_EMPTY] : [FRAME_FILLED, { t: PROMPT }, ...(ctx.pressed ? [WORKING] : [])]))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(once.helper))).toMatchObject({ kind: 'started' })
    expect(once.calls.filter(one => one.op === 'paste_image')).toHaveLength(2)

    const never = happy(undefined, () => [FRAME_EMPTY])
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(never.helper))
    expect(got).toEqual({ kind: 'failed', step: 'image', why: KLING_IMAGE_MISSING_WHY })
    expect(never.calls.filter(one => one.op === 'paste_image')).toHaveLength(2)
    expect(never.calls.some(one => one.op === 'send_text')).toBe(false)
    expect(never.generates()).toBe(0)
  })

  /**
   * ★ 「读不到」与「它没接下」是两件事:壳读不到可灵(藏着 / 树停住 / 尾巴空)时这一下多半进去了。
   * 这时**不补按**(补按就是真生成两条),也不说成开始了。
   */
  it('★读窗一行字都没读到 → 不补按,如实说看不出它接没接下', async () => {
    const w = happy(undefined, () => [])
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toEqual({ kind: 'failed', step: 'press', why: KLING_UNREADABLE_WHY })
    expect(w.generates()).toBe(1)
    expect(w.calls.filter(one => one.op === 'paste_image')).toHaveLength(1)
  })

  it('★首帧格那两句一句都读不出来(壳读不到 / 尾巴被截)→ 照旧往下走,不当拦路', async () => {
    const w = happy(undefined, ctx => (ctx.pressed ? [{ t: '提示词' }, WORKING] : [{ t: '提示词' }]))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))).toMatchObject({ kind: 'started' })
    expect(w.calls.filter(one => one.op === 'paste_image')).toHaveLength(1)
  })

  it('读窗那两个判据单独算得清', () => {
    const before = klingPageLook([{ t: '创作中,预计等待 1 分钟' }, { t: '00:01 / 00:05', y: 10 }, FRAME_FILLED])
    expect(before).toMatchObject({ cards: 1, frame: 'filled' })
    expect(before.working).toEqual({ '创作中,预计等待 # 分钟': 1 })
    // 同一句照旧 / 只是数字变了 → 不算新。
    expect(klingNewWorking(before, [{ t: '创作中,预计等待 3 分钟' }])).toBeUndefined()
    // 同一句多了一条、或者冒出来另一句 → 算新,原文带回来。
    expect(klingNewWorking(before, [{ t: '创作中,预计等待 1 分钟' }, { t: '创作中,预计等待 1 分钟' }])).toBe('创作中,预计等待 1 分钟')
    expect(klingNewWorking(before, [{ t: '排队中' }])).toBe('排队中')
    expect(klingPageLook([FRAME_EMPTY]).frame).toBe('empty')
    expect(klingPageLook([{ t: '提示词' }]).frame).toBe('unknown')
  })
})

/* ──────── ★ 按生成之前先确认图传完了:2026-10-13 晚演示机那一单(卡 Q)──────── */

describe('★图传完了才写词、按生成', () => {
  /**
   * 坐实的那一单:自动那一回出来的片子与参考图无关,维护者手按同一页的「60 生成」就按参考图生成了。
   * 读得出来的判据:底部生成键带点数(「🔥 60 生成」= 这一格的东西齐了;空着时光一个「生成」)。
   */
  it('★生成键还是光一个「生成」(图没传完)→ 一下都不按;带上点数了才按', async () => {
    let uploaded = false
    const w = happy(undefined, (ctx) => {
      // 贴完第 3 眼才传完(真机上 3–5 MB 要几秒)。
      if (ctx.pastes > 0 && ctx.look >= 4) uploaded = true
      return [FRAME_FILLED, { t: PROMPT }, uploaded ? KEY_READY : KEY_BARE, ...(ctx.pressed ? [WORKING] : [])]
    })
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t })
    // ★ 卡上没有「图可能没传完」那一句:这一单真等到了。
    expect(got).not.toHaveProperty('imageWait')
    // 按生成之前读了好几眼(等图传完),而且写词在等完之后。
    const ops = w.calls.map(one => one.op)
    const press = ops.lastIndexOf('agent_press')
    expect(ops.slice(0, press).filter(one => one === 'agent_read').length).toBeGreaterThanOrEqual(4)
    expect(ops.indexOf('send_text')).toBeGreaterThan(ops.indexOf('paste_image') + 1)
    expect(w.generates()).toBe(1)
  })

  it('★页面上写着「正在上传」→ 接着等,不按', async () => {
    let n = 0
    const w = happy(undefined, (ctx) => {
      if (ctx.pastes > 0) n += 1
      return [FRAME_FILLED, { t: PROMPT }, KEY_READY, ...(n > 0 && n < 4 ? [{ t: '正在上传 43%' }] : []), ...(ctx.pressed ? [WORKING] : [])]
    })
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started' })
    expect(got).not.toHaveProperty('imageWait')
    // 上传那几行还在时一个字都没写进去。
    const ops = w.calls.map(one => one.op)
    expect(ops.indexOf('send_text')).toBeGreaterThan(ops.indexOf('paste_image') + 3)
  })

  /** 等满 20 秒还看不出传完:**照卡 O 那条路走**(不新增拦路),但卡上留一句。 */
  it('★等满 20 秒也看不出图传完 → 照旧按,卡上留一句「图可能没传完」', async () => {
    const w = happy(undefined, ctx => [FRAME_FILLED, { t: PROMPT }, KEY_BARE, ...(ctx.pressed ? [WORKING] : [])])
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t, imageWait: KLING_IMAGE_SLOW_NOTE })
    expect(KLING_IMAGE_SLOW_NOTE).toContain('图可能没传完')
    expect(w.generates()).toBe(1)
  })

  it('★一行字都读不到 → 不拦路,卡上那句说的是「看不出来」,不是「没传完」', async () => {
    // 按完能读到(不然走的是 KLING_UNREADABLE_WHY 那一档);只有等传完那几眼读空。
    const w = happy(undefined, ctx => (ctx.pressed ? [FRAME_FILLED, { t: PROMPT }, WORKING] : []))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', imageWait: KLING_IMAGE_UNREADABLE_NOTE })
  })

  it('★最少等那两秒:读第一眼就齐了也不立刻按', async () => {
    let slept = 0
    let pasted = false
    let beforePress = 0
    const base = happy()
    await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, {
      openApp: async () => {},
      helper: {
        request: async (req, timeoutMs) => {
          if (req.op === 'paste_image') pasted = true
          if (pasted && beforePress === 0 && req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE) beforePress = slept
          return await base.helper.request(req, timeoutMs)
        },
      },
      sleep: async (ms) => { if (pasted) slept += ms },
      pollMs: 1,
      loadTries: 3,
    })
    expect(beforePress).toBeGreaterThanOrEqual(KLING_UPLOAD_MIN_MS)
  })

  it('★页面重置那一支重贴之后也要等图传完(别又按在没传完的图上)', async () => {
    let reloaded = false
    const w = happy(undefined, (ctx) => {
      if (ctx.pressed) reloaded = true
      return reloaded && ctx.pastes < 2
        ? [FRAME_EMPTY, KEY_BARE]
        : [FRAME_FILLED, { t: PROMPT }, KEY_READY, ...(ctx.pastes >= 2 && ctx.pressed ? [WORKING] : [])]
    })
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t })
    // 第二次贴完也隔了几眼才按第二下。
    const ops = w.calls.map(one => one.op)
    const secondPaste = ops.lastIndexOf('paste_image')
    expect(ops.slice(secondPaste, ops.lastIndexOf('agent_press')).filter(one => one === 'agent_read').length).toBeGreaterThanOrEqual(2)
  })

  /**
   * ★ **2026-10-13 22:3x 本机探针原样**(卡 S):壳读可灵生成页,首帧格与生成键都在 `side` 那一列 ——
   * `side`:「添加 尾帧图(可选) 历史创作」(AXButton)、「60 生成」(AXButton);
   * `tail`:左侧导航「创意圈 / 资产 / Omni / **生成** / 全部工具」(`ctl: true`)、提示词、结果卡「00:03 / 00:05」。
   * 卡 Q 只看 `tail`:首帧格读不到、生成键是导航那条光秃秃的「生成」→ 22:03 那条链白等满 20 秒,卡上还留了「图可能没传完」。
   */
  const SIDE_FRAME_FILLED = { t: '添加 尾帧图(可选) 历史创作', y: 197 }
  const SIDE_FRAME_EMPTY = { t: '添加 首尾帧图 历史创作', y: 197 }
  const SIDE_KEY = { t: '60 生成', y: 838 }
  const NAV_GENERATE = { t: '生成', y: 323, ctl: true }
  const NAV_ROWS = [{ t: '创意圈', y: 130, ctl: true }, NAV_GENERATE, { t: '全部工具', y: 443, ctl: true }]

  it('★首帧格与生成键在 side 那一列、tail 里只有导航那条「生成」→ 等满最少那几秒就按,不白等 20 秒', async () => {
    let pressed = false
    let pasted = false
    let slept = 0
    let beforePress = 0
    const w = happy((req) => {
      if (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE) pressed = true
      if (req.op === 'paste_image') pasted = true
      if (req.op === 'agent_read') {
        return { ok: true, result: {
          side: [pasted ? SIDE_FRAME_FILLED : SIDE_FRAME_EMPTY, SIDE_KEY],
          tail: [...NAV_ROWS, { t: PROMPT }, { t: '00:03 / 00:05', y: 584 }, ...(pressed ? [WORKING] : [])],
        } }
      }
      return undefined
    })
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, {
      ...deps(w.helper),
      helper: {
        request: async (req, timeoutMs) => {
          if (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE && beforePress === 0) beforePress = slept
          return await w.helper.request(req, timeoutMs)
        },
      },
      sleep: async (ms) => { if (pasted && !pressed) slept += ms },
    })
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t })
    // ★ 卡上没有「图可能没传完」:这一眼读得出首帧格填上了、生成键带点数。
    expect(got).not.toHaveProperty('imageWait')
    // 贴完到按下:最少那几秒之后、远不到 20 秒。
    expect(beforePress).toBeGreaterThanOrEqual(KLING_UPLOAD_MIN_MS)
    expect(beforePress).toBeLessThan(KLING_UPLOAD_MAX_MS)
    expect(w.generates()).toBe(1)
  })

  it('★贴图核首帧格也看 side:贴完那一格还写着「添加 首尾帧图」→ 重贴一次;变成「添加 尾帧图(可选)」才算贴上', async () => {
    let pastes = 0
    const w = happy((req) => {
      if (req.op === 'paste_image') pastes += 1
      if (req.op === 'agent_read') {
        return { ok: true, result: { side: [pastes >= 2 ? SIDE_FRAME_FILLED : SIDE_FRAME_EMPTY, SIDE_KEY], tail: [...NAV_ROWS, { t: PROMPT }] } }
      }
      return undefined
    })
    // 按完读不到「创作中」也没关系:这条只看贴图那一步。
    await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper))
    expect(pastes).toBe(2)
  })

  it('★导航那条「生成」不算生成键:只有它时不当「还没传完」', () => {
    const before = klingPageLook([])
    expect(klingUploadVerdict(before, [...NAV_ROWS, { t: PROMPT }])).toBe('ready')
    expect(klingUploadVerdict(before, [SIDE_FRAME_FILLED, SIDE_KEY, ...NAV_ROWS])).toBe('ready')
    // 真有一颗没点数的生成键(不是导航)照旧算没齐。
    expect(klingUploadVerdict(before, [SIDE_FRAME_FILLED, KEY_BARE, ...NAV_ROWS])).toBe('waiting')
    // side 里那一格空着 = 没贴上。
    expect(klingPageLook([SIDE_FRAME_EMPTY, SIDE_KEY, ...NAV_ROWS]).frame).toBe('empty')
    expect(klingPageLook([SIDE_FRAME_FILLED, SIDE_KEY, ...NAV_ROWS]).frame).toBe('filled')
  })

  /**
   * ★ **真信号:首帧格里那张图本身**(2026-10-13 22:4x 本机探针,卡 T)。维护者:「按钮一直是 60 点,只能从图片判断,
   * 有一个 loading,然后显示完整的图片」。探针(`probe-send-text.sh images com.electron.klingai`)在传完的页上读到:
   * 首帧格(x 110, y 197, 203×183)是一个 AXImage,`AXURL` =
   * `https://p4-fdl.klingai.com/bs2/upload-ylab-stunt/ai_portal/1791900243/AQqqvuOq4G/%E5%8F%82%E8%80%83%E5%9B%BE-20261013-220351.png?…`
   * —— 上传完成后 CDN 的地址,**带着我们那张参考图的文件名**。这个地址只在上传真完成之后才存在,
   * 所以「首帧格里出现一张 https 地址带我们文件名的 AXImage」= 传完了,当场写词、按生成,不再盲等 6 秒。
   * 壳新 op `agent_images`(只读);老壳回「未知 op」→ 退回卡 S 的文字判据 + 6 秒。
   */
  const IMAGE_PATH = '/Users/example/Documents/工作台/选题/钵钵跳舞/素材/参考图-20261013-220351.png'
  const UPLOADED = { x: 110, y: 197, w: 203, h: 183, url: 'https://p4-fdl.klingai.com/bs2/upload-ylab-stunt/ai_portal/1791900243/AQqqvuOq4G/%E5%8F%82%E8%80%83%E5%9B%BE-20261013-220351.png?x-kcdn-pid=112344&pkey=AAXNU', desc: '/format,webp' }
  const OLD_UPLOADED = { x: 110, y: 197, w: 203, h: 183, url: 'https://p4-fdl.klingai.com/bs2/upload-ylab-stunt/ai_portal/1791897103/Zz/%E5%8F%82%E8%80%83%E5%9B%BE-20261013-211550.png?x-kcdn-pid=112344', desc: '/format,webp' }
  const PREVIEW = { x: 110, y: 197, w: 203, h: 183, url: 'blob:https://klingai.com/3f1c2e0a-9d2b-4c5e-8a1b-0c9d8e7f6a5b' }
  const THUMB = { x: 1321, y: 119, w: 58, h: 58, url: 'https://p2-kling.klingai.com/bs2/upload-ylab-stunt/7a629691-output_ff.jpg?x-kcdn-pid=112452', desc: 'Thumbnail' }
  const LOGO = { x: 102, y: 120, w: 48, h: 48, url: 'https://p2-kling.klingai.com/kcdn/cdn-kcdn112452/kling-web/assets/images/kling-3.0-CjpSr6Jj.png', desc: '/kling-3.0-CjpSr6Jj.png' }

  it('★壳能读图:首帧格里出现带我们文件名的 https 图 → 当场写词按生成,不等那 6 秒', async () => {
    let pasted = false
    let looks = 0
    let slept = 0
    let beforePress = 0
    const w = happy((req) => {
      if (req.op === 'paste_image') pasted = true
      if (req.op === 'agent_images') {
        looks += 1
        // 贴完头两眼是本地预览(blob:),第三眼才换成上传完的 CDN 地址。
        return { ok: true, result: { images: [LOGO, THUMB, pasted && looks >= 3 ? UPLOADED : PREVIEW] } }
      }
      return undefined
    })
    const got = await runKlingStep({ imagePath: IMAGE_PATH, prompt: PROMPT }, {
      ...deps(w.helper),
      helper: {
        request: async (req, timeoutMs) => {
          if (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE && beforePress === 0) beforePress = slept
          return await w.helper.request(req, timeoutMs)
        },
      },
      sleep: async (ms) => { if (pasted && beforePress === 0) slept += ms },
    })
    expect(got).toMatchObject({ kind: 'started', seen: WORKING.t, imageSeen: true })
    expect(got).not.toHaveProperty('imageWait')
    // 看到地址那一眼就走:贴完到按下不到最少那 6 秒(只隔了等图那两三拍)。
    expect(beforePress).toBeLessThan(KLING_UPLOAD_MIN_MS)
    expect(beforePress).toBeGreaterThan(0)
    expect(w.calls.filter(one => one.op === 'agent_images').length).toBeGreaterThanOrEqual(3)
  })

  it('★上一回留下的那张图(别的文件名)与结果列缩略图都不算;20 秒还没见到我们那张 → 照旧按,卡上留一句', async () => {
    const w = happy((req) => {
      if (req.op === 'agent_images') return { ok: true, result: { images: [LOGO, THUMB, OLD_UPLOADED] } }
      return undefined
    })
    const got = await runKlingStep({ imagePath: IMAGE_PATH, prompt: PROMPT }, deps(w.helper))
    expect(got).toMatchObject({ kind: 'started', imageWait: KLING_IMAGE_SLOW_NOTE })
    expect(got).not.toHaveProperty('imageSeen')
    expect(w.generates()).toBe(1)
  })

  it('★老壳没有 agent_images(回未知 op)→ 退回文字判据 + 最少 6 秒,只问一次', async () => {
    let asked = 0
    let pasted = false
    let slept = 0
    let beforePress = 0
    const w = happy((req) => {
      if (req.op === 'paste_image') pasted = true
      if (req.op === 'agent_images') { asked += 1; return { ok: false, error: '未知 op:agent_images' } }
      return undefined
    })
    const got = await runKlingStep({ imagePath: IMAGE_PATH, prompt: PROMPT }, {
      ...deps(w.helper),
      helper: {
        request: async (req, timeoutMs) => {
          if (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE && beforePress === 0) beforePress = slept
          return await w.helper.request(req, timeoutMs)
        },
      },
      sleep: async (ms) => { if (pasted && beforePress === 0) slept += ms },
    })
    expect(got).toMatchObject({ kind: 'started' })
    expect(got).not.toHaveProperty('imageSeen')
    expect(asked).toBe(1)
    expect(beforePress).toBeGreaterThanOrEqual(KLING_UPLOAD_MIN_MS)
  })

  it('★那一条判据单独算得清:只认 https、带我们文件名(地址里是 URL 编码)的那张', () => {
    expect(klingUploadedImage([LOGO, THUMB, UPLOADED], IMAGE_PATH)).toBe(true)
    expect(klingUploadedImage([LOGO, THUMB, PREVIEW], IMAGE_PATH)).toBe(false)
    expect(klingUploadedImage([LOGO, THUMB, OLD_UPLOADED], IMAGE_PATH)).toBe(false)
    expect(klingUploadedImage([], IMAGE_PATH)).toBe(false)
    // 地址里文件名没编码也认;坏编码不抛。
    expect(klingUploadedImage([{ ...UPLOADED, url: 'https://p4-fdl.klingai.com/bs2/upload/参考图-20261013-220351.png' }], IMAGE_PATH)).toBe(true)
    expect(klingUploadedImage([{ ...UPLOADED, url: 'https://x/%E5%8F%82%E8%80%83%E5%9B%BE-20261013-220351.png%' }], IMAGE_PATH)).toBe(true)
  })

  it('那几条判据单独算得清', () => {
    const before = klingPageLook([{ t: '创作中 45%' }, { t: '32%' }])
    // 齐了:首帧格填着 + 生成键带点数。
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_READY])).toBe('ready')
    // 生成键读得到、偏偏没点数 = 这一格还不齐。
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_BARE])).toBe('waiting')
    // 「视频生成」那个页签不是生成键(读不到那颗键就不当拦路)。
    expect(klingUploadVerdict(before, [FRAME_FILLED, { t: '视频生成' }])).toBe('ready')
    // 首帧格还空着 / 一行字都读不到。
    expect(klingUploadVerdict(before, [FRAME_EMPTY, KEY_READY])).toBe('waiting')
    expect(klingUploadVerdict(before, [])).toBe('unreadable')
    // 「上传中」那类字在就接着等。
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_READY, { t: '上传中' }])).toBe('waiting')
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_READY, { t: 'Uploading…' }])).toBe('waiting')
    // ★ 旧那条在跑的百分比(贴图之前就有)不算「这张图在传」;**多出来**一行光百分比的才算。
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_READY, { t: '57%' }])).toBe('ready')
    expect(klingUploadVerdict(before, [FRAME_FILLED, KEY_READY, { t: '57%' }, { t: '12%' }])).toBe('waiting')
  })

  /**
   * ★ 页面底部那条浮条(21:5x 演示机截图原字:「1/1 生成完成 回到顶部」)。
   * 按生成之前读一眼留底,交给等出片那一层 —— 它变了就是**又做完了一条**。
   */
  it('★「1/1 生成完成」那条浮条:按之前读一眼带回来', async () => {
    expect(klingDoneBar([{ t: '1/1 生成完成' }, { t: '回到顶部' }])).toBe('1/1 生成完成')
    expect(klingDoneBar([{ t: '2 / 2 生成完成' }])).toBe('2 / 2 生成完成')
    expect(klingDoneBar([{ t: '创作中' }])).toBeUndefined()
    const w = happy(undefined, ctx => [FRAME_FILLED, { t: PROMPT }, KEY_READY, { t: '1/1 生成完成' }, ...(ctx.pressed ? [WORKING] : [])])
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: PROMPT }, deps(w.helper)))
      .toMatchObject({ kind: 'started', doneBar: '1/1 生成完成' })
  })
})

describe('一条路没走完', () => {

  it('开着好几个标签页(导航那条「生成」有几处)→ failed:open,一下都不贴不写不按', async () => {
    const { helper, calls } = happy(req => (req.op === 'agent_press' && req.role === 'AXLink' ? { found: false, many: 3 } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got).toMatchObject({ kind: 'failed', step: 'open' })
    expect((got as { why: string }).why).toContain('只留一个标签页')
    expect(calls.some(one => ['paste_image', 'send_text'].includes(one.op))).toBe(false)
    expect(calls.filter(one => one.op === 'agent_press')).toHaveLength(1)
  })

  it('页签第一眼没找到(页面没画完 / 刚被藏)→ 放出来再看几眼,找到了接着走', async () => {
    let tabLooks = 0
    const { helper, calls } = happy(req => (req.op === 'agent_press' && req.role === 'AXGroup' && (tabLooks += 1) < 3 ? { found: false } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got.kind).toBe('started')
    expect(calls.filter(one => one.op === 'agent_press' && one.role === 'AXGroup')).toHaveLength(3)
  })

  it('页签一直找不到 → 看够几眼就停,不贴不写不按', async () => {
    const { helper, calls } = happy(req => (req.op === 'agent_press' && req.role === 'AXGroup' ? { found: false } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got).toMatchObject({ kind: 'failed', step: 'open' })
    expect(calls.filter(one => one.op === 'agent_press' && one.role === 'AXGroup')).toHaveLength(KLING_NAV_TRIES)
    expect(calls.some(one => one.op === 'paste_image' || one.op === 'send_text')).toBe(false)
  })

  it('两颗「生成」键 → 一颗都不点,如实说', async () => {
    const { helper, calls } = happy(req => (req.op === 'agent_press' && req.role === KLING_GENERATE_ROLE ? { found: false, many: 2 } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got).toMatchObject({ kind: 'failed', step: 'press' })
    expect(calls.filter(one => one.op === 'agent_press' && one.role === KLING_GENERATE_ROLE)).toHaveLength(1)
  })

  it('上一回的帧图删不干净 → failed:clear,不往尾帧里贴', async () => {
    const { helper, calls } = happy(req => (req.op === 'clear_frames' ? { deleted: 1, left: 1 } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got).toMatchObject({ kind: 'failed', step: 'clear' })
    expect(calls.some(one => one.op === 'paste_image' || one.op === 'send_text')).toBe(false)
  })

  it('一直等不到提示词框 → failed:load,不贴不写不按生成', async () => {
    const { helper, calls } = happy(req => (req.op === 'focus_input' ? { candidates: [], picked: { writable: false } } : undefined))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(helper))
    expect(got).toMatchObject({ kind: 'failed', step: 'load' })
    expect(calls.some(one => one.op === 'paste_image' || one.op === 'send_text' || (one.op === 'agent_press' && one.role === KLING_GENERATE_ROLE))).toBe(false)
  })

  it('打不开可灵 → failed:open;图贴不进 → failed:image;提示词写不进 → failed:prompt;都不按生成', async () => {
    const one = happy()
    const bad = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, { ...deps(one.helper), openApp: async () => { throw new Error('没装') } })
    expect(bad).toMatchObject({ kind: 'failed', step: 'open' })
    expect(one.calls).toHaveLength(0)

    const two = happy(req => (req.op === 'paste_image' ? { ok: false, error: '未知 op' } : undefined))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(two.helper))).toMatchObject({ kind: 'failed', step: 'image' })
    expect(two.calls.some(c => c.op === 'send_text' || (c.op === 'agent_press' && c.role === KLING_GENERATE_ROLE))).toBe(false)

    const three = happy(req => (req.op === 'send_text' ? { ok: false, error: '没找到输入框' } : undefined))
    expect(await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, deps(three.helper))).toMatchObject({ kind: 'failed', step: 'prompt' })
    expect(three.calls.some(c => c.op === 'agent_press' && c.role === KLING_GENERATE_ROLE)).toBe(false)
  })
})
