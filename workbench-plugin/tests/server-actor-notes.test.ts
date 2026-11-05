// @vitest-environment node
/**
 * 事务官(或别的程序)动了哪一块:服务端只广播「哪个动作、哪张卡、一句话」(2026-09-25 卡 P 补三)。
 *
 * 维护者 0.3.1 截图:「看到红框里的东西了吗,好像是个新bug」—— 「事务官正在挪任务卡的状态」连同一圈光框挂在
 * 工作台左上角,任务卡却在右边的看板里(服务端按布局参数重算「看板在哪」,算漂了)。统筹定:程序做的动作
 * 一律只出一行字,页面自己挂在真实的元素上画;服务端不再算矩形、不再让壳画。这里钉服务端那一半:
 * ① 动作 → 哪一块 + 一句人话(一张表,不认识的不出字);② 动作前后各广播一条、跑得久就续、做完再一条;
 * ③ 他自己在页面上点的不出字;④ 出字不是动作的前置条件。页面那一半在 tests/client-actor-notes.test.tsx。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ActorNote } from '../src/protocol.ts'
import { DEFAULT_NOTE_TTL_MS, POINT_DEFAULT_TEXT, actorOfRequest, planForAction, pointNote, withActorNote } from '../src/server/actorNotes.ts'

describe('① 动作 → 挂在哪一块 + 一句人话', () => {
  it('窗口槽四样、文件区两样、看板三样', () => {
    expect(['dock.switch', 'dock.release', 'dock.claim', 'scene.restore'].map(a => planForAction(a)?.region)).toEqual(['slot', 'slot', 'slot', 'slot'])
    expect(['files.pin', 'inbox.archive'].map(a => planForAction(a)?.region)).toEqual(['files', 'files'])
    expect(['task.create', 'task.update', 'task.move'].map(a => planForAction(a)?.region)).toEqual(['board', 'board', 'board'])
    expect(planForAction('task.move')?.verb).toBe('挪任务卡的状态')
  })

  it('不认识的动作 → undefined(不出字,不按名字猜一块)', () => {
    expect(planForAction('dispatch.client')).toBeUndefined()
    expect(planForAction('没这个动作')).toBeUndefined()
  })
})

describe('② 动作前后各广播一行字', () => {
  it('★事务官挪状态:动作前一条、做完一条,都挂那张卡(带卡号),说「事务官正在挪任务卡的状态」', async () => {
    const notes: ActorNote[] = []
    const result = await withActorNote({ action: 'task.move', actor: 'agent', run: async () => 'moved', notify: n => notes.push(n), target: { task_id: 't-f27d6416' } })
    expect(result).toBe('moved')
    expect(notes).toEqual([
      { action: 'task.move', region: 'board', task_id: 't-f27d6416', text: '事务官正在挪任务卡的状态', ttl_ms: DEFAULT_NOTE_TTL_MS },
      { action: 'task.move', region: 'board', task_id: 't-f27d6416', text: '事务官正在挪任务卡的状态', ttl_ms: DEFAULT_NOTE_TTL_MS },
    ])
  })

  it('建事项:还没有卡号 → 不带 task_id(页面挂任务所在的那一块)', async () => {
    const notes: ActorNote[] = []
    await withActorNote({ action: 'task.create', actor: 'agent', run: async () => undefined, notify: n => notes.push(n) })
    expect(notes[0]).toEqual({ action: 'task.create', region: 'board', text: '事务官正在建事项', ttl_ms: DEFAULT_NOTE_TTL_MS })
  })

  it('动作跑得比时长久 → 每半个时长续一条,字不会在动作没做完时先收掉', async () => {
    vi.useFakeTimers()
    try {
      const notes: ActorNote[] = []
      let finish = (): void => {}
      const slow = new Promise<void>((resolve) => { finish = resolve })
      const running = withActorNote({ action: 'files.pin', actor: 'agent', run: () => slow, notify: n => notes.push(n) })
      await vi.advanceTimersByTimeAsync(DEFAULT_NOTE_TTL_MS * 2 + 10)
      finish()
      await running
      // 起手 1 + 中途 4(每半个时长一次)+ 收尾 1
      expect(notes.length).toBeGreaterThanOrEqual(5)
      expect(new Set(notes.map(n => n.region))).toEqual(new Set(['files']))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('动作抛错也照样收尾一条,并且原样把错误抛回去', async () => {
    const notes: ActorNote[] = []
    await expect(withActorNote({ action: 'dock.switch', actor: 'agent', run: async () => { throw new Error('切不过去') }, notify: n => notes.push(n) }))
      .rejects.toThrow('切不过去')
    expect(notes).toHaveLength(2)
  })
})

describe('③ 他自己在页面上点的不出字;④ 出字不是动作的前置条件', () => {
  it('页面来的请求:动作照跑,一条都不广播', async () => {
    const notify = vi.fn()
    expect(await withActorNote({ action: 'task.move', actor: 'page', run: async () => 7, notify })).toBe(7)
    expect(notify).not.toHaveBeenCalled()
  })

  it('表里没有的动作:动作照跑,一条都不广播', async () => {
    const notify = vi.fn()
    expect(await withActorNote({ action: 'dispatch.client', actor: 'agent', run: async () => 7, notify })).toBe(7)
    expect(notify).not.toHaveBeenCalled()
  })

  it('广播本身出了事:动作照跑、结果照回', async () => {
    const result = await withActorNote({ action: 'task.create', actor: 'agent', run: async () => ({ ok: true }), notify: () => { throw new Error('没人听') } })
    expect(result).toEqual({ ok: true })
  })

  it('浏览器 fetch 带 Origin、壳内页面带壳 UA → 页面;都没有(curl / 事务官的工具调用)→ 程序', () => {
    expect(actorOfRequest({ origin: 'http://127.0.0.1:3080' })).toBe('page')
    expect(actorOfRequest({ 'user-agent': 'Mozilla/5.0 AppleWebKit/605.1.15 BenWorkbenchShell/1' })).toBe('page')
    expect(actorOfRequest({ 'user-agent': 'curl/8.7.1' })).toBe('agent')
    expect(actorOfRequest({})).toBe('agent')
  })
})

describe('事务官手动指一下(POST /highlight)', () => {
  it('也只是一行字;没带字就说「事务官在看这一块」', () => {
    expect(pointNote('files', '这里有你要的合同')).toEqual({ action: 'point', region: 'files', text: '这里有你要的合同', ttl_ms: DEFAULT_NOTE_TTL_MS })
    expect(pointNote('board', undefined).text).toBe(POINT_DEFAULT_TEXT)
    expect(pointNote('board', '   ').text).toBe(POINT_DEFAULT_TEXT)
  })
})
