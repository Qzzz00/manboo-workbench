/**
 * 设置 → 模板里那一行「运营技能:已接上 n 条 / 没接上」+ 一颗「重新接上」(2026-09-22,卡 ①)。
 *
 * 钉五件:
 *   ① 接上了:一行绿话,说得出是几条;
 *   ② 没接上:**缺哪几段一条条列出来**(D13:不总结成一句"未就绪");
 *   ③ 上个模板剩下的没摘干净,也要说 —— 那是"切了没生效"最难查的一种;
 *   ④ 点「重新接上」→ POST /config/ops-skills/apply,回来的那句话原样上屏,
 *      而且必须带上「新开一条会话才读得到」;
 *   ⑤ `/config/ops-skills` 404(这台服务没接代写)→ **整行不出现**,不摆一个点不动的状态。
 * 2026-10-22 起这一格是设置里的一行(名字「运营技能」+ 副行状态 + 「重新接上」),外层挂 `data-ops-skills`。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpsSkillsRow, isOpsSkillsPayload } from '../src/client/TemplatePanel.tsx'

afterEach(cleanup)

const BASE = 'http://127.0.0.1:8791'
const FILE = '/Users/her/.dsh/AGENTS.md'

interface Call { url: string, method: string }

function payload(over: Record<string, unknown> = {}) {
  return {
    template: 'ops',
    file: FILE,
    attached: {
      ok: true,
      expected: ['用说话改布局', '运营-总纲', '运营-复盘'],
      attached: ['用说话改布局', '运营-总纲', '运营-复盘'],
      absent: [],
      stray: [],
    },
    skills: [
      { name: '运营-总纲', summary: '总管的口径', found: true, attached: true },
      { name: '运营-复盘', summary: '先自评再总结', found: true, attached: true },
    ],
    ...over,
  }
}

/** 假 fetch:GET 回 `get`(点过按钮之后回 `after`),POST 回 `apply` 并记一笔。 */
function fakeFetch(
  calls: Call[],
  opts: { get?: unknown, getStatus?: number, apply?: unknown, applyStatus?: number, after?: unknown } = {},
) {
  let applied = false
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: String(url), method })
    if (method === 'POST') {
      applied = true
      const status = opts.applyStatus ?? 200
      return { ok: status < 400, status, json: async () => opts.apply ?? { ok: true, note: '事务官技能已接上 11 段' } }
    }
    if (opts.getStatus !== undefined && opts.getStatus >= 400) {
      return { ok: false, status: opts.getStatus, json: async () => ({ error: '代写事务官技能未启用' }) }
    }
    return { ok: true, json: async () => (applied && opts.after !== undefined ? opts.after : (opts.get ?? payload())) }
  }) as unknown as typeof fetch
}

async function renderRow(fetchImpl: typeof fetch): Promise<void> {
  render(<OpsSkillsRow baseUrl={BASE} fetchImpl={fetchImpl} />)
  await waitFor(() => expect(screen.queryByText('运营技能')).not.toBeNull())
}

describe('① 接上了', () => {
  it('说得出是几条,而且这一格标着 data-ok=true', async () => {
    await renderRow(fakeFetch([]))
    expect(screen.getByTestId('ops-skills-state')).toHaveTextContent('已接上 3 条')
    expect(document.querySelector('[data-ops-skills]')).toHaveAttribute('data-ok', 'true')
    // 写到哪儿、动了哪一段,摆在旁边 —— 「工作台替你写你家目录里的文件」必须看得见。
    expect(screen.getByText(new RegExp(`写进 ${FILE} 的标记段`))).toBeInTheDocument()
  })
})

describe('② 没接上:缺哪几段一条条说', () => {
  it('★缺的段名原样列出来,不总结成一句"未就绪"', async () => {
    await renderRow(fakeFetch([], {
      get: payload({
        attached: {
          ok: false,
          expected: ['用说话改布局', '运营-总纲', '运营-复盘'],
          attached: ['用说话改布局'],
          absent: ['运营-总纲', '运营-复盘'],
          stray: [],
        },
      }),
    }))
    expect(screen.getByTestId('ops-skills-state')).toHaveTextContent('没接上(该有 3 条,现在 1 条)')
    expect(screen.getByText(/缺:运营-总纲、运营-复盘/)).toBeInTheDocument()
    expect(document.querySelector('[data-ops-skills]')).toHaveAttribute('data-ok', 'false')
  })
})

describe('③ 上个模板剩下的没摘干净', () => {
  it('★也要说出来(做产品模板下还挂着运营技能,事务官会去建选题目录)', async () => {
    await renderRow(fakeFetch([], {
      get: payload({
        template: 'product',
        attached: {
          ok: false,
          expected: ['用说话改布局'],
          attached: ['用说话改布局'],
          absent: [],
          stray: ['运营-总纲'],
        },
      }),
    }))
    expect(screen.getByText(/上个模板剩下的还没摘:运营-总纲/)).toBeInTheDocument()
    // 不是运营模板时多说一句,免得她以为"没接上"是出了错。
    expect(screen.getByText(/当前不是自媒体运营模板/)).toBeInTheDocument()
  })
})

describe('④ 「重新接上」那颗按钮', () => {
  it('★点了就 POST /config/ops-skills/apply,回来的话原样上屏 + 提醒新开会话', async () => {
    const calls: Call[] = []
    await renderRow(fakeFetch(calls, {
      apply: { ok: true, note: '事务官技能已接上 11 段', restart_hint: '新开一条它才读得到这几份技能。' },
      after: payload(),
    }))
    act(() => { screen.getByRole('button', { name: '重新接上' }).click() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/config/ops-skills/apply'))).toBe(true))
    await waitFor(() => expect(screen.getByText(/事务官技能已接上 11 段/)).toBeInTheDocument())
    expect(screen.getByText(/新开一条它才读得到/)).toBeInTheDocument()
    // 点完自己重新拉一遍状态,不用她刷新页面。
    expect(calls.filter(one => one.method === 'GET' && one.url.endsWith('/config/ops-skills')).length).toBeGreaterThan(1)
  })

  it('★失败:服务端那句人话原样上屏(不改写、不猜原因)', async () => {
    await renderRow(fakeFetch([], {
      applyStatus: 404,
      apply: { error: '找不到本机的 desktop-workbench 仓库,读不到 docs/技能/运营-*.md,这次一段都没写。' },
    }))
    act(() => { screen.getByRole('button', { name: '重新接上' }).click() })
    await waitFor(() => expect(screen.getByText(/找不到本机的 desktop-workbench 仓库/)).toBeInTheDocument())
  })
})

describe('⑤ 没接代写', () => {
  it('GET 404 → 整行不出现(不摆一个点不动的状态)', async () => {
    render(<OpsSkillsRow baseUrl={BASE} fetchImpl={fakeFetch([], { getStatus: 404 })} />)
    await waitFor(() => expect(document.querySelector('[data-ops-skills]')).toBeNull())
    expect(screen.queryByRole('button', { name: '重新接上' })).toBeNull()
  })

  it('形状不对的回包也当没拿到(并行跑用例时串了别的节的 mock)', () => {
    expect(isOpsSkillsPayload({ current: 'product', templates: [] })).toBe(false)
    expect(isOpsSkillsPayload(payload())).toBe(true)
  })
})
