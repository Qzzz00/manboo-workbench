// @vitest-environment node
/**
 * **一件事两步接力:豆包出参考图 → 这张图进可灵生成**(2026-10-12,卡「演示 · 出图进可灵」)。
 * 第二步拿第一步的产物(落盘的那张图)当输入;进入生成就算完成,收卡前排一通带话的「办完了」。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskClientDispatch, TaskStatus, TaskView } from '../src/protocol.ts'
import type { CachedImage } from '../src/server/doubaoImage.ts'
import { KLING_NOT_TAKEN_WHY } from '../src/server/klingStep.ts'
import type { KlingOutcome } from '../src/server/klingStep.ts'
import type { VideoPlan } from '../src/server/videoChain.ts'
import {
  CHAIN_IMAGE_AFTER_REPLY_MS, CHAIN_IMAGE_STABLE_MS, CHAIN_IMAGE_WORKING_MS, CHAIN_IMAGE_WORKING_TEXT,
  CHAIN_KLING_LOG_MISSING_NOTE, CHAIN_KLING_QUEUED_NOTE, CHAIN_PUMP_MS,
  createVideoChain, promptWithDetail, referenceImagePath, subjectDirName,
  VIDEO_PROMPT_FIRST_FRAME, VIDEO_PROMPT_MOTION, videoChainPlan, videoPromptOf,
} from '../src/server/videoChain.ts'

describe('认「帮我做一个 XXX 的视频」', () => {
  it('摘出 XXX,写两句交代', () => {
    const plan = videoChainPlan('帮我做一个小猫在海边追浪花的视频')
    expect(plan?.subject).toBe('小猫在海边追浪花')
    expect(plan?.imageAsk).toContain('生成一张图片:小猫在海边追浪花')
    /*
     * ★ 2026-10-13 傍晚改口径(卡 J):**可灵那一句不重述画面**,只写运镜与变化。
     * 维护者核过:贴进首帧格的参考图没被当首帧(片子首帧与参考图不是同一画面),
     * 图生视频的提示词里再写一遍主体,等于让它按文字另画一遍。从此开头点明「以这张图为第一帧」。
     */
    expect(plan?.videoPrompt.startsWith(VIDEO_PROMPT_FIRST_FRAME)).toBe(true)
    expect(plan?.videoPrompt).not.toContain('小猫在海边追浪花')
    expect(videoChainPlan('给我生成一段关于秋天银杏大道的短视频')?.subject).toBe('秋天银杏大道')
    expect(videoChainPlan('做个「赛博朋克夜市」视频')?.subject).toBe('赛博朋克夜市')
  })

  /**
   * ★ **可灵那一句只写运镜与变化**(2026-10-13 傍晚,卡 J)。
   * 维护者核过:贴进首帧格的图没被当首帧、他那边智能分镜早就关了;第三方教程一致的建议是
   * 图生视频的提示词只写动作与运镜、不重述画面、开头用运镜词。所以模板里**一个主体字都没有**。
   */
  it('★可灵那一句点明以这张图为第一帧,不重述主体 / 场景', () => {
    const prompt = videoPromptOf()
    expect(prompt.startsWith('以这张图为第一帧')).toBe(true)
    expect(prompt).toContain('保持不变')
    expect(prompt).toContain('不换场景')
    // 模板里没有「主体是什么」那个空位 —— 两段固定的字,拼出来就是整句
    expect(prompt).toBe(`${VIDEO_PROMPT_FIRST_FRAME}${VIDEO_PROMPT_MOTION}`)
  })

  it('不是生成视频的不认', () => {
    expect(videoChainPlan('把昨天那条视频剪一下')).toBeUndefined()
    expect(videoChainPlan('帮我把视频发布到抖音')).toBeUndefined()
    expect(videoChainPlan('帮我查一下国庆放几天假')).toBeUndefined()
    expect(videoChainPlan('做个这个的视频')).toBeUndefined()
  })
})

/* ──────── 主题截断:2026-10-13 真机那两句(卡 B)──────── */

describe('主题别截断、别带口吃的引子', () => {
  it('★「…的视频在屋檐上面」:「视频」后面那一截并进主题(10-13 真机丢了「在屋檐上面」)', () => {
    const plan = videoChainPlan('帮我生成一个云南瓦猫的蹦蹦跳跳的视频在屋檐上面')
    expect(plan?.subject).toBe('云南瓦猫的蹦蹦跳跳在屋檐上面')
    /*
     * 并进主题 = 豆包那张参考图带着它(第一步按主体出图)。
     * ★ 可灵那一句**从此一个字都不提主体**(卡 J):首帧就是那张图,再写一遍是重述画面。
     */
    expect(plan?.imageAsk).toContain('在屋檐上面')
    expect(plan?.videoPrompt).toBe(videoPromptOf())
  })

  it('★口吃 / 重复的引子剥掉:「给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频」', () => {
    const plan = videoChainPlan('给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频')
    expect(plan?.subject).toBe('女孩子在树林下摘蘑菇')
    expect(subjectDirName(plan?.subject ?? '')).toBe('女孩子在树林下摘蘑菇')
  })

  it('★选题目录名不许以标点开头', () => {
    expect(subjectDirName('。给我生成一个女孩子')).toBe('给我生成一个女孩子')
    expect(subjectDirName('，小猫')).toBe('小猫')
  })

  it('语气词 / 客套不算主题的一部分', () => {
    expect(videoChainPlan('帮我做一个小猫在海边追浪花的视频,谢谢')?.subject).toBe('小猫在海边追浪花')
    expect(videoChainPlan('帮我做一个小猫在海边追浪花的视频吧')?.subject).toBe('小猫在海边追浪花')
  })

  it('主题里本来就有的动词不当引子剥(「小朋友做饭」还是「小朋友做饭」)', () => {
    expect(videoChainPlan('帮我做一个小朋友做饭的视频')?.subject).toBe('小朋友做饭')
  })
})

