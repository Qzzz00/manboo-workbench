/**
 * 格子全貌:余额 / 额度、消耗数据两格按桌面上的宽(362px)摆开,**不限高**,滚动区里藏着的那几行一起看得到。
 * 整版截图里底部格子只有 196px 高,「拿不到数的行收成一行计数」落在滚动区下半截,截不进去,所以另出这一张。
 * 吃同一份夹具;`?v=a|b`、`?theme=dark` 同 main.tsx,`?open=1` 把计数那几行点开。
 * 数字格那一侧照旧由 FIG_REF 决定(递 `figures`,老代码不认就忽略)。
 */
import { createRoot } from 'react-dom/client'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
import { STYLE } from '../../src/client/style.ts'
import { QuotaPanel } from '../../src/client/QuotaPanel.tsx'
import { UsagePanel } from '../../src/client/UsagePanel.tsx'
import { AGENT_QUOTA, NOW, QUOTA, USAGE } from './fixture.ts'
import { A_STYLE, B_DELTA } from './aStyle.ts'
import { applyAText } from './aText.ts'
import { FOLD_STYLE, applyAFold } from './aFold.ts'

const query = new URLSearchParams(location.search)
if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
const variant = query.get('v')

const AGENTS = ['dsh', 'claude', 'codex', 'kimi'] as const
const extra = { figures: true } as Record<string, unknown>

function Cell({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <section className="ben-wb__card ben-wb__card--fill rs-cell">
      <div className="ben-wb__modhead"><h2 className="ben-wb__ttl">{title}</h2></div>
      {children}
    </section>
  )
}

function Page() {
  return (
    <main className="ben-wb rs-root" data-template="product">
      <Cell title="余额 / 额度"><QuotaPanel quota={QUOTA} now={NOW} agentQuota={AGENT_QUOTA} agents={AGENTS} {...extra} /></Cell>
      <Cell title="消耗数据"><UsagePanel usage={USAGE} /></Cell>
    </main>
  )
}

const page = document.createElement('style')
page.textContent = `
html,body{margin:0;background:var(--dsw-alias-bg-base)}
.ben-wb.rs-root{position:relative;inset:auto;overflow:visible;display:flex;align-items:flex-start;gap:16px;padding:16px;box-sizing:border-box;width:max-content}
.rs-cell{width:362px;box-sizing:border-box;flex:none;height:auto}
.rs-cell .ben-wb__scroll{overflow:visible;flex:none;max-height:none}
`
const layer = document.createElement('style')
layer.textContent = variant === 'a' ? `${A_STYLE}\n${FOLD_STYLE}` : variant === 'b' ? `${A_STYLE}\n${B_DELTA}\n${FOLD_STYLE}` : ''
const base = document.createElement('style')
base.textContent = STYLE
document.head.append(base, page)
document.body.appendChild(layer)
createRoot(document.getElementById('root')!).render(<Page />)
if (variant === 'a' || variant === 'b') {
  applyAText()
  applyAFold()
  // ?open=1:把那几行计数点开(看点开之后每家「上次几时」还在)。
  if (query.get('open') === '1') setTimeout(() => document.querySelectorAll<HTMLButtonElement>('.rs-foldline').forEach(one => one.click()), 600)
}
