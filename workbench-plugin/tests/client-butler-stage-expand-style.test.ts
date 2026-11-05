// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUTLER_LAYOUT_STYLE } from '../src/client/butlerLayoutStyle.ts'

/**
 * 2026-09-26 晚(统筹,维护者截图:「为什么我的事务官页面变成这个死样子了」)。
 * 卡 ST 在每张会话卡上加了一颗「展开」小键,它也是 `<li>` 里的一个 `<button>`,于是
 * `.ben-wb__task-constellation button{width:100%;height:100%;padding:13px 16px;background:…}` 那条卡面样式
 * (特异性 0,1,1)压过了 `.ben-wb__task-expand`(0,1,0):小键长成一整张卡那么大、带底色,
 * 盖在卡的内容上,台上只剩一排「展开」。小键的样式必须**至少同样具体**,并把卡面那几样撤掉。
 */
function rulesFor(selector: string): string[] {
  const out: string[] = []
  for (const match of BUTLER_LAYOUT_STYLE.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map(one => one.trim())
    if (selectors.includes(selector)) out.push(match[2]!)
  }
  return out
}

describe('会话卡上的「展开」小键不许长成一整张卡', () => {
  it('有一条比卡面按钮样式更具体的规则,把宽高、底色、阴影撤回小键自己的', () => {
    const body = rulesFor('.ben-wb__task-constellation li>.ben-wb__task-expand').join(';')
    expect(body).toMatch(/width:auto/)
    expect(body).toMatch(/height:auto/)
    expect(body).toMatch(/box-shadow:none/)
    expect(body).toMatch(/position:absolute/)
  })

  it('悬停 / 选中那条卡面样式也不套到小键上', () => {
    const body = rulesFor('.ben-wb__task-constellation li>.ben-wb__task-expand:hover').join(';')
    expect(body).toMatch(/box-shadow:none/)
  })
})