describe('参考图落在哪', () => {
  it('<工作目录>/选题/<XXX>/素材/参考图-<时刻>.<扩展名>', () => {
    const at = new Date(2026, 9, 14, 10, 5, 9)
    expect(referenceImagePath('/w', '小猫/海边', 'png', at)).toBe('/w/选题/小猫 海边/素材/参考图-20261014-100509.png')
  })
})

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'video-chain-'))
  let now = 1_000_000
  const task: TaskView = { id: 't-1', title: '帮我做一个小猫追浪花的视频', status: 'doing' } as TaskView
  const moves: TaskStatus[] = []
  const updates: Record<string, unknown>[] = []
  const written: Record<string, Buffer> = {}
  const announced: unknown[] = []
  const kling: { imagePath: string, prompt: string }[] = []
  let image: CachedImage | undefined
  let klingOut: KlingOutcome = { kind: 'started', how: 'ax_press', label: '生成' }
  const chain = createVideoChain({
    tasks: {
      list: async () => ({ tasks: [task] }),
      update: async (_id, patch) => {
        updates.push(patch)
        if (patch.clientDispatch !== undefined) task.client_dispatch = patch.clientDispatch as TaskClientDispatch
        return true
      },
      move: async (_id, status) => { moves.push(status); task.status = status; return true },
    },
    dispatch: async (_id, input) => {
      task.client_dispatch = { hand: 'window', family: input.family, status: 'sent', at: new Date(now).toISOString(), text: input.text, reply_state: 'waiting', marker: 'm' } as TaskClientDispatch
      return { ok: true, note: '已经送到 豆包办公 的窗口里' }
    },
    findImage: async since => (image !== undefined && image.mtimeMs >= since ? image : undefined),
    root: async () => '/w',
    fallbackRoot: '/fallback',
    writeFile: async (path, body) => { written[path] = body },
    kling: async (input) => { kling.push(input); return klingOut },
    announce: async (input) => { announced.push(input) },
    file: join(dir, 'chains.json'),
    now: () => now,
  })
  const img = (url: string): CachedImage => ({ url, mtimeMs: now, body: Buffer.from('PNG'), info: { mime: 'image/png', ext: 'png', width: 1920, height: 1080 } })
  return {
    chain, task, moves, updates, written, announced, kling, dir,
    tick: (ms = CHAIN_PUMP_MS) => { now += ms },
    showImage: (url: string) => { image = img(url) },
    setKling: (out: KlingOutcome) => { klingOut = out },
    reply: () => { task.client_dispatch = { ...task.client_dispatch, reply_state: 'done', reply_at: new Date(now).toISOString() } as TaskClientDispatch },
  }
}

