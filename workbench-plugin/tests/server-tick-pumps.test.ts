// @vitest-environment node
/**
 * ★ **那根 1 秒节拍上挂着的几样,一样都不许掉**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 为什么有这一份:写那张卡时往那根节拍上加「问一句锁没锁」,**手一滑把 `relayWatch.pump()` 换掉了**
 * —— 那一下的后果是「捎出去的话回了没有」整条巡检停摆(她永远等不到那通回电),
 * 而**全量 10148 条用例一条都没红**:那根节拍上挂着什么,从来没有人钉过。
 *
 * 所以这一份只钉一件事:**服务起来之后,挂在那根节拍上的那几样真的被叫到了。**
 * 一样都不测它们各自做什么(各有各的用例),只测「接线还在」。
 * 以后往那根节拍上加东西,也在这里加一条。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

/** 一拍 10 毫秒,等几拍就够(别的用例一律 `tickIntervalMs: 0`,所以这一条是唯一真走节拍的)。 */
const TICK_MS = 10

function counter() {
  let calls = 0
  return { calls: () => calls, pump: async () => { calls += 1 } }
}

describe('1 秒节拍:挂在上面的那几样都被叫到了', () => {
  it('★★`relayWatch.pump` / `screenLock.pump` / `awayAwake.pump` 每一拍都走一次(接线掉了这条就红)', async () => {
    const relay = counter()
    const lock = counter()
    const away = counter()
    const service = createWorkbenchService({ now: () => 0 })
    const server = await startWorkbenchServer({
      port: 0,
      service,
      tickIntervalMs: TICK_MS,
      heartbeatMs: 0,
      // 这几样只要一个会数数的 `pump`;它们各自做什么另有用例。
      relayWatch: { pump: relay.pump } as never,
      screenLock: { pump: lock.pump, locked: () => undefined },
      awayAwake: { pump: away.pump, view: () => ({ enabled: false, active: false }), apply: async () => ({ view: { enabled: false, active: false }, applied: false }), forget: () => {}, helperChanged: () => {} },
    })
    started.push(server)
    await new Promise((resolve) => { setTimeout(resolve, TICK_MS * 12) })
    expect(relay.calls(), '捎话回电巡检:那根节拍上的接线掉了 —— 她永远等不到那通回电').toBeGreaterThan(0)
    expect(lock.calls(), '锁屏那一拍:接线掉了 —— 她解锁之后排着的那几句话永远不会送出去').toBeGreaterThan(0)
    expect(away.calls(), '出门那一拍:接线掉了 —— 她出门之后屏幕照旧 10 分钟就睡、一睡就锁').toBeGreaterThan(0)
  })
})

/** `/state` 里壳那一格要有(composeState 只用 `view()`;`onChange` / `onEvent` 起服务时会接)。 */
function fakeHelper() {
  return {
    view: () => ({ connected: true, authorized: true }),
    connected: () => true,
    supports: () => true,
    request: async () => ({}),
    onChange: () => {},
    onEvent: () => {},
  }
}

async function stateOf(server: WorkbenchServer): Promise<{ helper?: { screen_locked?: boolean } }> {
  const res = await fetch(`${server.url}/state`)
  return await res.json() as { helper?: { screen_locked?: boolean } }
}

describe('/state.helper.screen_locked:她在界面上看得见「这会儿是锁着的」', () => {
  it('★锁着屏 → 那一格是真', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      helper: fakeHelper() as never,
      screenLock: { pump: async () => {}, locked: () => true },
    })
    started.push(server)
    expect((await stateOf(server)).helper?.screen_locked).toBe(true)
  })

  it('★没锁 → 那一格是假', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      helper: fakeHelper() as never,
      screenLock: { pump: async () => {}, locked: () => false },
    })
    started.push(server)
    expect((await stateOf(server)).helper?.screen_locked).toBe(false)
  })

  it('★★**不知道**(老壳不报那一格 / 还没问到)→ 那一格**不摆**(不许把「不知道」显示成「没锁」)', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      helper: fakeHelper() as never,
      screenLock: { pump: async () => {}, locked: () => undefined },
    })
    started.push(server)
    const state = await stateOf(server)
    expect(state.helper, '壳那一格还在').toBeDefined()
    expect('screen_locked' in (state.helper as object)).toBe(false)
  })

  it('★这台没接那一拍(老宿主)→ 壳那一格一字不变', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      helper: fakeHelper() as never,
    })
    started.push(server)
    const state = await stateOf(server)
    expect(state.helper).toEqual({ connected: true, authorized: true })
  })
})
