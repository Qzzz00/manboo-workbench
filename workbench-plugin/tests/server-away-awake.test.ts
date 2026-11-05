// @vitest-environment node
/**
 * ★ **「出门时电脑不睡」的判断与下发**(2026-10-03,卡「出门时电脑不睡」)。
 *
 * 判法(`src/server/awayAwake.ts` 文件头有全文):**在线设备表**里有一台,它的 id 在
 * **配对记录**里、记着的是手机 → 她出门了(手机按需进房,在局域网里会把房间放掉)。
 * 开关开着 + 真出门了 = `active`,壳那边 `shouldHold` 从这一刻起不看前台。
 *
 * 这一份钉三件事:
 *   ① 判断本身(**话筒不算**、表旧了算不知道、不知道一律按没出门);
 *   ② 下发(变了才发、壳断线重连要再发一次、发不成下一拍再试);
 *   ③ 她点完开关那一下的回话(壳没接上**如实说**要重开工作台,不谎报)。
 *
 * 壳那一半(`DisplayAwakePolicy.holdReason` / 断言那一行的名字)在
 * `workbench-app/run-tests.sh` 里,这里不重测。
 */
import { describe, expect, it } from 'vitest'
import {
  AWAY_AWAKE_LOG_OFF,
  AWAY_AWAKE_LOG_ON,
  awayAwakeActive,
  createAwayAwakeWatch,
  phoneAwayNow,
} from '../src/server/awayAwake.ts'
import type { AwayAwakeDeps } from '../src/server/awayAwake.ts'
import type { DevicesView, OnlineDevice, PairedKinds } from '../src/server/deviceDirectory.ts'

function online(partial: Partial<OnlineDevice> & { device_id: string }): OnlineDevice {
  return { identity: `wb-phone-${partial.device_id}`, name: '小米', kind: 'phone', ...partial }
}

function table(devices: readonly OnlineDevice[], stale = false): DevicesView {
  return { devices, reported_at: '2026-10-03T12:00:00.000Z', stale }
}

const PHONE = 'dev-phone-1'
const HANDSET = 'dev-handset-1'
const paired: PairedKinds = new Map([[PHONE, 'phone'], [HANDSET, 'handset']])

describe('phoneAwayNow:这一刻有没有已配对手机在外面连着', () => {
  it('★已配对的那台手机在房里 → 出门了', () => {
    expect(phoneAwayNow({ devices: table([online({ device_id: PHONE })]), paired })).toBe(true)
  })

  it('★房里只有工人自己(mac) → 没出门', () => {
    const worker = online({ device_id: 'wb-channel-worker', kind: 'mac', name: '这台电脑' })
    expect(phoneAwayNow({ devices: table([worker]), paired })).toBe(false)
  })

  it('★★那只树莓派话筒**不算出门** —— 它常驻房间,而且就摆在她家桌上', () => {
    // 中转签的进房凭证一度不带 wb_kind:**上报里它的 kind 就是 phone**(deviceDirectory 文件头那个坑)。
    // 按上报那一格判,她在家也会被判成出门、家里那块屏整天亮着。所以只认配对记录。
    const asPhone = online({ device_id: HANDSET, kind: 'phone', name: '座机' })
    expect(phoneAwayNow({ devices: table([asPhone]), paired })).toBe(false)
  })

  it('★没配过对的那台(房里混进来别的 identity)不算', () => {
    expect(phoneAwayNow({ devices: table([online({ device_id: '谁啊' })]), paired })).toBe(false)
  })

  it('★★这份表旧了(工人掉线 / 工作台刚重启)→ **不知道**,不拿陈旧的表当实情', () => {
    expect(phoneAwayNow({ devices: table([online({ device_id: PHONE })], true), paired })).toBeUndefined()
  })

  it('★工人一次都没报过(stale + 一台都没有)→ 不知道', () => {
    const never: DevicesView = { devices: [], stale: true, note: '工人还没报过在线设备' }
    expect(phoneAwayNow({ devices: never, paired })).toBeUndefined()
  })

  it('★没接通道层 / 读不出配对表 → 都是不知道(不猜)', () => {
    expect(phoneAwayNow({ paired })).toBeUndefined()
    expect(phoneAwayNow({ devices: table([online({ device_id: PHONE })]) })).toBeUndefined()
    expect(phoneAwayNow({})).toBeUndefined()
  })

  it('房里一台都没有(表是新的)→ 明确的「没出门」,不是不知道', () => {
    expect(phoneAwayNow({ devices: table([]), paired })).toBe(false)
  })
})

