import { describe, expect, it } from 'vitest'
import { resolvePhoneAcceptancePorts, assertPhoneAcceptanceAttachment, resolvePhoneAcceptanceWorkerDir } from '../dev/acceptance-three-entrances/phonePorts.ts'

describe('phone acceptance isolated port configuration', () => {
  it('keeps the original default group', () => {
    expect(resolvePhoneAcceptancePorts()).toEqual({ dsh: 3093, workbench: 8893, module: 8894, butler: 8892, connector: 8896, textTurn: 8897 })
  })
  it('uses only an explicit independent group', () => {
    const own = { dsh: 3893, workbench: 9693, module: 9694, butler: 9692, connector: 9696, textTurn: 9697 }
    expect(resolvePhoneAcceptancePorts(JSON.stringify(own))).toEqual(own)
    expect(() => resolvePhoneAcceptancePorts(JSON.stringify({ ...own, textTurn: 9693 }))).toThrow(/重复/)
    expect(() => resolvePhoneAcceptancePorts('{"dsh":8791}')).toThrow(/完整/)
    expect(() => resolvePhoneAcceptancePorts(JSON.stringify({ ...own, dsh: 70000 }))).toThrow(/端口/)
  })
  it('rejects an attached profile with a different root or port group before mutation', () => {
    const own = resolvePhoneAcceptancePorts('{"dsh":3893,"workbench":9693,"module":9694,"butler":9692,"connector":9696,"textTurn":9697}')
    const saved = { root: '/tmp/own-room', base: 'http://127.0.0.1:9693', ports: own }
    expect(() => assertPhoneAcceptanceAttachment(saved, '/tmp/own-room', own)).not.toThrow()
    expect(() => assertPhoneAcceptanceAttachment(saved, '/tmp/other-room', own)).toThrow(/profile/)
    expect(() => assertPhoneAcceptanceAttachment(saved, '/tmp/own-room', resolvePhoneAcceptancePorts())).toThrow(/port/)
    expect(() => assertPhoneAcceptanceAttachment({ ...saved, ports: undefined }, '/tmp/own-room', own)).toThrow(/port/)
  })

  it('defaults to this tree and only accepts an explicit absolute worker source reference', () => {
    expect(resolvePhoneAcceptanceWorkerDir('/tmp/consumer')).toBe('/tmp/consumer/channel-worker')
    expect(resolvePhoneAcceptanceWorkerDir('/tmp/consumer', '/tmp/producer/channel-worker')).toBe('/tmp/producer/channel-worker')
    expect(() => resolvePhoneAcceptanceWorkerDir('/tmp/consumer', '../other')).toThrow(/absolute/)
  })

})

it('leaves replay off by default and only enables it in the controlled text-turn profile', async () => {
  const { phoneRoomReplayEnvironment } = await import('../dev/acceptance-three-entrances/phonePorts.ts')
  expect(phoneRoomReplayEnvironment('/tmp/own-room', true)).toEqual({})
  expect(phoneRoomReplayEnvironment('/tmp/own-room', true, '1')).toEqual({ WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '1', WB_FIXTURE_CAPTURE_ROOT: '/tmp/own-room', NODE_OPTIONS: expect.stringContaining('/roomReplayQaEnvironment.mts') })
  expect(() => phoneRoomReplayEnvironment('/tmp/own-room', false, '1')).toThrow(/text/)
  expect(() => phoneRoomReplayEnvironment('relative', true, '1')).toThrow(/absolute/)
})

it('isolates the QA text listener to LAN without changing normal workers or an uncontrolled HOME', async () => {
  const { isolateRoomReplayQaTextTurn } = await import('../dev/acceptance-three-entrances/phonePorts.ts')
  const base = { HOME: '/tmp/room/iso/home', WB_FIXTURE_CAPTURE_ROOT: '/tmp/room', WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '1', WORKBENCH_CHANNEL_WORKER_ROUTE: 'relay', WORKBENCH_CHANNEL_TEXT_TURN: '1' }
  const relay = { ...base }; isolateRoomReplayQaTextTurn(relay); expect(relay.WORKBENCH_CHANNEL_TEXT_TURN).toBe('0')
  for (const env of [{ ...base, WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '0' }, { ...base, WORKBENCH_CHANNEL_WORKER_ROUTE: 'lan' }, { ...base, HOME: '/tmp/other' }]) {
    const before = { ...env }; isolateRoomReplayQaTextTurn(env); expect(env).toEqual(before)
  }
})
