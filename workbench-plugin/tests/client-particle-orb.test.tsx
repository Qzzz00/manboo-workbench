import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ParticleLoop } from '../src/client/particleScene.ts'
import { ParticleOrb } from '../src/client/ParticleOrb.tsx'
import { PARTICLE_STYLE } from '../src/client/particleStyle.ts'
import { TUNING_DEFAULTS, TUNING_FIELDS, listBuiltinIcons } from '../src/client/swarm/core.js'
afterEach(cleanup)
it('canvas脱离grid固有尺寸，并以真实orb容器宽高布局，而不是裁切480px大画布', () => {
  const rule = PARTICLE_STYLE.match(/\.ben-wb__particle-orb canvas\{([^}]+)\}/)?.[1] ?? ''
  expect(rule).toContain('position:absolute')
  expect(rule).toContain('inset:0')
  expect(rule).toContain('width:100%')
  expect(rule).toContain('height:100%')
  expect(rule).toContain('min-width:0')
  expect(rule).toContain('min-height:0')
})
it('默认浏览器RAF以window作为receiver调用，不能把ParticleLoop当作this', () => {
  vi.stubGlobal('requestAnimationFrame', function (this: unknown) { expect(this).toBe(window); return 42 })
  vi.stubGlobal('cancelAnimationFrame', function (this: unknown, id: number) { expect(this).toBe(window); expect(id).toBe(42) })
  try { const loop = new ParticleLoop(() => {}); loop.update(true, false); loop.dispose() }
  finally { vi.unstubAllGlobals() }
})
it('隐藏取消RAF，恢复首帧dt为0，reduced-motion只静态绘制，销毁不再重启', () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0
  const draw = vi.fn(), cancel = vi.fn((id: number) => frames.delete(id))
  const loop = new ParticleLoop(draw, cb => { frames.set(++next, cb); return next }, cancel)
  loop.update(true, false)
  frames.get(1)!(1000)
  expect(draw).toHaveBeenLastCalledWith(0, false)
  loop.update(false, false)
  expect(cancel).toHaveBeenCalledWith(2)
  loop.update(true, false)
  frames.get(3)!(999999)
  expect(draw).toHaveBeenLastCalledWith(0, false)
  loop.update(true, true)
  expect(draw).toHaveBeenLastCalledWith(0, true)
  const count = next
  loop.dispose(); loop.update(true, false)
  expect(next).toBe(count)
})
it('canvas缺失时旧Orb降级而不是让整树报错', () => {
  render(<ParticleOrb mode="idle" notice="neutral" visible settings={TUNING_DEFAULTS} />)
  expect(screen.getByRole('img', { name: '事务官:待命' })).toBeInTheDocument()
})
it('静态模块保留24字段、完整120图标且查询不采样', () => {
  expect(TUNING_FIELDS).toHaveLength(24)
  expect(listBuiltinIcons()).toHaveLength(120)
  expect(listBuiltinIcons('电话').some(icon => icon.id === 'phone')).toBe(true)
})