describe('awayAwakeActive:开关 × 出门', () => {
  it('★开关关着 → 恒假(出门也一样)—— 行为与 2026-10-03 之前逐字相同', () => {
    expect(awayAwakeActive(false, true)).toBe(false)
    expect(awayAwakeActive(false, false)).toBe(false)
    expect(awayAwakeActive(false, undefined)).toBe(false)
  })

  it('★开关开着 + 真出门 → 真', () => {
    expect(awayAwakeActive(true, true)).toBe(true)
  })

  it('★★开关开着但**不知道** → 假(按反了她家里那块屏会整天亮着,而她看不见)', () => {
    expect(awayAwakeActive(true, undefined)).toBe(false)
    expect(awayAwakeActive(true, false)).toBe(false)
  })
})

/** 一台假壳:记下收到的每个 `active`;`fail` 期间当旧壳(抛「未知 op」)。 */
function harness(opts: { settingOn?: boolean, devices?: DevicesView, connected?: boolean } = {}) {
  const sent: boolean[] = []
  const lines: string[] = []
  const state = {
    settingOn: opts.settingOn ?? true,
    devices: opts.devices ?? table([online({ device_id: PHONE })]),
    connected: opts.connected ?? true,
    fail: undefined as string | undefined,
    paired: paired as PairedKinds | undefined,
    clock: 0,
  }
  const deps: AwayAwakeDeps = {
    settingOn: async () => state.settingOn,
    devices: () => state.devices,
    paired: async () => state.paired,
    send: async (active) => {
      if (state.fail !== undefined) throw new Error(state.fail)
      sent.push(active)
    },
    connected: () => state.connected,
    now: () => state.clock,
    pollMs: 1000,
    warn: line => { lines.push(line) },
  }
  return { state, sent, lines, watch: createAwayAwakeWatch(deps) }
}

