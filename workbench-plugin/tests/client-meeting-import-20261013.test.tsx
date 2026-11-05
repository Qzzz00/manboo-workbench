/**
 * 电脑上那颗「导入转写出纪要」(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
 *
 * 为什么在设置里而不是另做一格:周三演示与展位都不能现场录一小时再等半小时,
 * 这颗键是那条路的入口;纪要出来之后照旧在**事务官收件箱那一档**与**手机会议页**上看
 * (统筹定:这一版不新做自媒体模板里的会议格子)。
 *
 * 2026-10-22 起照评审页 `section('meeting', '会议转写', …)`:一句 + 转写框(`会议转写内容`)+ 会议名称 +「选择文件」「导入转写」,
 * 录音那一格点「或者使用录音文件」才露出来;「放三场演示用的会」收进「演示用的几场会」折叠。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingImportPanel, MEETING_DEMO_SEED_LABEL, MEETING_IMPORT_HOW_LONG, MEETING_IMPORT_TITLE } from '../src/client/MeetingImportPanel.tsx'

afterEach(cleanup)

function fetchOk(record: { body?: unknown }): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    record.body = JSON.parse(String(init?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'm1', dir: '/Users/example/repo/会议/2026-10-13-十一月选题会' }) }
  }) as unknown as typeof fetch
}

function fetchNo(error: string): typeof fetch {
  return vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error }) })) as unknown as typeof fetch
}

async function type(label: string, value: string): Promise<void> {
  const field = screen.getByLabelText(label) as HTMLTextAreaElement | HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickText(text: string): Promise<void> {
  const node = screen.getByText(text)
  await act(async () => { node.click(); await Promise.resolve() })
}

async function click(name: string | RegExp): Promise<void> {
  const button = screen.getByRole('button', { name })
  await act(async () => { button.click(); await Promise.resolve() })
}

describe('设置里那一节', () => {
  it('说清这条路是干什么的;什么都没填时那颗键按不动;导进去之后说清要等多久', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk({})} meetings={{ dir: '/Users/example/repo/会议' }} />)
    expect(screen.getByRole('heading', { name: MEETING_IMPORT_TITLE })).toBeTruthy()
    expect(screen.getByText('已有转写可以生成纪要与待办。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '导入转写' })).toBeDisabled()
    // 稿里那一句不写要等多久(10-22);「约一分钟」挪到按下去之后那句回话里。
    await type('会议转写内容', '一句话')
    await click('导入转写')
    expect(screen.getByRole('status').textContent).toContain(MEETING_IMPORT_HOW_LONG)
  })

  it('★ 粘一段转写 → POST /meeting/import,回话里说清去哪儿看', async () => {
    const record: { body?: unknown } = {}
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk(record)} meetings={{ dir: '/Users/example/repo/会议' }} />)
    await type('会议转写内容', '[00:00:00] 行,人齐了。')
    await type('会议名称', '十一月选题会')
    await click('导入转写')
    expect(record.body).toEqual({ text: '[00:00:00] 行,人齐了。', title: '十一月选题会' })
    expect(screen.getByRole('status').textContent).toContain('收件箱')
    expect(screen.getByRole('status').textContent).toContain('2026-10-13-十一月选题会')
  })

  it('给一个录音文件的位置 → 同一条路,但说清它要走识别、慢', async () => {
    const record: { body?: unknown } = {}
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk(record)} meetings={{ dir: '/Users/example/repo/会议' }} />)
    // 录音那一格默认不在屏上,点「或者使用录音文件」才露出来
    expect(screen.queryByLabelText('录音文件在这台电脑上的位置')).toBeNull()
    await click('或者使用录音文件')
    await type('录音文件在这台电脑上的位置', '/Users/example/Desktop/上周的会.m4a')
    expect(screen.getByText(/半小时/)).toBeTruthy()
    await click('导入转写')
    expect(record.body).toEqual({ audio_path: '/Users/example/Desktop/上周的会.m4a' })
  })

  it('电脑那边拒了 → 原样转达那一句,不自己编一句', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchNo('这一段太长了(130000 字…)')} meetings={{ dir: '/Users/example/repo/会议' }} />)
    await type('会议转写内容', '一句话')
    await click('导入转写')
    expect(screen.getByRole('status').textContent).toContain('太长了')
  })

  it('★ 工作目录没配 → 如实说一句、那颗键按不动(不让她白填一遍)', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk({})} meetings={{}} />)
    expect(screen.getByText(/还没配/)).toBeTruthy()
    await type('会议转写内容', '一句话')
    expect(screen.getByRole('button', { name: '导入转写' })).toBeDisabled()
  })
})

describe('同一节里那颗「放三场演示用的会」(2026-10-13,卡「会议页不再空着」)', () => {
  /** 放三场那条的回包:一场一条,说得出哪一场放了、哪一场跳过了。 */
  function fetchSeed(record: { path?: string }): typeof fetch {
    return vi.fn(async (input: unknown) => {
      record.path = String(input)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cases: [
            { key: 'topics', title: '十月选题会', note: '内部例会:定了的与只是想法的分开标。' },
            { key: 'brand', title: '跟品牌方谈一条植入', note: '外部谈判会。' },
            { key: 'weekly', title: '周复盘', skipped: true, note: '2026-10-13 已经有一场「周复盘」。' },
          ],
        }),
      }
    }) as unknown as typeof fetch
  }

  it('★ 按之前就说清:三场是虚构的、走真路、要问模型几次、重复点不重复放', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk({})} meetings={{ dir: '/Users/example/repo/会议' }} />)
    await clickText('演示用的几场会')
    const hint = screen.getByText(/三场虚构的历史会/)
    expect(hint.textContent).toContain('会前')
    expect(hint.textContent).toContain('六次')
    expect(hint.textContent).toContain('演示用')
    expect(hint.textContent).toContain('重复点不会放第二摞')
  })

  it('★ 点下去 → POST /meeting/seed-demo;回话里一场一条,跳过的也说出来', async () => {
    const record: { path?: string } = {}
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchSeed(record)} meetings={{ dir: '/Users/example/repo/会议' }} />)
    await clickText('演示用的几场会')
    await click(MEETING_DEMO_SEED_LABEL)
    expect(record.path).toBe('http://x/meeting/seed-demo')
    expect(screen.getByRole('status').textContent).toContain('放了 2 场')
    expect(screen.getByRole('status').textContent).toContain('跳过 1 场')
    expect(screen.getByText(/十月选题会:内部例会/)).toBeTruthy()
    expect(screen.getByText(/周复盘:2026-10-13 已经有一场/)).toBeTruthy()
  })

  it('这一节只有一颗主键:放演示那颗是文字键(设置页的铁律)', async () => {
    const { container } = render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk({})} meetings={{ dir: '/Users/example/repo/会议' }} />)
    await clickText('演示用的几场会')
    expect(screen.getByRole('button', { name: '导入转写' })).toHaveAttribute('data-kind', 'outline')
    expect(screen.getByRole('button', { name: MEETING_DEMO_SEED_LABEL })).toHaveAttribute('data-kind', 'text')
    expect(container.querySelectorAll('[data-kind=outline],[data-kind=primary]')).toHaveLength(1)
  })

  it('工作目录没配 → 那颗键也按不动(放进去没地方落)', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchOk({})} meetings={{}} />)
    await clickText('演示用的几场会')
    expect(screen.getByRole('button', { name: MEETING_DEMO_SEED_LABEL })).toBeDisabled()
  })

  it('电脑那边拒了 → 原样转达', async () => {
    render(<MeetingImportPanel baseUrl="http://x" fetchImpl={fetchNo('还没配「工作目录」(事务官仓库),会议没地方落。')} meetings={{ dir: '/x' }} />)
    await clickText('演示用的几场会')
    await click(MEETING_DEMO_SEED_LABEL)
    expect(screen.getByRole('status').textContent).toContain('没地方落')
  })
})