describe('接力', () => {
  it('第一步派给豆包;它还有下一步时 owns 为真', async () => {
    const w = world()
    const plan = videoChainPlan('帮我做一个小猫追浪花的视频')
    if (plan === undefined) throw new Error('plan')
    const res = await w.chain.start('t-1', plan)
    expect(res.ok).toBe(true)
    expect(res.note).toContain('分两步办')
    expect(w.task.client_dispatch?.family).toBe('doubao')
    expect(w.task.client_dispatch?.text).toContain('生成一张图片')
    expect(w.chain.owns('t-1')).toBe(true)
  })

  it('图出来、稳住了 → 落进选题文件夹 → 交给可灵(拿的是落盘那张)→ 先排一通带话的、再挪「等你确认」', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick()
    await w.chain.pump()
    expect(w.kling).toHaveLength(0)

    w.tick()
    w.showImage('https://p9.byteimg.com/rc_gen_image/a.png')
    await w.chain.pump()
    expect(w.kling).toHaveLength(0) // 第一眼看到,还没稳住
    w.tick(CHAIN_IMAGE_STABLE_MS)
    await w.chain.pump()

    const saved = Object.keys(w.written)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^\/w\/选题\/小猫追浪花\/素材\/参考图-\d{8}-\d{6}\.png$/)
    // ★ 卡 J 改口径:交给可灵的那一句以首帧为准、不重述主体(从前钉的是「小猫追浪花。」开头)
    expect(w.kling).toEqual([{ imagePath: saved[0], prompt: videoPromptOf() }])
    expect(w.task.client_dispatch?.reply_state).toBe('done') // 盯窗那条不再读豆包
    expect(w.updates.some(one => JSON.stringify(one.deliverables ?? []).includes(saved[0] as string))).toBe(true)
    expect(w.announced).toEqual([{ item_id: 't-1', title: '小猫追浪花的视频', note: expect.stringContaining('已经在可灵里开始生成了'), reason: 'confirm' }])
    expect(w.moves).toEqual(['confirm'])
    expect(w.chain.owns('t-1')).toBe(false)
    expect(JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains[0].stage).toBe('done')
  })

  it('可灵框里原来那段字被盖掉了 → 原文挂在卡上,不进那一通电话', async () => {
    const w = world()
    w.setKling({ kind: 'started', how: 'ax_press', label: '生成', replaced: '她上回写的那句' })
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick(); w.reply(); w.showImage('https://x/rc_gen_image/a.png')
    await w.chain.pump()
    expect(JSON.stringify(w.updates)).toContain('原文:她上回写的那句')
    expect(JSON.stringify(w.announced)).not.toContain('她上回写的那句')
  })

  it('豆包已经说完了,图一出现就接着走(不用再等稳住)', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick()
    w.reply()
    w.showImage('https://p9.byteimg.com/rc_gen_image/a.png')
    await w.chain.pump()
    expect(w.kling).toHaveLength(1)
  })

  /**
   * ★ **「按了但没看到它开始生成」那一档(`pressed`)2026-10-13 晚取消了**(卡 O)。
   *
   * 卡 D 留的那条待拍板:那一档照旧收卡、挪「等你确认」,而来电 `confirm` 的开场是定死的
   * 「老板,X 办完了,等你验收」。10-13 两次真机(本机 17:22、演示机 20:31)都是这么把
   * 「可灵没接单」说成了「已经开始生成了」。现在没接单就是 `failed`:挪阻塞、说实话。
   */
  it('★可灵没接下这一单 → 挂阻塞、原因在前,不说成已经开始生成', async () => {
    const w = world()
    w.setKling({ kind: 'failed', step: 'press', why: KLING_NOT_TAKEN_WHY })
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick(); w.reply(); w.showImage('https://x/rc_gen_image/a.png')
    await w.chain.pump()
    expect(w.moves).toEqual(['blocked'])
    expect(JSON.stringify(w.updates)).not.toContain('已经在可灵里开始生成了')
    const note = w.updates.map(one => one.note).filter((one): one is string => typeof one === 'string').at(-1) as string
    // 原因在前(工人只念第一个分号之前那半句),参考图在哪跟在后面。
    expect(note.startsWith(KLING_NOT_TAKEN_WHY)).toBe(true)
    expect(note).toContain('参考图在选题「小猫追浪花」的素材文件夹里')
  })

  it('可灵没成 → 挂阻塞,参考图在哪照样说', async () => {
    const v = world()
    v.setKling({ kind: 'failed', step: 'press', why: '可灵窗口里没找到「生成」那颗键' })
    await v.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    v.tick(); v.reply(); v.showImage('https://x/rc_gen_image/a.png')
    await v.chain.pump()
    expect(v.moves).toEqual(['blocked'])
    expect(v.announced).toEqual([])
    // 原因在前、文件夹在后:工人 `plainFailureWhy` 只念第一个分号之前那半句(10-13 真机念成了「参考图在…文件夹里」)。
    const noted = JSON.stringify(v.updates)
    expect(noted).toContain('参考图在选题「小猫追浪花」的素材文件夹里')
    expect(noted.indexOf('可灵窗口里没找到「生成」那颗键')).toBeGreaterThan(-1)
    expect(noted.indexOf('可灵窗口里没找到「生成」那颗键')).toBeLessThan(noted.indexOf('参考图在选题「小猫追浪花」的素材文件夹里'))
  })

  it('豆包说完一分钟还没在缓存里看到图 → 如实说取不到,不截屏凑', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick(); w.reply()
    await w.chain.pump()
    w.tick(CHAIN_IMAGE_AFTER_REPLY_MS + 1)
    await w.chain.pump()
    expect(w.kling).toHaveLength(0)
    expect(w.moves).toEqual(['blocked'])
    expect(JSON.stringify(w.updates)).toContain('没找到这一轮出的图')
  })

  it('她把卡取消了 → 接力停下,一下都不再动', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.task.status = 'canceled'
    w.tick(); w.showImage('https://x/rc_gen_image/a.png'); w.reply()
    await w.chain.pump()
    expect(w.kling).toHaveLength(0)
    expect(w.chain.owns('t-1')).toBe(false)
  })

  /** 出片之后那一段:片子取回来了没有、推手机成不成,按情形摆。 */
  function videoWorld(script: {
    video?: { kind: 'ready', path: string, log_missing?: boolean } | { kind: 'failed', why: string, log_missing?: boolean }
    push?: { ok: boolean, note: string }
    /** 按生成之前结果列里有几条做完的卡(等出片那一层拿它当底;卡 O)。 */
    cards?: number
    /** ★ 可灵那一步没看出图传完(卡 Q):卡上要留一句,念的那一句里不许有它。 */
    imageWait?: string
    /** ★ 按生成之前底部那条浮条(卡 Q):交给等出片那一层当底。 */
    doneBar?: string
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'video-chain-v-'))
    let now = 1_000_000
    const task: TaskView = { id: 't-2', title: '生成花海中的大叔漫步的视频', status: 'doing' } as TaskView
    const notes: string[] = []
    const order: string[] = []
    const calls: { note?: string, reason?: string, title?: string }[] = []
    let image: CachedImage | undefined
    const chain = createVideoChain({
      tasks: {
        list: async () => ({ tasks: [task] }),
        update: async (_id, patch) => {
          if (typeof patch.note === 'string') notes.push(patch.note)
          if (patch.deliverables !== undefined) task.deliverables = patch.deliverables as NonNullable<TaskView['deliverables']>
          if (patch.clientDispatch !== undefined) task.client_dispatch = patch.clientDispatch as TaskClientDispatch
          return true
        },
        move: async (_id, status) => { order.push(`move:${status}`); task.status = status; return true },
      },
      dispatch: async () => {
        task.client_dispatch = { hand: 'window', family: 'doubao', status: 'sent', at: new Date(now).toISOString(), text: 'x', reply_state: 'waiting', marker: 'm' } as TaskClientDispatch
        return { ok: true, note: 'ok' }
      },
      findImage: async () => image,
      root: async () => '/w',
      fallbackRoot: '/f',
      writeFile: async () => {},
      kling: async () => ({
        kind: 'started',
        how: 'ax_press',
        label: '生成',
        ...(script.cards === undefined ? {} : { cards: script.cards }),
        ...(script.imageWait === undefined ? {} : { imageWait: script.imageWait }),
        ...(script.doneBar === undefined ? {} : { doneBar: script.doneBar }),
      }),
      fetchVideo: async (input) => { order.push(`fetch:${input.cardsBefore ?? '-'}:${input.doneBarBefore ?? '-'}`); return script.video ?? { kind: 'ready', path: '/Users/x/Downloads/kling_a.mp4' } },
      copyFile: async (from, to) => { order.push(`copy:${from}->${to}`) },
      pushToPhone: async (input) => { order.push(`push:${input.path}`); return script.push ?? { ok: true, note: '卡推过去了' } },
      announce: async (input) => { order.push(`call:${input.note}`); calls.push(input) },
      file: join(dir, 'chains.json'),
      now: () => now,
    })
    return {
      chain, task, notes, order, calls, dir,
      async go() {
        await chain.start('t-2', videoChainPlan('生成花海中的大叔漫步的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
        now += CHAIN_PUMP_MS
        task.client_dispatch = { ...task.client_dispatch, reply_state: 'done', reply_at: new Date(now).toISOString() } as TaskClientDispatch
        image = { url: 'https://x/rc_gen_image/a.png', mtimeMs: now, body: Buffer.from('PNG'), info: { mime: 'image/png', ext: 'png', width: 1920, height: 1080 } }
        await chain.pump()
      },
    }
  }

  it('★出片之后:等片子 → 复制进选题素材文件夹 → 推到手机 → 才打那一通(进入生成时不打)', async () => {
    const w = videoWorld()
    await w.go()
    expect(w.notes.some(n => n.includes('出片了我推到你手机上,再打给你'))).toBe(true)
    const copy = w.order.find(one => one.startsWith('copy:')) as string
    expect(copy).toMatch(/^copy:\/Users\/x\/Downloads\/kling_a\.mp4->\/w\/选题\/花海中的大叔漫步\/素材\/视频-\d{8}-\d{6}\.mp4$/)
    const pushed = w.order.find(one => one.startsWith('push:')) as string
    expect(pushed).toBe(`push:${copy.split('->')[1]}`)
    // 顺序:等片子 → 复制 → 推 → 打电话 → 挪卡;只打一通。
    expect(w.order.map(one => one.split(':')[0])).toEqual(['fetch', 'copy', 'push', 'call', 'move'])
    expect(JSON.stringify(w.task.deliverables)).toContain('视频-')
    // ★ 办成了才走「等你确认」那一档(来电开场:办完了,等你验收)。
    expect(w.calls).toEqual([{ item_id: 't-2', title: '花海中的大叔漫步的视频', note: '视频好了,已经推到你手机上', reason: 'confirm' }])
    // ★ 给工人念的那一句短:没有「接起来就能看」、没有第二层书名号;细节留在卡上。
    expect(w.calls[0]?.note).not.toContain('接起来就能看')
    expect(w.calls[0]?.note).not.toContain('选题')
    expect(w.notes.at(-1)).toBe('视频好了,已经推到你手机上;存在选题「花海中的大叔漫步」的素材文件夹里')
  })

  it('★下载那一下没按成 → 不许走「办完了,等你验收」那一档:来电走「没成」、卡挂阻塞、note 如实', async () => {
    const w = videoWorld({ video: { kind: 'failed', why: '片子做好了,下载那一下没按成 —— 你在可灵里点一下' } })
    await w.go()
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.reason).toBe('failed')
    expect(w.calls[0]?.note).toContain('下载那一下没按成')
    expect(w.order.filter(one => one.startsWith('move:'))).toEqual(['move:blocked'])
    expect(w.task.status).toBe('blocked')
    expect(w.notes.at(-1)).toContain('下载那一下没按成')
    expect(JSON.stringify(w.notes)).not.toContain('已经推到你手机上')
    // 没推手机(片子压根没拿到)。
    expect(w.order.some(one => one.startsWith('push:'))).toBe(false)
  })

  it('★片子好了但没推到手机 → 同样不说办完了(来电走「没成」那一档),卡上写清片子在哪', async () => {
    const w = videoWorld({ push: { ok: false, note: '手机这会儿没连上' } })
    await w.go()
    expect(w.calls[0]?.reason).toBe('failed')
    expect(w.calls[0]?.note).toBe('视频好了,没推到你手机上')
    expect(w.order.filter(one => one.startsWith('move:'))).toEqual(['move:blocked'])
    expect(w.notes.at(-1)).toContain('存在选题「花海中的大叔漫步」的素材文件夹里')
    expect(w.notes.at(-1)).toContain('手机这会儿没连上')
  })

  /**
   * ★ **按生成之前那一眼的条数要交到等出片那一层**(2026-10-13 晚,卡 O):
   * 结果列里本来就躺着她从前那些片子,「有一条做完的卡」在任何时候都成立 —— 多出一条才是这一单。
   */
  it('★按生成之前结果列里几条卡,交给等出片那一层当底', async () => {
    const w = videoWorld({ cards: 3 })
    await w.go()
    expect(w.order.find(one => one.startsWith('fetch:'))).toBe('fetch:3:-')
  })

  /** ★ 卡 Q:按生成之前那条浮条也交下去 —— 它变了就是又做完一条(「1/1」→「2/2」)。 */
  it('★按生成之前底部那条浮条,也交给等出片那一层当底', async () => {
    const w = videoWorld({ cards: 1, doneBar: '1/1 生成完成' })
    await w.go()
    expect(w.order.find(one => one.startsWith('fetch:'))).toBe('fetch:1:1/1 生成完成')
  })

  /**
   * ★ **没看出图传完就按了生成**(2026-10-13 晚,卡 Q):这件事要写在卡上(事后对账看得见),
   * 但**不进念的那一句** —— 来电开场 42 字留给最要紧的事(与 `log_missing` 同一个取舍)。
   */
  it('★「图可能没传完」上卡、不进念的那一句', async () => {
    const w = videoWorld({ cards: 0, imageWait: '图可能没传完' })
    await w.go()
    expect(w.notes.some(one => one.includes('图可能没传完'))).toBe(true)
    expect(JSON.stringify(w.calls)).not.toContain('图可能没传完')
    expect(JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains[0].kling_image_wait).toBe('图可能没传完')
  })

  it('★可灵那份日志一次都读不到 → 卡上补一句,念的那一句里没有它', async () => {
    const w = videoWorld({ cards: 0, video: { kind: 'ready', path: '/Users/x/Downloads/kling_a.mp4', log_missing: true } })
    await w.go()
    expect(w.notes.at(-1)).toContain(CHAIN_KLING_LOG_MISSING_NOTE)
    expect(w.calls[0]?.reason).toBe('confirm')
    expect(w.calls[0]?.note).not.toContain(CHAIN_KLING_LOG_MISSING_NOTE)

    const v = videoWorld({ video: { kind: 'failed', why: '片子做好了,下载那一下没按成 —— 你在可灵里点一下', log_missing: true } })
    await v.go()
    expect(v.notes.at(-1)).toContain(CHAIN_KLING_LOG_MISSING_NOTE)
    expect(v.calls[0]?.note).not.toContain(CHAIN_KLING_LOG_MISSING_NOTE)
  })

  it('来电标题不带书名号(来电那一句自己会加「」)', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick(); w.reply(); w.showImage('https://x/rc_gen_image/a.png')
    await w.chain.pump()
    expect((w.announced[0] as { title: string }).title).toBe('小猫追浪花的视频')
  })
})

