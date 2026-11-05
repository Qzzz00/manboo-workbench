// @vitest-environment node
/**
 * **这件事还有下一步时,派活收回答不收卡**(2026-10-12,卡「演示 · 出图进可灵」)。
 *
 * 两步接力的第一步(豆包出参考图)就是普通派活;它读到豆包说完时,回话照记,
 * 但**不挪去「等你确认」、不按规矩自查打回豆包** —— 收卡的是接力那一层(`videoChain.ts`)。
 * 没有接力的事项一字不变。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { createTasksService } from '../src/server/tasks.ts'
import type { VideoPlan } from '../src/server/videoChain.ts'
import { CHAIN_PUMP_MS, createVideoChain, videoChainPlan } from '../src/server/videoChain.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

async function run(continues: boolean) {
  const clock = Date.parse('2026-10-14T02:00:00Z')
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-continues-'))
  dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => 't-chain01' })
  const reviewed: string[] = []
  const clientDispatch: ClientDispatch = {
    async send(input) {
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
      }
      return { ok: true, dispatch, baseline: [] }
    },
  }
  const runner = createDispatchRunner({
    tasks,
    engine: { read: async () => ({ via: 'window', evidence: 'window', reply: '图片已生成。需要调整吗?' }) },
    clientDispatch,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
    review: async ({ text }) => { reviewed.push(text); return { pass: false, violations: ['x'], reject_text: '重来' } },
    continues: () => continues,
  })
  const created = await tasks.create({ title: '帮我做一个小猫的视频', direction: 'mine', status: 'todo' })
  const id = created.id as string
  await runner.start(id, { family: 'doubao', said: '请帮我生成一张图片:小猫' })
  await runner.tick()
  await runner.tick()
  return { task: (await tasks.list()).tasks.find(one => one.id === id), reviewed }
}

describe('还有下一步', () => {
  it('★回话照记、盯窗收尾;不挪「等你确认」、不自查打回', async () => {
    const { task, reviewed } = await run(true)
    expect(task?.client_dispatch?.reply_state).toBe('done')
    expect(task?.client_dispatch?.reply).toContain('图片已生成')
    expect(task?.status).toBe('doing')
    expect(reviewed).toEqual([])
  })

  it('没有下一步:老行为一字不变(自查没过照旧打回同一条对话)', async () => {
    const { task, reviewed } = await run(false)
    expect(reviewed.length).toBeGreaterThan(0)
    expect(task?.note).toContain('打回去')
  })
})

/* ──────── 两条链同时在走:2026-10-13 17:22–17:28 真机(卡 M)──────── */

/** 等一件真发生(可灵那一步由测试掐着放,拍子不由测试定)。 */
async function until(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (what()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}

describe('★第一条占着可灵的时候', () => {
  /**
   * 真机 17:22 那条在可灵里等着(最长 20 + 2 分钟),17:23 起的第二条**在可灵那一步外面排着**。
   * 排着的这一条照旧算「还有下一步」—— 要是这时派活那一层把它收了(挪「等你确认」、按规矩自查打回豆包),
   * 她就会先收到一句「办完了」,而片子还没开始做。
   */
  it('排着的那一条照旧算「还有下一步」:回话照记、卡不挪「等你确认」、不自查打回', async () => {
    let clock = Date.parse('2026-10-14T02:00:00Z')
    const dir = mkdtempSync(join(tmpdir(), 'wb-chain-parallel-'))
    dirs.push(dir)
    let seq = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-chain0${seq += 1}` })
    const reviewed: string[] = []
    const inKling: string[] = []
    const gates: (() => void)[] = []
    let runner: ReturnType<typeof createDispatchRunner> | undefined
    const chain = createVideoChain({
      tasks: {
        list: async () => await tasks.list(),
        update: async (id, patch) => await tasks.update(id, patch as Parameters<typeof tasks.update>[1]),
        move: async (id, status) => await tasks.move(id, status),
      },
      // 第一步就是普通派活(与生产同一条路:`dispatchItem` → 这个 runner)。
      dispatch: async (id, input) => {
        await runner?.start(id, { family: input.family, said: input.text })
        return { ok: true, note: '已经送到 豆包办公 的窗口里' }
      },
      findImage: async () => ({ url: `u-${inKling.length}`, mtimeMs: clock, body: Buffer.from('PNG'), info: { mime: 'image/png', ext: 'png', width: 1920, height: 1080 } }),
      root: async () => join(dir, 'w'),
      fallbackRoot: join(dir, 'f'),
      writeFile: async () => {},
      kling: async () => {
        inKling.push('in')
        await new Promise<void>((resolve) => { gates.push(resolve) })
        return { kind: 'started', how: 'ax_press', label: '生成', seen: '创作中' }
      },
      file: join(dir, 'chains.json'),
      now: () => clock,
    })
    const clientDispatch: ClientDispatch = {
      async send(input) {
        return {
          ok: true,
          baseline: [],
          dispatch: {
            hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
            at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
          },
        }
      },
    }
    runner = createDispatchRunner({
      tasks,
      engine: { read: async () => ({ via: 'window', evidence: 'window', reply: '图片已生成。' }) },
      clientDispatch,
      readFile: async () => undefined,
      sessions: () => [],
      now: () => new Date(clock),
      setTimer: () => 'timer',
      clearTimer: () => {},
      review: async ({ text }) => { reviewed.push(text); return { pass: false, violations: ['x'], reject_text: '重来' } },
      // 生产里就是这么接的(`http.ts`:`continues: id => videoChain?.owns(id) === true`)。
      continues: id => chain.owns(id),
    })
    const cat = await tasks.create({ title: '帮我做一个小猫穿道士服的视频', direction: 'mine', status: 'todo' })
    const chun = await tasks.create({ title: '帮我做一个街头霸王春丽的视频', direction: 'mine', status: 'todo' })
    await chain.start(cat.id as string, videoChainPlan('帮我做一个小猫穿道士服的视频') as VideoPlan)
    await runner.tick()
    await runner.tick()

    clock += CHAIN_PUMP_MS
    const first = chain.pump()
    await until(() => inKling.length === 1, '第一条进可灵')

    // 第二条这会儿才起:派活那一层照旧走完(送字、盯窗、读回话),一点都不等第一条。
    await chain.start(chun.id as string, videoChainPlan('帮我做一个街头霸王春丽的视频') as VideoPlan)
    await runner.tick()
    await runner.tick()
    clock += CHAIN_PUMP_MS
    const second = chain.pump()
    await until(() => chain.view().some(one => one.item === chun.id && one.queued_at !== undefined), '第二条排上了')

    expect(chain.owns(chun.id as string)).toBe(true)
    await runner.tick()
    const parked = (await tasks.list()).tasks.find(one => one.id === chun.id)
    expect(parked?.client_dispatch?.reply_state).toBe('done')
    expect(parked?.client_dispatch?.reply).toContain('图片已生成')
    expect(parked?.status).toBe('doing')
    expect(reviewed).toEqual([])
    expect(inKling).toHaveLength(1)

    gates.shift()?.()
    await until(() => inKling.length === 2, '轮到第二条')
    gates.shift()?.()
    await first
    await second
    expect(chain.view().map(one => one.stage)).toEqual(['done', 'done'])
    expect(chain.owns(cat.id as string)).toBe(false)
    expect(chain.owns(chun.id as string)).toBe(false)
  })
})
