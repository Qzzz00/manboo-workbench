import { describe, expect, it } from 'vitest'
import { instanceServicePorts, resolveQaPorts } from '../dev/collab-a-acceptance/qa-ports.mts'

describe('collab acceptance isolated port group', () => {
  it('keeps the existing port group when the environment is unset', () => {
    expect(resolveQaPorts(undefined)).toEqual({
      dsh: 3193,
      workbench: 8993,
      module: 8994,
      butler: 8992,
      connector: 8996,
      textTurn: 8997,
      model: 19893,
      livekit: 19994,
      rtcTcp: 19995,
      rtcUdp: 19996,
    })
  })

  it('accepts one complete private group for an isolated run', () => {
    expect(resolveQaPorts(JSON.stringify({
      dsh: 3893,
      workbench: 9693,
      module: 9694,
      butler: 9692,
      connector: 9696,
      textTurn: 9697,
      model: 29693,
      livekit: 29694,
      rtcTcp: 29695,
      rtcUdp: 29696,
    }))).toEqual({
      dsh: 3893,
      workbench: 9693,
      module: 9694,
      butler: 9692,
      connector: 9696,
      textTurn: 9697,
      model: 29693,
      livekit: 29694,
      rtcTcp: 29695,
      rtcUdp: 29696,
    })
  })

  it('checks only ports opened by the DSH instance, leaving stub and LiveKit to serve.mts', () => {
    const ports = resolveQaPorts(undefined)
    expect(instanceServicePorts(ports)).toEqual({
      dsh: 3193,
      workbench: 8993,
      module: 8994,
      butler: 8992,
      connector: 8996,
      textTurn: 8997,
    })
  })

  it.each([
    ['duplicate ports', { dsh: 3893, workbench: 3893 }],
    ['out of range ports', { dsh: 65536 }],
    ['non-numeric ports', { dsh: '3893' }],
    ['unknown keys', { unrelated: 3893 }],
  ])('rejects %s before starting processes', (_case, config) => {
    expect(() => resolveQaPorts(JSON.stringify(config))).toThrow()
  })
})
