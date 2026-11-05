/**
 * 「出门时电脑不睡」**只在壳的连法真变了才重发**(2026-10-21 急修「8791 空转」顺手核的周期)。
 *
 * 真机日志:17 点那一小时「[出门] 手机在外面连着,先别让屏幕暗下去」记了 32 次,一次「不按了」都没有 ——
 * 同一个结论反复下发、反复记。根子是 `forget()` 接在 `helper.onChange` 上,而那个回调不只在壳连上 / 断开 /
 * 授权变了时响,壳每弹一条系统通知(`notify_status`、`recordNotify`)也响。
 *
 * 钉三件事:
 *   ① 连法没变(同样连着、同样授权)来几次都不重发、不重记;
 *   ② 断开又连上(哪怕两拍之间)→ 下一拍重发(那张卡要治的那一幕照旧治);
 *   ③ 授权变了 → 也重发。
 */
import { describe, expect, it } from 'vitest'
import type { AwayAwakeDeps } from '../src/server/awayAwake.ts'
import { createAwayAwakeWatch } from '../src/server/awayAwake.ts'
import type { DevicesView, PairedKinds } from '../src/server/deviceDirectory.ts'

const PHONE = 'dev-phone-1'
const paired: PairedKinds = new Map([[PHONE, 'phone']])
const away: DevicesView = { devices: [{ identity: `wb-phone-${PHONE}`, name: '小米', kind: 'phone', device_id: PHONE }], reported_at: '2026-10-21T12:00:00.000Z', stale: false }

function harness() {
  const sent: boolean[] = []
  const lines: string[] = []
  const state = { clock: 0, connected: true }
  const deps: AwayAwakeDeps = {
    settingOn: async () => true,
    devices: () => away,
    paired: async () => paired,
    send: async (active) => { sent.push(active) },
    connected: () => state.connected,
    now: () => state.clock,
    pollMs: 1000,
    warn: line => { lines.push(line) },
  }
  const watch = createAwayAwakeWatch(deps)
  const tick = async (): Promise<void> => { state.clock += 1000; await watch.pump() }
  return { state, sent, lines, watch, tick }
}

describe('只在壳的连法真变了才重发', () => {
  it('★连法没变(弹了几条通知)→ 不重发、不重记', async () => {
    const h = harness()
    h.watch.helperChanged({ connected: true, authorized: true })
    await h.tick()
    expect(h.sent).toEqual([true])
    for (let i = 0; i < 5; i++) {
      h.watch.helperChanged({ connected: true, authorized: true })
      await h.tick()
    }
    expect(h.sent).toEqual([true])
    expect(h.lines).toHaveLength(1)
  })

  it('★断开又连上(两拍之间)→ 下一拍重发', async () => {
    const h = harness()
    h.watch.helperChanged({ connected: true, authorized: true })
    await h.tick()
    h.watch.helperChanged({ connected: false, authorized: false })
    h.watch.helperChanged({ connected: true, authorized: true })
    await h.tick()
    expect(h.sent).toEqual([true, true])
  })

  it('授权变了 → 重发', async () => {
    const h = harness()
    h.watch.helperChanged({ connected: true, authorized: false })
    await h.tick()
    h.watch.helperChanged({ connected: true, authorized: true })
    await h.tick()
    expect(h.sent).toEqual([true, true])
  })
})
