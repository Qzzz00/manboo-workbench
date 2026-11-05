// @vitest-environment node
/**
 * 采集的编排(src/server/xhsCollect.ts)。
 *
 * 这一份钉四类:
 *
 * 1. **闸**:同一条 10 分钟内不重采、一天有上限(可配)、一次只处理一条;
 * 2. **路径与落盘**:`<工作目录>/采集/<日期-笔记标题>/` 两份 markdown;工作目录没配就整块拒绝;
 * 3. **停下来的那四种**:未登录 / 风控页 / 验证码 / 这条打不开 —— **一种都不重试**;
 * 4. **记录**:成功失败都记一条,滚了几下写进去。
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COLLECT_NO_WORKDIR, DEFAULT_DAILY_MAX, SAME_URL_GAP_MS, checkGates,
  createXhsCollectService, emptyCollectFile, loadCollectFile, pruneDays, saveCollectFile,
} from '../src/server/xhsCollect.ts'
import type { XhsNoteBrowser } from '../src/server/xhsNoteBrowser.ts'
import {
  FAKE_BLOCKED_PAGE_TEXT, FAKE_CAPTCHA_PAGE_TEXT, FAKE_NOTE_PAYLOAD, FAKE_NOTE_URL,
} from './xhsNoteFixtures.ts'

const T0 = Date.parse('2026-09-22T10:00:00+08:00')

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** 假浏览器。默认回那份**明显假**的笔记数据;可以换成墙。 */
function stubBrowser(over: Partial<{ payload: string, text: string, href: string, scrolls: number, boom: string }> = {}) {
  const opened: string[] = []
  const browser: XhsNoteBrowser = {
    openWindow: async (_dir, url) => { opened.push(url); return 9222 },
    readNote: async (_dir, url) => {
      opened.push(url)
      if (over.boom !== undefined) throw new Error(over.boom)
      return {
        href: over.href ?? FAKE_NOTE_URL,
        text: over.text ?? '假标题\n假作者',
        payload: over.payload ?? FAKE_NOTE_PAYLOAD,
        scrolls: over.scrolls ?? 4,
      }
    },
  }
  return { browser, opened }
}

async function service(options: {
  workdir?: string | undefined
  now?: () => number
  browserOver?: Parameters<typeof stubBrowser>[0]
  breakdown?: (note: unknown, dir: string, url: string) => Promise<{ ok: boolean, message: string, file?: string }>
} = {}) {
  const store = await tmp('wb-collect-store-')
  const work = options.workdir === undefined ? await tmp('wb-collect-work-') : options.workdir
  const stub = stubBrowser(options.browserOver)
  const svc = createXhsCollectService({
    file: join(store, 'xhs-collect.json'),
    profileDir: join(store, 'profile'),
    workdir: () => (work === '' ? undefined : work),
    browser: stub.browser,
    now: options.now ?? (() => T0),
    ...(options.breakdown === undefined
      ? {}
      : { breakdown: options.breakdown as NonNullable<Parameters<typeof createXhsCollectService>[0]['breakdown']> }),
  })
  await svc.load()
  return { svc, work, store, opened: stub.opened }
}

