/**
 * useAppearanceSync 钩子(ButlerInbox 接的那一行):挂载即拉一次;/state.appearance_version 变了才再拉;
 * 同一 baseUrl 只起一份同步(普通模式与纯净模式各一个 ButlerInbox 共用一个 store)。
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppearanceSync } from '../src/client/appearanceSync.ts'
import { createParticleSettingsStore } from '../src/client/particleSettingsStore.ts'
import { TUNING_DEFAULTS, TUNING_STORAGE_KEY } from '../src/client/swarm/core.js'

afterEach(() => { cleanup() })

const preset = (count: number) => ({ kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS, count }, svg: '', fill: false })

it('挂载拉一次;appearance_version 变了重新拉并覆盖本地;两个订阅者共用一份同步', async () => {
  const map = new Map<string, string>()
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
  storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
  const store = createParticleSettingsStore(storage)
  let doc = { version: 1, preset: preset(6800), updated_at: 't' }
  const gets: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') return new Response('{}', { status: 405 })
    gets.push(String(input))
    return new Response(JSON.stringify(doc), { status: 200 })
  }) as typeof fetch
  const baseUrl = 'http://127.0.0.1:1' // 每个用例一个地址:getAppearanceSync 按 baseUrl 复用
  function Probe({ version }: { version: number | undefined }) {
    useAppearanceSync({ store, baseUrl, fetchImpl, storage }, version)
    return null
  }
  const view = render(<><Probe version={undefined} /><Probe version={undefined} /></>)
  await act(async () => { await Promise.resolve() })
  expect(gets).toEqual([`${baseUrl}/butler/appearance`])
  // 快照推来同一版本:不拉。
  view.rerender(<><Probe version={1} /><Probe version={1} /></>)
  await act(async () => { await Promise.resolve() })
  expect(gets).toHaveLength(1)
  // 别处 PUT 了版本 2:拉,覆盖本地,提示。
  doc = { version: 2, preset: preset(500), updated_at: 't' }
  view.rerender(<><Probe version={2} /><Probe version={2} /></>)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await vi.waitFor(() => { expect(store.getSnapshot().preset.settings.count).toBe(500) })
  expect(gets).toHaveLength(2)
  expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 500 } })
  expect(store.getSnapshot().message).toBe('已改用 Mac 上保存的外观(版本 2)')
})
