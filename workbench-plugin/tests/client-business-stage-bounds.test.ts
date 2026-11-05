import { expect, it } from 'vitest'
import { arrangeButlerTasks } from '../src/client/butlerLayout.ts'
it.each([[480,180,2],[480,220,2],[480,240,3]])('窄窗口 %sx%s 的执行卡不能溢到球下状态行', (width,height,count) => {
  const layout = arrangeButlerTasks(width,height,count)
  for (const card of layout.cards) expect(card.y + card.h).toBeLessThanOrEqual(height)
})
