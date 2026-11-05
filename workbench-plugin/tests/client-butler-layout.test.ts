import { describe, expect, it } from 'vitest'
import { arrangeButlerTasks, butlerConnector } from '../src/client/butlerLayout.ts'

describe.each([[340, 520], [620, 540], [900, 380], [1400, 520]])('环绕舞台 %s×%s', (width, height) => {
  it.each([0, 1, 2, 3, 4, 5, 6])('%s件不越界、不重叠，也不压住球体', count => {
    const { cards, orb } = arrangeButlerTasks(width, height, count)
    expect(cards).toHaveLength(count)
    for (const [i, a] of cards.entries()) {
      expect(a.x).toBeGreaterThanOrEqual(0)
      expect(a.y).toBeGreaterThanOrEqual(0)
      expect(a.x + a.w).toBeLessThanOrEqual(width)
      expect(a.y + a.h).toBeLessThanOrEqual(height)
      const nearX = Math.max(a.x, Math.min(a.x + a.w, orb.x))
      const nearY = Math.max(a.y, Math.min(a.y + a.h, orb.y))
      expect(Math.hypot(nearX - orb.x, nearY - orb.y)).toBeGreaterThan(orb.r)
      for (const b of cards.slice(i + 1)) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      const line = butlerConnector(a, orb)
      expect(Math.hypot(line.end.x - orb.x, line.end.y - orb.y)).toBeCloseTo(orb.r)
      expect(line.start.x >= a.x - .01 && line.start.x <= a.x + a.w + .01).toBe(true)
      expect(line.start.y >= a.y - .01 && line.start.y <= a.y + a.h + .01).toBe(true)
    }
  })
})

it('竖屏三件从左至右且在球下，六件分上下，不从侧栏绕线', () => {
  const three = arrangeButlerTasks(620, 540, 3)
  expect(three.cards.map(c => c.x)).toEqual([...three.cards.map(c => c.x)].sort((a, b) => a - b))
  expect(three.cards.every(c => c.y > three.orb.y + three.orb.r)).toBe(true)
  const six = arrangeButlerTasks(620, 540, 6)
  expect(six.cards.slice(0, 3).every(c => c.y + c.h < six.orb.y - six.orb.r)).toBe(true)
  expect(six.cards.slice(3).every(c => c.y > six.orb.y + six.orb.r)).toBe(true)
  expect(butlerConnector(three.cards[0]!, three.orb).path).not.toContain(' L ')
})