/* ──────── 她补的那一句并进提示词:2026-10-13 真机 14:02(卡 G)──────── */

describe('补细节并进可灵那句提示词', () => {
  /**
   * ★ 2026-10-13 傍晚改口径(卡 J):插的位置从「主体那一句之后」改成「**首帧那一句之后**」——
   * 模板里已经没有主体那一句了。老记录(改口径之前落盘的那几份接力)照旧按主体那一句插。
   */
  it('插在首帧那一句之后、运镜之前;原话不改写', () => {
    expect(promptWithDetail({ prompt: videoPromptOf(), subject: '女孩子在树林下摘蘑菇', said: '七八岁吧,穿小碎花连衣裙。' }))
      .toBe(`${VIDEO_PROMPT_FIRST_FRAME}七八岁吧,穿小碎花连衣裙。${VIDEO_PROMPT_MOTION}`)
    // 老记录(提示词以主体那一句开头)照旧插在主体之后
    const old = promptWithDetail({ prompt: '小猫。镜头推进。', subject: '小猫', said: '穿小碎花' })
    expect(old).toBe('小猫。穿小碎花。镜头推进。')
    // 同一句补第二遍不接第二份;认不出前面那一句(她自己改过提示词)就接在末尾。
    expect(promptWithDetail({ prompt: old, subject: '小猫', said: '穿小碎花。' })).toBe(old)
    expect(promptWithDetail({ prompt: '随手写的一段词', subject: '小猫', said: '穿小碎花' })).toBe('随手写的一段词穿小碎花。')
  })

  it('★她补的那一句照旧在运镜之前,整句仍以「以这张图为第一帧」开头', () => {
    const prompt = promptWithDetail({ prompt: videoPromptOf(), subject: '小猫追浪花', said: '要黑猫,逆光' })
    expect(prompt.startsWith(VIDEO_PROMPT_FIRST_FRAME)).toBe(true)
    expect(prompt.indexOf('要黑猫,逆光')).toBeLessThan(prompt.indexOf(VIDEO_PROMPT_MOTION))
  })

  it('★豆包那一步还在走:并进去、落盘;可灵已经拿到提示词之后一个字不动', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    // ★ 卡 J 改口径:插在首帧那一句之后(从前是主体那一句之后)
    expect(await w.chain.amendPrompt('t-1', '要黑猫,逆光')).toEqual({ kind: 'added', prompt: `${VIDEO_PROMPT_FIRST_FRAME}要黑猫,逆光。${VIDEO_PROMPT_MOTION}` })
    expect(JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains[0].video_prompt).toContain('要黑猫,逆光。')

    // 走到可灵那一步:提示词已经交出去了(这一句带着细节),之后再补的那一句改不动它。
    w.tick(); w.reply(); w.showImage('https://x/rc_gen_image/a.png')
    await w.chain.pump()
    expect(w.kling[0]?.prompt).toContain('要黑猫,逆光。')
    const late = await w.chain.amendPrompt('t-1', '再加一句:毛要长')
    expect(late).toEqual({ kind: 'late', stage: 'done' })
    expect(JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains[0].video_prompt).not.toContain('毛要长')
  })

  /**
   * ★ **并进去的那一句也过补细节那道判**(2026-10-13 晚,卡 P)。
   *
   * 演示机 20:30 那一通:一句切待办的话被 ASR 切成两段、都落在做视频那件事的窗口里 ——
   * 两段都并进了提示词,可灵拿到的那段词里夹着「帮我把待办的组件改为。的形式。」。
   * 判据与 8791 那一道**同一个纯函数**(`followUp.ts` 的 `looksLikeAppendDetail`)。
   */
  it('★不像描述的那一句不并进提示词(吩咐句 / 太短 / 话没说完 / 别的那件事)', () => {
    const base = videoPromptOf()
    for (const said of ['帮我把待办的组件改为。', '的形式。', '把它改成', '待办改回列表', '嗯']) {
      expect(promptWithDetail({ prompt: base, subject: '小猫追浪花', said })).toBe(base)
    }
    // 真的细节照旧并得进去
    expect(promptWithDetail({ prompt: base, subject: '小猫追浪花', said: '要黑猫,逆光' })).not.toBe(base)
  })

  it('★接力里也不并:回 not_detail(调用方据此只说记在卡上)', async () => {
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    expect(await w.chain.amendPrompt('t-1', '帮我把待办的组件改为。')).toEqual({ kind: 'not_detail' })
    expect(JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains[0].video_prompt).not.toContain('待办')
  })

  it('这张卡不在接力里 → none(调用方据此只说记在卡上)', async () => {
    const w = world()
    expect(await w.chain.amendPrompt('t-9', '穿小碎花')).toEqual({ kind: 'none' })
  })
})