describe('闸', () => {
  it('★ 同一条链接 10 分钟内不重采', async () => {
    const file = { ...emptyCollectFile(), last: { [FAKE_NOTE_URL]: T0 } }
    const gate = checkGates(file, FAKE_NOTE_URL, T0 + 60_000)
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.reason).toContain('刚采过')
    // 满 10 分钟就放行。
    expect(checkGates(file, FAKE_NOTE_URL, T0 + SAME_URL_GAP_MS).ok).toBe(true)
  })

  it('★ 一天上限,默认 30,可配', async () => {
    const today = '2026-09-22'
    const full = { ...emptyCollectFile(), days: { [today]: DEFAULT_DAILY_MAX } }
    const gate = checkGates(full, FAKE_NOTE_URL, T0)
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.reason).toContain('上限')
    expect(gate.reason).toContain(String(DEFAULT_DAILY_MAX))

    // 改成 2:第二条就到顶。
    const small = { ...emptyCollectFile(), daily_max: 2, days: { [today]: 2 } }
    expect(checkGates(small, FAKE_NOTE_URL, T0).ok).toBe(false)
  })

  it('★ 失败也算一次 —— 不然"打不开就不算数"会变成无限重试', async () => {
    const { svc, store } = await service({ browserOver: { boom: '登录窗口没开着' } })
    const first = await svc.collectNote(FAKE_NOTE_URL)
    expect(first.ok).toBe(false)
    const file = await loadCollectFile(join(store, 'xhs-collect.json'))
    expect(file.days['2026-09-22']).toBe(1)
    expect(file.last[FAKE_NOTE_URL]).toBe(T0)

    // 立刻再点一次:被闸挡住,而且**不会再去开那一页**。
    const again = await svc.collectNote(FAKE_NOTE_URL)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('刚采过')
  })

  it('pruneDays 只留最近 7 天 —— 这个文件没有理由越长越大', () => {
    const days = { '2026-09-22': 1, '2026-09-16': 1, '2026-09-15': 1, '2026-01-01': 9 }
    const kept = pruneDays(days, '2026-09-22')
    expect(Object.keys(kept).sort()).toEqual(['2026-09-16', '2026-09-22'])
  })

  it('读坏了的文件当没有(不让一份坏 JSON 废掉整块功能)', async () => {
    const dir = await tmp('wb-collect-bad-')
    const file = join(dir, 'x.json')
    await saveCollectFile(file, emptyCollectFile())
    const loaded = await loadCollectFile(join(dir, '不存在.json'))
    expect(loaded.daily_max).toBe(DEFAULT_DAILY_MAX)
    expect(loaded.logs).toEqual([])
    expect((await loadCollectFile(file)).version).toBe(1)
  })
})

describe('路径与落盘', () => {
  it('★ 落在 <工作目录>/采集/<日期-笔记标题>/,两份 markdown', async () => {
    const { svc, work } = await service()
    const result = await svc.collectNote(FAKE_NOTE_URL)
    expect(result.ok).toBe(true)
    // 标题里那个全角冒号被换成 `_`:Finder 会把文件名里的全角冒号显示成 `/`,
    // 一个看起来像路径分隔符的目录名迟早要出事(safeNoteTitle 里挡的就是这一类)。
    const dir = join(work, '采集', '2026-09-22-假标题_这是一条编出来的视频笔记')
    expect(result.dir).toBe(dir)
    expect((await readdir(dir)).sort()).toEqual(['笔记.md', '评论.md'])

    const noteMd = await readFile(join(dir, '笔记.md'), 'utf8')
    expect(noteMd).toContain('假作者')
    expect(noteMd).toContain(FAKE_NOTE_URL)
    const commentsMd = await readFile(join(dir, '评论.md'), 'utf8')
    expect(commentsMd).toContain('只采了 3 条')
    expect(commentsMd).not.toContain('这是子评论')
  })

  it('★ 工作目录没配:整块拒绝,不猜一个路径', async () => {
    const { svc, opened } = await service({ workdir: '' })
    const result = await svc.collectNote(FAKE_NOTE_URL)
    expect(result.ok).toBe(false)
    expect(result.message).toBe(COLLECT_NO_WORKDIR)
    // ★ 连页面都没去开 —— 没地方落就别去打扰那个站。
    expect(opened).toEqual([])
  })

  it('链接认不出来时连浏览器都不碰', async () => {
    const { svc, opened } = await service()
    const result = await svc.collectNote('https://www.xiaohongshu.com/search_result?keyword=x')
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  })
})

describe('★ 停下来的那四种:一种都不重试', () => {
  it.each([
    ['风控页', { text: FAKE_BLOCKED_PAGE_TEXT }, '当前笔记暂时无法浏览'],
    ['验证码', { text: FAKE_CAPTCHA_PAGE_TEXT }, '不替你过验证码'],
    ['未登录', { href: 'https://www.xiaohongshu.com/login?x=1' }, '未登录'],
    ['拿不到数据', { payload: '' }, '不重试'],
  ])('%s → 如实说,并且只开了一次页面', async (_name, over, expected) => {
    const { svc, opened, work } = await service({ browserOver: over })
    const result = await svc.collectNote(FAKE_NOTE_URL)
    expect(result.ok).toBe(false)
    expect(result.message).toContain(expected)
    // ★ 只去过一次。没有"换个地址再试一次"、没有重试循环。
    expect(opened).toHaveLength(1)
    // 一个文件都没落。
    await expect(readdir(join(work, '采集'))).rejects.toThrow()
  })

  it('浏览器窗口没开着:把那句原话原样交出来', async () => {
    const { svc } = await service({ browserOver: { boom: '登录窗口没开着' } })
    const result = await svc.collectNote(FAKE_NOTE_URL)
    expect(result.message).toBe('登录窗口没开着')
  })
})

