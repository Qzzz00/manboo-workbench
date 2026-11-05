/**
 * 发布计划的月历要标出今天(2026-09-28,卡 FB —— 维护者在新 Air 上:
 * 「发布计划那里没有标记今天是哪一天,这个不方便」)。
 *
 * 钉四件事:
 *   ① 今天那一格标出来(描边 + 日期加粗 + 可访问名里念得出「今天」);
 *   ② **跟着电脑日期走、过零点自动换** —— 这一格不读时钟,`now` 换一天标记就跟着挪;
 *   ③ 翻到别的月份时,本月的今天不会在补出来的邻月格子里再亮一次;
 *   ④ 「今天」那两个字念得出来(不只靠颜色)。
 *
 * ★ 2026-10-03:这一格的组件本体换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/publish/index.js`)。她那一格的日期格上**没有 `data-date`**(按
 * `aria-label` 认人)、日期加粗写在她那份行内 CSS 里(`.cp-day[data-today=true]`),
 * 所以取格子的办法与「加粗」那一条跟着改;①②③④ 四件事本身一个都没少。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const PublishModule = starterWidget('publish')


afterEach(cleanup)

const BOX = {
  id: 'publish',
  title: '发布计划',
  basisPct: 30,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

function paint(now: string) {
  return render(
    <PublishModule
      box={BOX}
      header={<h3 id="pub">发布计划</h3>}
      headingId="pub"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={(async () => new Response('{}')) as unknown as typeof fetch}
      tasks={[]}
      now={now}
    />,
  )
}

/** 2026-09-28 那天中午(**本地**时间;月历一律按本地日期拼,写死 UTC 会让这组用例在别的时区里错一天)。 */
const NOON_0928 = new Date(2026, 8, 28, 12, 0).toISOString()

/** 那一格按钮(她那一格按 `aria-label` 认人:`2026-09-28,…`)。 */
function cell(date: string): HTMLElement {
  const found = [...document.querySelectorAll('.cp-day')]
    .find(node => (node.getAttribute('aria-label') ?? '').startsWith(date))
  if (found === undefined) throw new Error(`月历上没有 ${date} 这一格`)
  return found as HTMLElement
}

describe('月历上的今天', () => {
  it('今天那一格标着 data-today,别的日子一格都没标', () => {
    paint(NOON_0928)
    expect(cell('2026-09-28')).toHaveAttribute('data-today', 'true')
    expect(cell('2026-09-27')).toHaveAttribute('data-today', 'false')
    const marked = document.querySelectorAll('.cp-day[data-today="true"]')
    expect(marked.length).toBe(1)
  })

  it('日期那几个字加粗(不只靠颜色),可访问名里念得出「今天」', () => {
    paint(NOON_0928)
    // 她那一格把「今天」写在格子里那一行小字上,加粗 / 描边写在她那份行内 CSS 里。
    expect(cell('2026-09-28').textContent).toContain('今天')
    expect([...document.querySelectorAll('style')].map(node => node.textContent ?? '').join('\n'))
      .toContain('.cp-day[data-today=true]')
    expect(screen.getByLabelText(/^2026-09-28，今天/)).toBeInTheDocument()
  })

  it('过零点自动换:`now` 跨到第二天,标记跟着挪(这一格不读时钟)', () => {
    // **本地**零点前一分钟与零点后一分钟各渲染一次 —— 用 new Date(y,m,d,h,m) 造,
    // 这样这条用例在任何时区下问的都是同一件事(仓库里的月历一律按本地日期拼,见 client/dates.ts)。
    const before = new Date(2026, 8, 28, 23, 59).toISOString()
    const after = new Date(2026, 8, 29, 0, 1).toISOString()
    paint(before)
    expect(cell('2026-09-28')).toHaveAttribute('data-today', 'true')
    cleanup()
    paint(after)
    expect(cell('2026-09-29')).toHaveAttribute('data-today', 'true')
    expect(cell('2026-09-28')).toHaveAttribute('data-today', 'false')
  })

  it('日期读不出来就一格都不标(不知道今天是哪天就不猜)', () => {
    paint('读不出来')
    expect(document.querySelectorAll('.cp-day[data-today="true"]').length).toBe(0)
  })
})
