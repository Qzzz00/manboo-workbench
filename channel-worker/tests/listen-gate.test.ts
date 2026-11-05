/**
 * 收音闸(2026-09-25,卡 fix/evening-gaps 第 1 条)。要钉住的:
 *   ① 不在通话里:谁的麦克风都不订、框架那一路收音关着、识别连接当场收掉;
 *   ② 通话里:只订接话对象的麦克风,别人的(另一台手机、测试页、话筒)不订;
 *   ③ 挂断那一下:退订 + 关收音 + 收火山,各一次;同样的话不重复说给 SDK;
 *   ④ 房里后来才发的轨道(手机接通之后才发布麦克风)照样按闸订或不订;
 *   ⑤ SDK 抛了不把工人带走,下一次对账再试。
 */
import { describe, expect, it } from 'vitest'
import type { GateParticipant, GatePublication } from '../src/listenGate.ts'
import { ListenGate } from '../src/listenGate.ts'

interface FakePub extends GatePublication {
  sid: string
  kind: 'mic' | 'other'
  calls: boolean[]
  subscribed: boolean
  fail?: boolean
}

function pub(sid: string, kind: 'mic' | 'other' = 'mic'): FakePub {
  const entry: FakePub = {
    sid,
    kind,
    calls: [],
    subscribed: false,
    setSubscribed(on: boolean) {
      if (entry.fail === true) throw new Error('SDK 抛了')
      entry.calls.push(on)
      entry.subscribed = on
    },
  }
  return entry
}

function room(people: Record<string, FakePub[]>) {
  const participants = new Map<string, GateParticipant>()
  const add = (identity: string, pubs: FakePub[]): void => {
    participants.set(identity, { identity, trackPublications: new Map(pubs.map(one => [one.sid, one])) })
  }
  for (const [identity, pubs] of Object.entries(people)) add(identity, pubs)
  return { participants, add }
}

function gate(people: Record<string, FakePub[]>, options: { quiet?: number } = {}) {
  const r = room(people)
  const audio: boolean[] = []
  const lines: string[] = []
  let quiets = 0
  const g = new ListenGate({
    participants: () => r.participants.values(),
    isMic: publication => (publication as FakePub).kind === 'mic',
    setAudioEnabled: on => { audio.push(on) },
    quietAsr: () => { quiets += 1; return options.quiet ?? 1 },
    log: line => lines.push(line),
  })
  return { g, r, audio, lines, quiets: () => quiets }
}

describe('不在通话里:谁都不听', () => {
  it('工人起来时房里已经有一台手机挂着麦克风(旧包挂断只静音):不订、收音关着、记一行', () => {
    const phoneMic = pub('TR_phone')
    const t = gate({ 'wb-phone-a': [phoneMic] })
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '工人起来了')
    expect(phoneMic.calls).toEqual([false])
    expect(t.audio).toEqual([false])
    expect(t.g.listening).toBe(false)
    expect(t.lines.join('\n')).toContain('收音关了(工人起来了)')
  })

  it('同样的状态再落一次:一个字都不重复说给 SDK,也不重复记日志', () => {
    const phoneMic = pub('TR_phone')
    const t = gate({ 'wb-phone-a': [phoneMic] })
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '一')
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '二')
    expect(phoneMic.calls).toEqual([false])
    expect(t.audio).toEqual([false])
    expect(t.lines).toHaveLength(1)
  })
})