/* ──────── 两条链不互相卡死:2026-10-13 17:22–17:28 真机(卡 M)──────── */

/**
 * 真机那两条:17:22:08「小猫穿道士服」进了可灵、在 `waitKlingVideo` 里等(最长 20 + 2 分钟);
 * 17:23:43「街头霸王春丽」起 → 豆包 17:24:03 回话、17:24:15 图进了缓存,
 * 可**那一拍的 `step` 一次都没跑到** —— `pump()` 是顺序的,第一条没回来第二条就没人管。
 * 维护者看到的是「春丽卡住了,没能跳转到可灵」。
 */
function twoChains() {
  const dir = mkdtempSync(join(tmpdir(), 'video-chain-two-'))
  let now = 1_000_000
  const subjects: Record<string, string> = { 't-cat': '小猫穿道士服', 't-chun': '街头霸王春丽' }
  const cards: TaskView[] = [
    { id: 't-cat', title: '帮我做一个小猫穿道士服的视频', status: 'doing' } as TaskView,
    { id: 't-chun', title: '帮我做一个街头霸王春丽的视频', status: 'doing' } as TaskView,
  ]
  const notes: { item: string, note: string }[] = []
  const moves: { item: string, status: TaskStatus }[] = []
  const announced: { item_id: string, note: string, reason: string }[] = []
  const traces: { item_id: string, title: string, text: string }[] = []
  const written: string[] = []
  const inKling: string[] = []
  const gates = new Map<string, (out: KlingOutcome) => void>()
  let finds = 0
  let holdFind = false
  let letFind: (() => void) | undefined
  let finder: () => CachedImage | undefined = () => undefined
  const chain = createVideoChain({
    tasks: {
      list: async () => ({ tasks: cards }),
      update: async (id, patch) => {
        if (typeof patch.note === 'string') notes.push({ item: id, note: patch.note })
        const card = cards.find(one => one.id === id)
        if (card !== undefined && patch.clientDispatch !== undefined) card.client_dispatch = patch.clientDispatch as TaskClientDispatch
        return true
      },
      move: async (id, status) => {
        moves.push({ item: id, status })
        const card = cards.find(one => one.id === id)
        if (card !== undefined) card.status = status
        return true
      },
    },
    dispatch: async (id, input) => {
      const card = cards.find(one => one.id === id) as TaskView
      card.client_dispatch = { hand: 'window', family: input.family, status: 'sent', at: new Date(now).toISOString(), text: input.text, reply_state: 'waiting', marker: 'm' } as TaskClientDispatch
      return { ok: true, note: '已经送到 豆包办公 的窗口里' }
    },
    findImage: async () => {
      finds += 1
      if (holdFind) await new Promise<void>((resolve) => { letFind = resolve })
      return finder()
    },
    root: async () => '/w',
    fallbackRoot: '/f',
    writeFile: async (path) => { written.push(path) },
    // 可灵那一步由测试掐着放:第一条进去就不出来(真机上它在里头等了 20 分钟)。
    kling: async (input) => {
      const item = Object.keys(subjects).find(one => input.imagePath.includes(subjects[one] as string)) as string
      inKling.push(item)
      return await new Promise<KlingOutcome>((resolve) => { gates.set(item, resolve) })
    },
    announce: async (input) => { announced.push(input as { item_id: string, note: string, reason: string }) },
    trace: (input) => { traces.push(input) },
    file: join(dir, 'chains.json'),
    now: () => now,
  })
  return {
    chain, cards, notes, moves, announced, traces, written, inKling, dir,
    tick: (ms = CHAIN_PUMP_MS) => { now += ms },
    finds: () => finds,
    queued: () => gates.size,
    showImage: (url: string) => {
      finder = () => ({ url, mtimeMs: now, body: Buffer.from('PNG'), info: { mime: 'image/png', ext: 'png', width: 1920, height: 1080 } })
    },
    noImage: () => { finder = () => undefined },
    holdFind: () => { holdFind = true },
    releaseFind: () => { holdFind = false; letFind?.() },
    reply: (id: string, text = '图片已生成') => {
      const card = cards.find(one => one.id === id) as TaskView
      card.client_dispatch = { ...card.client_dispatch, reply_state: 'done', reply_at: new Date(now).toISOString(), reply: text } as TaskClientDispatch
    },
    /** 可灵那一步放它走(默认:进了生成)。 */
    finish: (item: string, out: KlingOutcome = { kind: 'started', how: 'ax_press', label: '生成', seen: '创作中,预计等待 1 分钟' }) => {
      (gates.get(item) as (one: KlingOutcome) => void)(out)
      gates.delete(item)
    },
    start: async (id: string) => await chain.start(id, videoChainPlan((cards.find(one => one.id === id) as TaskView).title) as VideoPlan),
    noteOf: (id: string) => notes.filter(one => one.item === id).map(one => one.note),
  }
}