describe('记录:每一次都看得见', () => {
  it('成功那条写着采到几条、落在哪、滚了几下', async () => {
    const { svc } = await service()
    await svc.collectNote(FAKE_NOTE_URL)
    const view = await svc.view()
    expect(view.logs).toHaveLength(1)
    const one = view.logs[0]
    expect(one?.ok).toBe(true)
    expect(one?.kind).toBe('note')
    expect(one?.comments).toBe(3)
    // ★ 滚了几下写进去 —— 这是我们唯一让页面动的动作,不藏着。
    expect(one?.scrolls).toBe(4)
    expect(one?.url).toBe(FAKE_NOTE_URL)
    expect(view.today).toBe(1)
    expect(view.daily_max).toBe(DEFAULT_DAILY_MAX)
  })

  it('失败那条写着为什么,而且 comments 缺席(不写 0)', async () => {
    const { svc } = await service({ browserOver: { text: FAKE_BLOCKED_PAGE_TEXT } })
    await svc.collectNote(FAKE_NOTE_URL)
    const view = await svc.view()
    expect(view.logs[0]?.ok).toBe(false)
    expect(view.logs[0]?.reason).toContain('当前笔记暂时无法浏览')
    expect(view.logs[0]?.comments).toBeUndefined()
  })

  it('落盘那份里不出现任何凭据字样', async () => {
    const { svc, store } = await service()
    await svc.collectNote(FAKE_NOTE_URL)
    const raw = await readFile(join(store, 'xhs-collect.json'), 'utf8')
    for (const word of ['cookie', 'web_session', 'authorization', 'localStorage']) {
      expect(raw.replace(/xsec_token=[^"&]*/g, '')).not.toContain(word)
    }
  })
})

describe('③ 拆解', () => {
  it('★ 拆解不会自己再开一次页面:用的是这一轮采到的那份', async () => {
    const seen: string[] = []
    const { svc, opened } = await service({
      breakdown: async (_note, dir, url) => { seen.push(`${url}|${dir}`); return { ok: true, message: '拆好了', file: `${dir}/拆解.md` } },
    })
    await svc.collectNote(FAKE_NOTE_URL)
    expect(opened).toHaveLength(1)

    const torn = await svc.breakdown(FAKE_NOTE_URL)
    expect(torn.ok).toBe(true)
    // ★ 还是只开过一次页面。
    expect(opened).toHaveLength(1)
    expect(seen).toHaveLength(1)
  })

  it('还没采过时先采一次(那一次照样过闸)', async () => {
    const { svc, opened } = await service({
      breakdown: async (_n, dir) => ({ ok: true, message: '拆好了', file: `${dir}/拆解.md` }),
    })
    const torn = await svc.breakdown(FAKE_NOTE_URL)
    expect(torn.ok).toBe(true)
    expect(opened).toHaveLength(1)
  })

  it('没接拆解时如实说,不假装能拆', async () => {
    const { svc } = await service()
    const torn = await svc.breakdown(FAKE_NOTE_URL)
    expect(torn.ok).toBe(false)
    expect(torn.message).toContain('还没接')
  })

  it('拆解抛了也不炸,记一条失败记录', async () => {
    const { svc } = await service({
      breakdown: async () => { throw new Error('whisper-cli 找不到') },
    })
    const torn = await svc.breakdown(FAKE_NOTE_URL)
    expect(torn.ok).toBe(false)
    expect(torn.message).toContain('whisper-cli')
    const view = await svc.view()
    expect(view.logs.find(one => one.kind === 'breakdown')?.ok).toBe(false)
  })
})
