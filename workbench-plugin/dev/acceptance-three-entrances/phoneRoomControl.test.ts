// @vitest-environment node
import { expect, it } from 'vitest'
import { nativePhoneRoomSdk } from './fakePhone.ts'

it('opt-in QA receives the actual native room handle for a real disconnect, without creating a room event', async () => {
  const packets: string[] = []
  const rooms: { disconnect(): Promise<void> }[] = []
  const sdk = nativePhoneRoomSdk((_direction, text) => packets.push(text), room => rooms.push(room))
  const room = new sdk.Room()
  expect(rooms).toEqual([room])
  expect(packets).toEqual([])
  await room.disconnect()
})
