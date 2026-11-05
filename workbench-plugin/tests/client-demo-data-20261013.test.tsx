/**
 * 设置里那一节「演示数据」(2026-10-13,卡「演示数据一键放进去」):开演前一键放、演完一键清。
 *
 * 守三样:**按之前就说清**放哪几样、全部标着演示用、放完会跑一遍早报;
 * 清掉那一颗先说清它动不了什么(账是只追加的、会删不掉);这一节只有一颗主键。
 * 2026-10-22 起照评审页 `section('demo', '演示数据', …)`:一行 + 描边「放一套」、底下文字「清理演示数据」;
 * 那两段「按之前就说清」收在文字键「放了什么、清掉什么」里,一点就开(按之前照样看得到)。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import {
  DEMO_DATA_CLEAR_HINT,
  DEMO_DATA_CLEAR_LABEL,
  DEMO_DATA_SEED_LABEL,
  DEMO_DATA_TITLE,
  DemoDataPanel,
} from '../src/client/DemoDataPanel.tsx'

afterEach(cleanup)

function fetcher(record: { paths: string[] }, answer: unknown, ok = true): typeof fetch {
  return vi.fn(async (input: unknown) => {
    record.paths.push(String(input))
    return { ok, status: ok ? 200 : 409, json: async () => answer }
  }) as unknown as typeof fetch
}

async function click(name: string | RegExp): Promise<void> {
  const button = screen.getByRole('button', { name })
  await act(async () => { button.click(); await Promise.resolve() })
}

const SEEDED = {
  ok: true,
  note: '放了 20 条,跳过 0 条已经有的;往任务账上记了 17 条。全部标着「演示用」。',
  morning: '早报在跑了:好了在事务官收件箱与手机「汇报」页里看。',
  jobs: 17,
  lines: [
    { title: '看一眼三版口播脚本,定用哪一版', note: '放好了:2026-10-13 到期。' },
    { title: '露营短片:封面图三版', note: '卡点:回话读不回来,要重派' },
    { title: '周复盘', note: '今天已经有这一场了,没登记第二场。', skipped: true as const },
  ],
}

describe('那一节长什么样', () => {
  it('★ 按之前就说清:放哪几样、走真路、标着演示用、同名跳过、放完跑一遍早报', async () => {
    render(<DemoDataPanel baseUrl="http://x" fetchImpl={fetcher({ paths: [] }, SEEDED)} />)
    expect(screen.getByRole('heading', { name: DEMO_DATA_TITLE })).toBeTruthy()
    await click('放了什么、清掉什么')
    const hint = screen.getByText(/放一套虚构的自媒体数据/)
    expect(hint.textContent).toContain('带日期的事项')
    expect(hint.textContent).toContain('发布计划')
    expect(hint.textContent).toContain('演示用')
    expect(hint.textContent).toContain('跳过')
    expect(hint.textContent).toContain('早报')
  })

  it('清掉那一颗先说清它动不了什么:账是只追加的、那场会删不掉、她自己的卡不碰', async () => {
    render(<DemoDataPanel baseUrl="http://x" fetchImpl={fetcher({ paths: [] }, SEEDED)} />)
    await click('放了什么、清掉什么')
    const hint = screen.getByText(/只把带「演示用」记号的那几张卡/)
    expect(hint.textContent).toContain('不是删掉')
    expect(hint.textContent).toContain('只追加')
    expect(hint.textContent).toContain('删不掉')
  })

  it('★ 点「放一套」→ POST /demo/seed;回话里一条一行,跳过的也说出来', async () => {
    const record = { paths: [] as string[] }
    render(<DemoDataPanel baseUrl="http://x" fetchImpl={fetcher(record, SEEDED)} />)
    await click(DEMO_DATA_SEED_LABEL)
    expect(record.paths).toEqual(['http://x/demo/seed'])
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('放了 20 条')
    expect(status).toContain('早报在跑了')
    expect(screen.getByText(/封面图三版:卡点/)).toBeTruthy()
    expect(screen.getByText(/跳过 · 周复盘/)).toBeTruthy()
  })

  it('★ 点「清理演示数据」→ POST /demo/clear;没挪动的那几张如实列出来', async () => {
    const record = { paths: [] as string[] }
    render(<DemoDataPanel
      baseUrl="http://x"
      fetchImpl={fetcher(record, {
        ok: true,
        canceled: 19,
        note: '取消了 19 张演示卡,1 张没挪动。',
        failed: [{ title: '补拍一条产品特写', why: '挪到「取消」没成' }],
      })}
    />)
    await click(DEMO_DATA_CLEAR_LABEL)
    // 10-22 起先问一句(共用确认弹层「清理演示数据?」),后果就是 DEMO_DATA_CLEAR_HINT 那几句
    expect(record.paths).toEqual([])
    expect(screen.getByRole('dialog', { name: CONFIRMS.clearDemo.title })).toHaveTextContent(DEMO_DATA_CLEAR_HINT)
    await click(CONFIRMS.clearDemo.confirm)
    expect(record.paths).toEqual(['http://x/demo/clear'])
    expect(screen.getByRole('status').textContent).toContain('取消了 19 张')
    expect(screen.getByText(/没挪动 · 补拍一条产品特写/)).toBeTruthy()
  })

  it('这一节只有一颗主键:清掉那颗是文字键(设置页的铁律)', () => {
    const { container } = render(<DemoDataPanel baseUrl="http://x" fetchImpl={fetcher({ paths: [] }, SEEDED)} />)
    expect(screen.getByRole('button', { name: DEMO_DATA_SEED_LABEL })).toHaveAttribute('data-kind', 'outline')
    expect(screen.getByRole('button', { name: DEMO_DATA_CLEAR_LABEL })).toHaveAttribute('data-kind', 'text')
    expect(container.querySelectorAll('[data-kind=outline],[data-kind=primary]')).toHaveLength(1)
  })

  it('电脑那边拒了 → 原样转达,不装作放进去了', async () => {
    render(<DemoDataPanel baseUrl="http://x" fetchImpl={fetcher({ paths: [] }, { error: '任务看板未启用' }, false)} />)
    await click(DEMO_DATA_SEED_LABEL)
    expect(screen.getByRole('status').textContent).toContain('任务看板未启用')
  })
})