describe('下发:变了才发,壳重连要再发一次', () => {
  it('★第一拍把结论发给壳;没变的后续几拍一条都不发', async () => {
    const h = harness()
    await h.watch.pump()
    expect(h.sent).toEqual([true])
    expect(h.lines).toEqual([AWAY_AWAKE_LOG_ON])
    h.state.clock += 5000
    await h.watch.pump()
    h.state.clock += 5000
    await h.watch.pump()
    expect(h.sent, '结论没变 → 不发').toEqual([true])
  })

  it('★限频:还没到点的那几拍压根不算一次(在线设备表自己 60 秒一报)', async () => {
    const h = harness()
    await h.watch.pump()
    h.state.settingOn = false
    h.state.clock += 100
    await h.watch.pump()
    expect(h.sent, '离上一拍太近 → 这一拍直接跳过').toEqual([true])
    h.state.clock += 1000
    await h.watch.pump()
    expect(h.sent).toEqual([true, false])
  })

  it('★她回到局域网(手机把房间放掉)→ 下发 false,壳当场回到只看前台', async () => {
    const h = harness()
    await h.watch.pump()
    h.state.devices = table([])
    h.state.clock += 5000
    await h.watch.pump()
    expect(h.sent).toEqual([true, false])
    expect(h.lines).toEqual([AWAY_AWAKE_LOG_ON, AWAY_AWAKE_LOG_OFF])
    expect(h.watch.view()).toEqual({ enabled: true, phone_away: false, active: false })
  })

  it('★★壳断线再接上 → **再发一次**(壳起来那一格缺省是 false,它自己不知道这件事)', async () => {
    const h = harness()
    await h.watch.pump()
    expect(h.sent).toEqual([true])
    h.state.connected = false
    h.state.clock += 5000
    await h.watch.pump()
    expect(h.sent, '壳没接上 → 不发,但把「发过什么」忘掉').toEqual([true])
    h.state.connected = true
    h.state.clock += 5000
    await h.watch.pump()
    expect(h.sent, '★重连之后同一个结论要再发一遍').toEqual([true, true])
  })

  it('★★`forget()`:壳在两拍之间断开又接上(我们完全没看见)→ 下一拍把结论重发一次', async () => {
    const h = harness()
    await h.watch.pump()
    expect(h.sent).toEqual([true])
    // 壳抖了一下又回来了:`connected()` 两拍都是 true,光靠它看不出来。
    h.watch.forget()
    // 限频也一起清掉 —— 她重连那一拍就该把结论补上,不要再等 5 秒。
    await h.watch.pump()
    expect(h.sent, '★不重发的话壳内存里那一格还是缺省的 false,而且是静默的').toEqual([true, true])
  })

  it('★★发不成(旧壳不认这个 op / 壳正在重启)→ 不记成发过,下一拍再试', async () => {
    const h = harness()
    h.state.fail = '未知 op'
    await h.watch.pump()
    expect(h.sent).toEqual([])
    h.state.fail = undefined
    h.state.clock += 5000
    await h.watch.pump()
    expect(h.sent).toEqual([true])
  })

  it('★开关关着 → 发的是 false(一条也不少发:壳那头要知道这颗开关关了)', async () => {
    const h = harness({ settingOn: false })
    await h.watch.pump()
    expect(h.sent).toEqual([false])
    expect(h.watch.view()).toEqual({ enabled: false, phone_away: true, active: false })
  })

  it('★★「不知道」那一格缺席 —— 界面不许把它显示成「没出门」', async () => {
    const h = harness({ devices: table([online({ device_id: PHONE })], true) })
    await h.watch.pump()
    expect(h.watch.view()).toEqual({ enabled: true, active: false })
    expect('phone_away' in h.watch.view()).toBe(false)
  })

  it('★没接通道层(没有在线设备表)→ 恒 false、那一格缺席,一个判断都不编', async () => {
    const sent: boolean[] = []
    const watch = createAwayAwakeWatch({
      settingOn: async () => true,
      send: async (active) => { sent.push(active) },
      connected: () => true,
      now: () => 0,
    })
    await watch.pump()
    expect(watch.view()).toEqual({ enabled: true, active: false })
    expect(sent).toEqual([false])
  })

  it('读不出 app.json(文件坏了)→ 按**关**算(缺省关在这里也成立)', async () => {
    const watch = createAwayAwakeWatch({
      settingOn: async () => { throw new Error('读不动') },
      devices: () => table([online({ device_id: PHONE })]),
      paired: async () => paired,
      send: async () => {},
      connected: () => true,
      now: () => 0,
    })
    await watch.pump()
    expect(watch.view().enabled).toBe(false)
    expect(watch.view().active).toBe(false)
  })

  it('配对表读不出来 → 不知道(**不敢把一只走中转的话筒当成手机**)', async () => {
    const h = harness()
    h.state.paired = undefined
    await h.watch.pump()
    expect(h.watch.view()).toEqual({ enabled: true, active: false })
  })
})

describe('apply:她在设置里点完那一下', () => {
  it('★不管变没变都立刻发一次(她正看着那句回话,等不了 5 秒)', async () => {
    const h = harness()
    await h.watch.pump()
    expect(h.sent).toEqual([true])
    const out = await h.watch.apply()
    expect(out.applied).toBe(true)
    expect(out.view).toEqual({ enabled: true, phone_away: true, active: true })
    expect(h.sent, '★同一个结论也再发一次').toEqual([true, true])
  })

  it('★★壳没接上:如实说要重开工作台,**不谎报**当场生效', async () => {
    const h = harness({ connected: false })
    const out = await h.watch.apply()
    expect(out.applied).toBe(false)
    expect(String(out.reason)).toContain('重开工作台')
    expect(h.sent).toEqual([])
  })

  it('★旧壳不认这个 op:原话往上传,照旧不说已经生效', async () => {
    const h = harness()
    h.state.fail = '未知 op'
    const out = await h.watch.apply()
    expect(out.applied).toBe(false)
    expect(out.reason).toBe('未知 op')
  })

  it('★apply 之后那一下也算一拍(不会紧接着再发一条)', async () => {
    const h = harness()
    await h.watch.apply()
    expect(h.sent).toEqual([true])
    await h.watch.pump()
    expect(h.sent, '限频从 apply 那一刻起算').toEqual([true])
  })
})
