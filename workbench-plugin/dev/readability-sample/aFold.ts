/**
 * 样张 A / B 里「拿不到数的行收成一行计数」(规矩第三节第 10 条;统筹 10-21 转来维护者那一幕:
 * 余额 / 额度里 Muse、豆包办公、Manus、Grok Bot 四行各占一整行、条是空的,右边一句「读不到最新的,上次 10-03 22:52」,
 * 「这些读不到的要么挪到最底下,要么去掉,这就是我说的非必要」)。
 *
 * 只给样张页用:渲染之后给那几行打记号、在格子末尾插一行计数,点开才露原来那几行。真接线时这是
 * `QuotaPanel.tsx` / `AgentQuotaCells.tsx` / `UsagePanel.tsx` 里按模板分叉的 JSX(一个 `<details>`),不是改 DOM。
 * 不删:删了他不知道这几家还在名单里。
 */
const SCOPE = '.ben-wb[data-template]:not([data-template=ops])'

interface Kind { key: string, words: (n: number) => string, match: (row: Element) => boolean }
const QUOTA_KINDS: readonly Kind[] = [
  { key: 'stale', words: n => `${n} 家读不到`, match: row => row.getAttribute('data-stale') === 'true' },
  { key: 'unconnected', words: n => `${n} 家没接上`, match: row => row.getAttribute('data-state') === 'unconnected' || row.matches('[class*=unlock]') },
]

function foldLine(list: Element, kind: string, text: string): void {
  let line = list.querySelector<HTMLButtonElement>(`:scope > .rs-foldline[data-kind=${kind}]`)
  if (line === null) {
    line = document.createElement('button')
    line.type = 'button'
    line.className = 'rs-foldline'
    line.dataset.kind = kind
    line.addEventListener('click', () => {
      const open = list.getAttribute(`data-rs-open-${kind}`) === 'true'
      list.setAttribute(`data-rs-open-${kind}`, open ? 'false' : 'true')
      const self = list.querySelector(`:scope > .rs-foldline[data-kind=${kind}]`)
      if (self !== null) self.textContent = (self.textContent ?? '').replace(/[▸▾]$/, open ? '▸' : '▾')
    })
    list.appendChild(line)
  }
  const open = list.getAttribute(`data-rs-open-${kind}`) === 'true'
  const want = `${text} ${open ? '▾' : '▸'}`
  if (line.textContent !== want) line.textContent = want
}

/** 点开之后每家只说「上次几时」——「读不到」那三个字计数那一行已经说过了。 */
function lastSeenOnly(row: Element): void {
  const right = row.querySelector('.ben-wb__usage-qpct')
  const text = right?.firstChild
  if (text?.nodeType !== Node.TEXT_NODE) return
  const next = (text.textContent ?? '').replace(/^读不到最新的,/, '')
  if (next !== text.textContent) text.textContent = next
}

function foldQuota(list: Element): void {
  for (const kind of QUOTA_KINDS) {
    const rows = [...list.children].filter(row => !row.classList.contains('rs-foldline') && kind.match(row))
    rows.forEach(row => row.setAttribute('data-rs-fold', kind.key))
    if (kind.key === 'stale') rows.forEach(lastSeenOnly)
    if (rows.length === 0) continue
    const names = rows.map(row => row.getAttribute('aria-label') ?? '').filter(Boolean).join('、')
    foldLine(list, kind.key, `${kind.words(rows.length)}:${names}`)
  }
}

/** 消耗数据「没有用量来源」那一组:组名 + 每家一格 + 一句解释 → 一行「1 家没有用量记录:豆包办公 ▸」。 */
function foldUnwired(group: Element): void {
  const names = [...group.querySelectorAll('.ben-wb__usage-tile-l')].map(one => one.textContent ?? '').filter(Boolean)
  if (names.length === 0) return
  group.setAttribute('data-rs-folded', 'true')
  foldLine(group, 'unwired', `${names.length} 家没有用量记录:${names.join('、')}`)
}

export const FOLD_STYLE = `
${SCOPE} .ben-wb__usage-quotagrid>[data-rs-fold]{order:2}
${SCOPE} .ben-wb__usage-quotagrid>.rs-foldline{order:1}
${SCOPE} .ben-wb__usage-quotagrid:not([data-rs-open-stale=true])>[data-rs-fold=stale],
${SCOPE} .ben-wb__usage-quotagrid:not([data-rs-open-unconnected=true])>[data-rs-fold=unconnected]{display:none}
${SCOPE} .rs-foldline{display:block;width:100%;margin:0;padding:8px 0 0;border:0;background:transparent;text-align:left;cursor:pointer;
  font:inherit;font-size:var(--wb-fs-note);line-height:1.45;color:var(--wb-surface-muted)}
${SCOPE} .rs-foldline:hover{color:var(--wb-surface-ink)}
${SCOPE} .ben-wb__usage-quotagrid>[data-rs-fold] .ben-wb__usage-qpct{font-size:var(--wb-fs-note);font-weight:400;color:var(--wb-surface-muted)}
${SCOPE} .ben-wb__usage-unwired[data-rs-folded=true]{display:flex;flex-direction:column;gap:8px;padding-top:12px}
${SCOPE} .ben-wb__usage-unwired[data-rs-folded=true]:not([data-rs-open-unwired=true])>:not(.rs-foldline){display:none}
${SCOPE} .ben-wb__usage-unwired[data-rs-folded=true]>.rs-foldline{order:-1;padding-top:0}
`

export function applyAFold(): void {
  const run = (): void => {
    document.querySelectorAll(`${SCOPE} .ben-wb__usage-quotagrid`).forEach(foldQuota)
    document.querySelectorAll(`${SCOPE} .ben-wb__usage-unwired`).forEach(foldUnwired)
  }
  run()
  new MutationObserver(run).observe(document.body, { subtree: true, childList: true })
}
