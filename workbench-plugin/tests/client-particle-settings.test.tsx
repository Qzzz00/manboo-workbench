import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createParticleSettingsStore } from '../src/client/particleSettingsStore.ts'
import { ParticleSettings } from '../src/client/ParticleSettings.tsx'
import { BuiltinGlyphCache, TUNING_STORAGE_KEY } from '../src/client/swarm/core.js'
const values = new Map<string, string>()
const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, clear: () => values.clear() }
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
it('图标缩略图使用离线SVG源', () => {
  const { container } = render(<ParticleSettings store={createParticleSettingsStore(localStorage)} />)
  expect(decodeURIComponent(container.querySelector('img')!.src)).toContain('<svg')
})
it('电话变体预览必须黄色且保留所选形状', async () => {
  const glyph = new Float32Array([0, 1])
  vi.spyOn(BuiltinGlyphCache.prototype, 'get').mockResolvedValue({ glyph, svg: '<svg/>', warnings: [] })
  const store = createParticleSettingsStore(localStorage)
  await store.selectIcon('phone-call')
  expect(store.getSnapshot().preview).toMatchObject({ mode: 'calling', notice: 'confirmation', glyph })
})
it('沿用旧storage key与preset格式；两个订阅读取同一份完整参数', () => {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 6800, particleGlow: .45, cloudSize: .65, cloudBrightness: 1.6, cloudSpeed: 3 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(localStorage), seen: number[] = []
  const offA = store.subscribe(() => seen.push(store.getSnapshot().preset.settings.count!)), offB = store.subscribe(() => seen.push(store.getSnapshot().preset.settings.count!))
  expect(store.getSnapshot().preset.settings.cloudBrightness).toBe(1.6)
  store.setField('count', 7000)
  expect(seen).toEqual([7000, 7000])
  expect(JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY)!).settings.cloudSpeed).toBe(3)
  offA(); offB()
})
it('异步文件晚返回不能覆盖更新调参；恶意SVG被拒绝并保留上一份设置', async () => {
  const store = createParticleSettingsStore(localStorage)
  let finish!: (s: string) => void
  const loading = store.importText(() => new Promise<string>(resolve => { finish = resolve }), 'json')
  store.setField('count', 6800)
  finish(JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 500 } }))
  await loading
  expect(store.getSnapshot().preset.settings.count).toBe(6800)
  await store.importText(async () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'svg')
  expect(store.getSnapshot().error).toBeTruthy()
  expect(store.getSnapshot().preset.settings.count).toBe(6800)
})
it('全部24项数值+滑杆可达，电话入口只有黄/红动效预览', async () => {
  const user = userEvent.setup(), store = createParticleSettingsStore(localStorage)
  render(<ParticleSettings store={store} />)
  expect(screen.getAllByRole('slider')).toHaveLength(24)
  expect(screen.getAllByRole('spinbutton')).toHaveLength(24)
  await user.click(screen.getByRole('button', { name: '说话动效预览' }))
  expect(store.getSnapshot().preview?.mode).toBe('speaking')
  await user.click(screen.getByRole('button', { name: '关闭动效预览' }))
  expect(store.getSnapshot().preview).toBeUndefined()
  expect(screen.getByRole('button', { name: '黄色电话动效预览' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '红色电话动效预览' })).toBeInTheDocument()
})
it('性能模式单独持久化、锁最低档;降档只改有效值并在设置里显示「当前画质」', async () => {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 6800 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(localStorage)
  expect(store.getSnapshot().quality).toEqual({ tier: 0, performanceMode: false })
  expect(store.effectiveSettings().count).toBe(6800)
  // 运行时降档:用户参数不改写,storage 里的 preset 原样
  store.reportTier(1)
  expect(store.getSnapshot().quality.tier).toBe(1)
  expect(store.effectiveSettings().count).toBe(3400)
  expect(store.getSnapshot().preset.settings.count).toBe(6800)
  expect(JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY)!).settings.count).toBe(6800)
  // 重新调参回到完整档重新评估
  store.setField('particleSize', 1.2)
  expect(store.getSnapshot().quality.tier).toBe(0)
  const user = userEvent.setup()
  render(<ParticleSettings store={store} />)
  expect(screen.getByText(/当前画质/)).toHaveTextContent('完整(6800 颗)')
  await user.click(screen.getByRole('checkbox', { name: '性能模式' }))
  expect(store.getSnapshot().quality).toEqual({ tier: 4, performanceMode: true })
  expect(store.effectiveSettings()).toMatchObject({ count: 1700, particleGlow: 0 })
  expect(screen.getByText(/当前画质/)).toHaveTextContent('性能模式:1700 颗 · 柔光关 · 光团减半')
  expect(JSON.parse(localStorage.getItem('butler-swarm-v4:quality')!)).toEqual({ performanceMode: true })
  expect(JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY)!).settings.count).toBe(6800)
  // 锁定期间采样上报不生效
  store.reportTier(2)
  expect(store.getSnapshot().quality.tier).toBe(4)
  await user.click(screen.getByRole('checkbox', { name: '性能模式' }))
  expect(store.getSnapshot().quality).toEqual({ tier: 0, performanceMode: false })
  // 重新打开时读回性能模式
  localStorage.setItem('butler-swarm-v4:quality', JSON.stringify({ performanceMode: true }))
  expect(createParticleSettingsStore(localStorage).getSnapshot().quality).toEqual({ tier: 4, performanceMode: true })
})
it('「恢复完整画质」按钮:降档后按一下立刻回到用户参数并重置评估;性能模式下按一下也解除', async () => {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 4000 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(localStorage)
  const user = userEvent.setup()
  render(<ParticleSettings store={store} />)
  // 已经是完整画质时不摆这颗按钮
  expect(screen.queryByRole('button', { name: '恢复完整画质' })).toBeNull()
  act(() => { store.reportTier(3) })
  expect(screen.getByText(/当前画质/)).toHaveTextContent('自动降到 2000 颗 · 柔光关 · 光团减半')
  await user.click(screen.getByRole('button', { name: '恢复完整画质' }))
  expect(store.getSnapshot().quality).toEqual({ tier: 0, performanceMode: false })
  expect(store.effectiveSettings().count).toBe(4000)
  expect(screen.getByText(/当前画质/)).toHaveTextContent('完整(4000 颗)')
  expect(screen.queryByRole('button', { name: '恢复完整画质' })).toBeNull()
  // 性能模式锁着也能一键回全,并且记住「不锁了」
  await user.click(screen.getByRole('checkbox', { name: '性能模式' }))
  await user.click(screen.getByRole('button', { name: '恢复完整画质' }))
  expect(store.getSnapshot().quality).toEqual({ tier: 0, performanceMode: false })
  expect(JSON.parse(localStorage.getItem('butler-swarm-v4:quality')!)).toEqual({ performanceMode: false })
  expect(JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY)!).settings.count).toBe(4000)
})
