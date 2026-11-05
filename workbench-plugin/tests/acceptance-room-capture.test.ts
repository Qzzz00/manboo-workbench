import { describe, expect, it, vi } from 'vitest'
import { capturedRoomTextHandler } from '../dev/acceptance-three-entrances/roomCapture.ts'

describe('real-room capture forwarding', () => {
  it('reads a real text reader once and forwards the exact message despite capture failure', async () => {
    const raw = '{"type":"say_decision","say":{"screen":"原样"}}'
    const readAll = vi.fn(async () => raw)
    let forwarded = ''
    const handler = capturedRoomTextHandler(async reader => { forwarded = await reader.readAll() }, () => { throw new Error('artifact disk unavailable') })
    await handler({ readAll }, { identity: 'wb-channel-worker' })
    expect(forwarded).toBe(raw)
    expect(readAll).toHaveBeenCalledTimes(1)
  })
  it('preserves arrival order when the first actual stream finishes later', async () => {
    let release!: (text: string) => void
    const first = new Promise<string>(resolve => { release = resolve })
    const delivered: string[] = []
    const handler = capturedRoomTextHandler(async reader => { delivered.push(await reader.readAll()) }, () => {})
    const one = handler({ readAll: () => first }, { identity: 'wb-channel-worker' })
    const two = handler({ readAll: async () => 'second' }, { identity: 'wb-channel-worker' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(delivered).toEqual([])
    release('first')
    await Promise.all([one, two])
    expect(delivered).toEqual(['first', 'second'])
  })

})
