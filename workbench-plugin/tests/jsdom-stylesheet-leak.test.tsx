/**
 * jsdom 样式表泄漏补丁(tests/setup/jsdomStyleSheetLeak.ts)的用例。
 * 第一条是**复现**:它哪天红了,就是 jsdom 修好了,补丁可以整套删掉(见补丁文件头注释)。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeLeakedStyleSheets } from './setup/jsdomStyleSheetLeak.ts'

afterEach(cleanup)

/** 造一棵 `div > style` 子树挂到 body 再整棵摘掉——工作台 `<style>{STYLE}</style>` 嵌在 `.ben-wb` 里就是这个形态。 */
function mountAndRemoveNestedStyle(css: string): HTMLStyleElement {
  const wrapper = document.createElement('div')
  const style = document.createElement('style')
  style.textContent = css
  wrapper.appendChild(style)
  document.body.appendChild(wrapper)
  document.body.removeChild(wrapper)
  return style
}

describe('jsdom 29.1.1 的漏(复现;红了 = jsdom 修了 = 补丁可删)', () => {
  it('嵌在子树里的 <style> 随子树摘掉后,document.styleSheets 里那张表还在、ownerNode 已不在树上', () => {
    const before = document.styleSheets.length
    const style = mountAndRemoveNestedStyle('a{color:red}')
    expect(document.styleSheets.length).toBe(before + 1)
    const leaked = Array.from(document.styleSheets).find(sheet => sheet.ownerNode === style)
    expect(leaked).toBeDefined()
    expect(style.isConnected).toBe(false)
    purgeLeakedStyleSheets() // 别把自己造的孤儿留给下一条
  })

  it('对照:<style> 是 body 直系子节点时摘掉不漏(所以补丁走"重挂成直系子节点再摘"这条路)', () => {
    const before = document.styleSheets.length
    const style = document.createElement('style')
    style.textContent = 'b{color:red}'
    document.body.appendChild(style)
    expect(document.styleSheets.length).toBe(before + 1)
    document.body.removeChild(style)
    expect(document.styleSheets.length).toBe(before)
  })
})

describe('purgeLeakedStyleSheets', () => {
  it('清掉全部孤儿表、返回张数;还连在树上的表一张不动', () => {
    const kept = document.createElement('style')
    kept.textContent = 'k{color:red}'
    document.body.appendChild(kept)
    mountAndRemoveNestedStyle('a{}')
    mountAndRemoveNestedStyle('b{}')
    const before = document.styleSheets.length

    expect(purgeLeakedStyleSheets()).toBe(2)
    expect(document.styleSheets.length).toBe(before - 2)
    expect(Array.from(document.styleSheets).some(sheet => sheet.ownerNode === kept)).toBe(true)
    expect(purgeLeakedStyleSheets()).toBe(0) // 幂等:没孤儿就什么都不做
    document.body.removeChild(kept)
  })

  it('React 组件里的 <style> 经 Testing Library cleanup 卸载后也是这种孤儿,一样清得掉', () => {
    const before = document.styleSheets.length
    render(<div><style>{'c{color:red}'}</style><p>内容</p></div>)
    expect(document.styleSheets.length).toBe(before + 1)
    cleanup()
    expect(document.styleSheets.length).toBe(before + 1) // 漏了
    expect(purgeLeakedStyleSheets()).toBe(1)
    expect(document.styleSheets.length).toBe(before)
  })
})

describe('setupFiles 里的钩子真的在生效(跨用例)', () => {
  // 这两条靠顺序:上一条故意留孤儿不清,下一条开头必须是干净的。
  it('留一张孤儿给下一条', () => {
    render(<div><style>{'d{color:red}'}</style></div>)
    // 不手动 purge;cleanup 由文件顶部的 afterEach 做,孤儿留给 setup 钩子。
  })
  it('上一条留下的孤儿到这里已经被清掉', () => {
    expect(document.styleSheets.length).toBe(0)
  })
})
