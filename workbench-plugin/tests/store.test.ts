import { describe, expect, it } from 'vitest'
import { createWorkbenchStore } from '../src/client/store.ts'

describe('createWorkbenchStore', () => {
  it('opens by default and supports the close-reopen round trip', () => {
    const store = createWorkbenchStore().create()

    expect(store.getSnapshot().open).toBe(true)
    store.actions.close()
    expect(store.getSnapshot().open).toBe(false)
    store.actions.open()
    expect(store.getSnapshot().open).toBe(true)
  })

  it('keeps a failed project opening visible as an actionable error', () => {
    const store = createWorkbenchStore().create()

    store.actions.startOpening('aiboo')
    expect(store.getSnapshot()).toMatchObject({ openingProjectId: 'aiboo', error: null })
    store.actions.failOpening('无法进入 Aiboo')
    expect(store.getSnapshot()).toMatchObject({
      open: true,
      openingProjectId: null,
      error: '无法进入 Aiboo',
    })
  })
})