describe('通话里:只听接话对象', () => {
  it('他拨通了:订他的麦克风、收音打开;房里另一台手机与测试页不订', () => {
    const mine = pub('TR_mine')
    const other = pub('TR_other')
    const dev = pub('TR_dev')
    const t = gate({ 'wb-phone-a': [mine], 'wb-phone-b': [other], 'wb-dev-page': [dev] })
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '起来')
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '他拨通了')
    expect(mine.calls).toEqual([false, true])
    expect(other.calls).toEqual([false])
    expect(dev.calls).toEqual([false])
    expect(t.audio).toEqual([false, true])
    expect(t.g.speaker).toBe('wb-phone-a')
    expect(t.lines.at(-1)).toContain('收音开了(他拨通了):只听 wb-phone-a')
  })

  it('只订麦克风那种音轨:别的轨道一概不碰', () => {
    const mic = pub('TR_mic')
    const screen = pub('TR_screen', 'other')
    const t = gate({ 'wb-phone-a': [mic, screen] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    expect(mic.calls).toEqual([true])
    expect(screen.calls).toEqual([])
  })

  it('接通之后手机才发布麦克风(新包:接通了才开麦):下一次对账当场订上', () => {
    const t = gate({ 'wb-phone-a': [] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    const late = pub('TR_late')
    t.r.add('wb-phone-a', [late])
    t.g.reconcile()
    expect(late.calls).toEqual([true])
  })

  it('通话中接话对象换了(他拿起了听筒):退订手机、订听筒,收音不重开', () => {
    const phone = pub('TR_phone')
    const handset = pub('TR_handset')
    const t = gate({ 'wb-phone-a': [phone], 'wb-handset-1': [handset] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    t.g.sync({ listen: true, speaker: 'wb-handset-1' }, '改跟听筒')
    expect(phone.calls).toEqual([true, false])
    expect(handset.calls).toEqual([false, true])
    expect(t.audio).toEqual([true])
    expect(t.lines.at(-1)).toContain('只听 wb-handset-1')
  })

  it('该听但房里没有能听的人:收音开着,谁都不订', () => {
    const stray = pub('TR_stray')
    const t = gate({ 'wb-phone-b': [stray] })
    t.g.sync({ listen: true, speaker: undefined }, '接通')
    expect(stray.calls).toEqual([false])
    expect(t.g.listening).toBe(true)
  })
})

describe('挂断那一下', () => {
  it('★ 退订、关收音、火山当场收掉 —— 各一次,日志里写明收了几条', () => {
    const mine = pub('TR_mine')
    const t = gate({ 'wb-phone-a': [mine] }, { quiet: 1 })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '手机挂了')
    expect(mine.calls).toEqual([true, false])
    expect(t.audio).toEqual([true, false])
    expect(t.quiets()).toBe(1)
    expect(t.lines.at(-1)).toContain('收音关了(手机挂了)')
    expect(t.lines.at(-1)).toContain('识别连接当场收掉 1 条')
    // 再挂一次(手机离房又补一刀):不再收、不再记。
    t.g.sync({ listen: false, speaker: undefined }, '房里没人了')
    expect(t.quiets()).toBe(1)
    expect(t.audio).toEqual([true, false])
  })

  it('挂断之后手机(旧包)那条静音轨道还挂在房里:保持退订,之后的对账也不再订', () => {
    const mine = pub('TR_mine')
    const t = gate({ 'wb-phone-a': [mine] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '挂了')
    t.g.reconcile()
    t.g.reconcile()
    expect(mine.calls).toEqual([true, false])
  })

  it('下一通照样能开:退订过的那条再订回来', () => {
    const mine = pub('TR_mine')
    const t = gate({ 'wb-phone-a': [mine] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '第一通')
    t.g.sync({ listen: false, speaker: 'wb-phone-a' }, '挂了')
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '第二通')
    expect(mine.calls).toEqual([true, false, true])
    expect(t.audio).toEqual([true, false, true])
  })
})

describe('不把工人带走', () => {
  it('SDK 抛了:记一行,下一次对账再试', () => {
    const mine = pub('TR_mine')
    mine.fail = true
    const t = gate({ 'wb-phone-a': [mine] })
    t.g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    expect(t.lines.join('\n')).toContain('订 wb-phone-a 的麦克风没成')
    mine.fail = false
    t.g.reconcile()
    expect(mine.calls).toEqual([true])
  })

  it('框架那一路抛了、火山那一格抛了:照样往下走', () => {
    const mine = pub('TR_mine')
    const lines: string[] = []
    const g = new ListenGate({
      participants: () => [{ identity: 'wb-phone-a', trackPublications: new Map([[mine.sid, mine]]) }],
      isMic: () => true,
      setAudioEnabled: () => { throw new Error('框架抛了') },
      quietAsr: () => { throw new Error('火山抛了') },
      log: line => lines.push(line),
    })
    g.sync({ listen: true, speaker: 'wb-phone-a' }, '接通')
    g.sync({ listen: false, speaker: 'wb-phone-a' }, '挂了')
    expect(mine.calls).toEqual([true, false])
    expect(lines.join('\n')).toContain('收音没打开')
    expect(lines.join('\n')).toContain('收音关了(挂了)')
  })

  it('走了的轨道不再记着(房间一整天不断,这张表只长不缩就是漏)', () => {
    const t = gate({ 'wb-phone-a': [pub('TR_1')] })
    t.g.sync({ listen: false, speaker: undefined }, '起来')
    t.r.participants.delete('wb-phone-a')
    const next = pub('TR_1')
    t.r.add('wb-phone-a', [next])
    t.g.reconcile()
    // 两次对账之间换了个对象、sid 没变:算同一条,不重复说。
    expect(next.calls).toEqual([])
    // 真的走了(有一轮对账里不在)再回来:记的那一笔已经抹掉,算新的一条,照样说一次「不订」。
    t.r.participants.delete('wb-phone-a')
    t.g.reconcile()
    t.r.add('wb-phone-a', [next])
    t.g.reconcile()
    expect(next.calls).toEqual([false])
  })
})

describe('引导那一通也告诉工人「是谁打的」(2026-09-25)', () => {
  it('★ onboarding start / resume 带上发这一条的那一台(身份与种类来自凭证):工人据此只听它', async () => {
    const { handleRpcRequest } = await import('../src/rpc.ts')
    const seen: unknown[] = []
    const port = {
      begin: async (resume: boolean, by?: { identity: string, kind: string }) => { seen.push({ resume, by }); return { ok: true, stage: 'opening' } },
      say: async () => ({ ok: true }),
      stop: async () => {},
    }
    const workbench = {} as Parameters<typeof handleRpcRequest>[1]['workbench']
    await handleRpcRequest({ id: 'a', type: 'onboarding', action: 'start' }, { deviceId: 'dev', workbench, onboarding: port, identity: 'wb-phone-xiaomi', kind: 'phone' })
    await handleRpcRequest({ id: 'b', type: 'onboarding', action: 'resume' }, { deviceId: 'dev', workbench, onboarding: port })
    expect(seen).toEqual([
      { resume: false, by: { identity: 'wb-phone-xiaomi', kind: 'phone' } },
      // 问不出身份(老调用方):不带,退回老行为 —— 不编一个身份去钉接话对象。
      { resume: true, by: undefined },
    ])
  })
})

describe('不是配对过的手机打来引导 / 通话:回同类的 ok:false,别让手机干等(2026-09-25)', () => {
  it('★ 引导、通话回同类答复(老手机包也认,当场收场);别的照旧 http 403', async () => {
    const { notPairedResponse, RPC_NOT_PAIRED_TEXT } = await import('../src/rpc.ts')
    expect(notPairedResponse({ id: 'a', type: 'onboarding', action: 'start' })).toEqual({ id: 'a', type: 'onboarding', ok: false, error: RPC_NOT_PAIRED_TEXT })
    expect(notPairedResponse({ id: 'b', type: 'call', action: 'start' })).toEqual({ id: 'b', type: 'call', ok: false, error: RPC_NOT_PAIRED_TEXT })
    expect(notPairedResponse({ id: 'c', type: 'http', method: 'GET', path: '/state' })).toEqual({ id: 'c', type: 'http', status: 403, body: { error: RPC_NOT_PAIRED_TEXT } })
    expect(notPairedResponse({ id: 'd', type: 'renew' })).toMatchObject({ id: 'd', type: 'http', status: 403 })
  })
})