/** 等一件真发生(两条链各自在走,拍子不由测试掐)。 */
async function until(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (what()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}

describe('★两条链不互相等', () => {
  it('第一条在可灵里等着 → 第二条照样取图、落图,排在可灵那一步外面', async () => {
    const w = twoChains()
    await w.start('t-cat')
    w.tick(); w.reply('t-cat'); w.showImage('https://x/rc_gen_image/cat.png')
    const first = w.chain.pump()
    await until(() => w.inKling.includes('t-cat'), '第一条进可灵')

    // 第二条这会儿才起(真机 17:23:43),第一条还在可灵里 —— `start` 一点都不等它。
    await w.start('t-chun')
    w.tick(); w.reply('t-chun'); w.showImage('https://x/rc_gen_image/chun.png')
    const second = w.chain.pump()
    await until(() => w.noteOf('t-chun').some(one => one.includes(CHAIN_KLING_QUEUED_NOTE)), '第二条排上了')

    // 第二条的图落了盘、挂上了卡;可灵那一步还没碰(页面只有一个,排着)。
    expect(w.written.some(one => one.includes('街头霸王春丽'))).toBe(true)
    expect(w.inKling).toEqual(['t-cat'])
    // 排队不是失败:不打电话、卡不挪阻塞。
    expect(w.announced).toEqual([])
    expect(w.moves).toEqual([])
    // 这句话也给她听见(回答账那一本,不推通知、不响铃)。
    expect(w.traces).toEqual([{ item_id: 't-chun', title: '街头霸王春丽的视频', text: CHAIN_KLING_QUEUED_NOTE }])

    w.finish('t-cat')
    await until(() => w.inKling.length === 2, '轮到第二条')
    expect(w.inKling).toEqual(['t-cat', 't-chun'])
    w.finish('t-chun')
    await first
    await second
    expect(w.moves).toEqual([{ item: 't-cat', status: 'confirm' }, { item: 't-chun', status: 'confirm' }])
    expect(w.announced.map(one => one.item_id)).toEqual(['t-cat', 't-chun'])
    const saved = JSON.parse(readFileSync(join(w.dir, 'chains.json'), 'utf8')).chains as { item: string, stage: string, queued_at?: number, kling_how?: string, kling_started_text?: string }[]
    expect(saved.map(one => one.stage)).toEqual(['done', 'done'])
    // 轮到它那一下「排着」那一格就去掉了(重启后那句话据此分「排着」与「真按过」)。
    expect(saved[1]?.queued_at).toBeUndefined()
    // 按生成那一下的读数留在记录里(「判成 started 的是哪一行字」—— 17:22 那条就卡在这儿)。
    expect(saved[0]?.kling_how).toBe('ax_press')
    expect(saved[0]?.kling_started_text).toBe('创作中,预计等待 1 分钟')
  })

  it('第一条在可灵里等着 → 第二条豆包只回了文字没出图,照旧一分钟后如实说', async () => {
    const w = twoChains()
    await w.start('t-cat')
    w.tick(); w.reply('t-cat'); w.showImage('https://x/rc_gen_image/cat.png')
    const first = w.chain.pump()
    await until(() => w.inKling.includes('t-cat'), '第一条进可灵')

    await w.start('t-chun')
    w.noImage()
    w.tick(); w.reply('t-chun', '参考造型已锁定,你看看还要不要改')
    await w.chain.pump()
    w.tick(CHAIN_IMAGE_AFTER_REPLY_MS + 1)
    await w.chain.pump()
    expect(w.moves).toEqual([{ item: 't-chun', status: 'blocked' }])
    expect(w.noteOf('t-chun').join('')).toContain('没找到这一轮出的图')
    // 第一条照旧在可灵里等着,没被带下水。
    expect(w.inKling).toEqual(['t-cat'])
    w.finish('t-cat')
    await first
  })

  it('同一条链不重入:上一拍还在取图,这一拍跳过它', async () => {
    const w = twoChains()
    await w.start('t-cat')
    w.tick()
    w.holdFind()
    const first = w.chain.pump()
    await until(() => w.finds() === 1, '取图那一下开始了')
    w.tick()
    await w.chain.pump()
    w.tick()
    await w.chain.pump()
    expect(w.finds()).toBe(1)
    w.releaseFind()
    await first
  })

  it('重启时还排着队的那一条:如实说一下都没按(不叫她白跑去可灵里看)', async () => {
    const w = twoChains()
    writeFileSync(join(w.dir, 'chains.json'), JSON.stringify({
      chains: [
        { item: 't-cat', subject: '小猫穿道士服', video_prompt: 'p', stage: 'video', since: 1 },
        { item: 't-chun', subject: '街头霸王春丽', video_prompt: 'p', stage: 'kling', since: 2, queued_at: 3 },
      ],
    }))
    await w.chain.load()
    const notes = w.chain.view().map(one => one.note ?? '')
    expect(w.chain.view().map(one => one.stage)).toEqual(['failed', 'failed'])
    expect(notes[0]).toContain('要你到可灵里看一眼')
    expect(notes[1]).toContain('一下都没按')
  })

  it('排着的那一条她取消了 → 轮到它时一下都不碰可灵', async () => {
    const w = twoChains()
    await w.start('t-cat')
    w.tick(); w.reply('t-cat'); w.showImage('https://x/rc_gen_image/cat.png')
    const first = w.chain.pump()
    await until(() => w.inKling.includes('t-cat'), '第一条进可灵')
    await w.start('t-chun')
    w.tick(); w.reply('t-chun'); w.showImage('https://x/rc_gen_image/chun.png')
    const second = w.chain.pump()
    await until(() => w.noteOf('t-chun').some(one => one.includes(CHAIN_KLING_QUEUED_NOTE)), '第二条排上了')

    ;(w.cards.find(one => one.id === 't-chun') as TaskView).status = 'canceled'
    w.finish('t-cat')
    await first
    await second
    expect(w.inKling).toEqual(['t-cat'])
    expect(w.announced.map(one => one.item_id)).toEqual(['t-cat'])
    expect(w.chain.owns('t-chun')).toBe(false)
  })
})

describe('★豆包先回一句话、图晚十几秒才到', () => {
  it('回话里还说着「正在生成图片」→ 取图窗口延到三分钟,图晚到照样走', async () => {
    const w = twoChains()
    await w.start('t-chun')
    w.noImage()
    w.tick()
    // 真机 17:24:03 回话(末尾带「正在生成图片」),17:24:15 图才进缓存。
    w.reply('t-chun', '参考造型已锁定,正在生成图片')
    await w.chain.pump()
    w.tick(CHAIN_IMAGE_AFTER_REPLY_MS + 1)
    await w.chain.pump()
    expect(w.moves).toEqual([])
    w.showImage('https://x/rc_gen_image/chun.png')
    w.tick()
    const run = w.chain.pump()
    await until(() => w.inKling.includes('t-chun'), '图到了接着走')
    w.finish('t-chun')
    await run
    expect(w.moves).toEqual([{ item: 't-chun', status: 'confirm' }])
  })

  /**
   * ★ **新版豆包的进度行**(2026-10-13 晚演示机 20:55,豆包 2.1 Lite;卡 Q)。
   *
   * 那一单 `reply` 是「调用工具生成图片本地电脑项目豆包 2.1 Lite中」——「调用工具生成图片…中」
   * 就是它的进度行(正在出图),界面那几截由 `dispatchReply.ts` 剔掉之后剩「调用工具生成图片」。
   * 老词表只认「正在生成图片」那几句,于是这一单按 60 秒窗口判了「没找到这一轮出的图」。
   */
  it('★新版豆包的「调用工具生成图片」也算它还在出图 → 取图窗口照样延到三分钟', async () => {
    const w = twoChains()
    await w.start('t-chun')
    w.noImage()
    w.tick()
    w.reply('t-chun', '调用工具生成图片')
    await w.chain.pump()
    w.tick(CHAIN_IMAGE_AFTER_REPLY_MS + 1)
    await w.chain.pump()
    expect(w.moves).toEqual([])
    w.showImage('https://x/rc_gen_image/chun.png')
    w.tick()
    const run = w.chain.pump()
    await until(() => w.inKling.includes('t-chun'), '图到了接着走')
    w.finish('t-chun')
    await run
    expect(w.moves).toEqual([{ item: 't-chun', status: 'confirm' }])
  })

  it('★「生成图片中」这类写法也认(别逐字死抄一句)', async () => {
    for (const said of ['生成图片中…', '正在调用工具为你生成图像', '图片生成中']) {
      const w = twoChains()
      await w.start('t-chun')
      w.noImage()
      w.tick()
      w.reply('t-chun', said)
      await w.chain.pump()
      w.tick(CHAIN_IMAGE_AFTER_REPLY_MS + 1)
      await w.chain.pump()
      expect(w.moves, said).toEqual([])
    }
  })

  it('说着「正在生成图片」也有上限:三分钟还没图就如实说', async () => {
    const w = twoChains()
    await w.start('t-chun')
    w.noImage()
    w.tick()
    w.reply('t-chun', '正在生成图片')
    await w.chain.pump()
    w.tick(CHAIN_IMAGE_WORKING_MS + 1)
    await w.chain.pump()
    expect(w.moves).toEqual([{ item: 't-chun', status: 'blocked' }])
    expect(w.noteOf('t-chun').join('')).toContain('没找到这一轮出的图')
  })
})

/* ──────── 新版豆包把进度行当回话:2026-10-14 14:11 演示机(卡 AF)──────── */

/**
 * ★ 演示机那一单记下的回话原文是「查阅图像生成相关规则本地电脑项目按需确认技能插件」—— 新版豆包画之前先查规则,
 * 这一行(加上泄进来的页签字)被当成回话、`reply_state` 判了 done,而「还在出图」的词表一条都没命中,
 * 于是只给了 60 秒;早上两次成功的图分别在派出后 53 / 69 秒进缓存,这一单 87 秒还没来,窗口就关了。
 * 两处:① 这一行也算「还在出图」;② 回完话之后的窗口 60 秒 → 3 分钟(「回完话」在新版豆包上不可靠,别拿 60 秒赌它)。
 */
describe('★新版豆包把进度行当回话(2026-10-14 14:11 演示机,卡 AF)', () => {
  it('「查阅图像生成相关规则…」这一行算「还在出图」', () => {
    expect(CHAIN_IMAGE_WORKING_TEXT.test('查阅图像生成相关规则本地电脑项目按需确认技能插件')).toBe(true)
    expect(CHAIN_IMAGE_WORKING_TEXT.test('调用工具生成图片本地电脑项目豆包 2.1 Lite中')).toBe(true)
    expect(CHAIN_IMAGE_WORKING_TEXT.test('这是一只小黄鸭,祝你今天愉快。')).toBe(false)
  })

  it('回完话(词表没命中)之后 90 秒还没图 → 不判失败;两分钟时图来了 → 照常交给可灵', async () => {
    expect(CHAIN_IMAGE_AFTER_REPLY_MS).toBe(3 * 60_000)
    const w = world()
    await w.chain.start('t-1', videoChainPlan('帮我做一个小猫追浪花的视频') as NonNullable<ReturnType<typeof videoChainPlan>>)
    w.tick(); w.reply()
    await w.chain.pump()
    w.tick(90_000)
    await w.chain.pump()
    expect(w.moves).not.toContain('blocked')
    expect(w.kling).toHaveLength(0)
    w.tick(30_000); w.showImage('https://p9.byteimg.com/rc_gen_image/a.png')
    await w.chain.pump()
    expect(w.kling).toHaveLength(1)
  })
})
