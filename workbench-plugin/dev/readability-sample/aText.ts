/**
 * 样张 A 里「字改短」那几处(规矩第三节 6–8 条)。只给样张页用:真接线时改的是各格 JSX 里的那一句,
 * 这里在渲染之后把文字节点换掉,好让截图先看到效果。编号对应审计表(docs/交接-1021-工作台可读性/审计.md)。
 */
const RULES: readonly (readonly [RegExp, string])[] = [
  [/^总吞吐[((]含缓存读[))]$/, '总吞吐'], // #21
  [/^总消耗[((]入\+缓存写\+出[))]/, '总消耗'], // #22
  [/^开发一个小工具$/, '做个小工具'], // #3
  [/ · 记录$/, ''], // #33
  [/^一格 = 一成 · .*$/, '一格 = 一成'], // #39
  [/^一段 = 一家 · .*$/, '一段 = 一家'], // #40
  [/^一格 = 一天 · .*$/, '一格 = 一天'], // #41
  [/^说明$/, '?'], // #27(只在悬停那一行露)
]

function rewrite(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const trimmed = text.trim()
    if (trimmed === '') continue
    for (const [pattern, to] of RULES) {
      if (pattern.test(trimmed)) {
        const next = trimmed.replace(pattern, to)
        if (next !== trimmed) node.textContent = text.replace(trimmed, next)
        break
      }
    }
  }
}

export function applyAText(): void {
  // 夹具总带着模板;/state 回来之前根上还没有 data-template,那时一个字都不换(否则自媒体布局也被换掉)。
  const run = (): void => { document.querySelectorAll('.ben-wb[data-template]:not([data-template=ops])').forEach(rewrite) }
  run()
  new MutationObserver(run).observe(document.body, { subtree: true, childList: true, characterData: true })
}
