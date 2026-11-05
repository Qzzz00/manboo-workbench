/** Capture actual SDK stream bytes without replacing or consuming the downstream message. */
export function capturedRoomTextHandler<R extends { readAll(): Promise<string> }, P>(
  handler: (reader: R, from: P) => void | Promise<void>,
  capture: (text: string, from: P) => void,
): (reader: R, from: P) => Promise<void> {
  let queue = Promise.resolve()
  return (reader, from) => {
    const delivered = queue.then(async () => {
      const text = await reader.readAll()
      try { capture(text, from) } catch { /* Evidence storage cannot change room delivery. */ }
      const forwarded = Object.create(reader) as R
      forwarded.readAll = async () => text
      await handler(forwarded, from)
    })
    queue = delivered.catch(() => {})
    return delivered
  }
}
