/**
 * 设置弹窗里的「新增监视项」表单(2026-09-09 哨兵)。
 * 2026-10-22 起照评审页 `section('sentinel', '哨兵', …)`:两列表单,格名「变了跟你说」,描边键「开始监视」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

function fetchStub(over: (url: string) => Response | undefined = () => undefined) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const custom = over(url)
    if (custom !== undefined) return custom
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response
  }) as unknown as typeof fetch
}

describe('新增监视项表单', () => {
  it('★填完提交 → POST /sentinel/add,带上四类之一、目标与那句 note', async () => {
    const calls: { url: string, body: unknown }[] = []
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
    }) as unknown as typeof fetch

    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    await userEvent.selectOptions(screen.getByLabelText('盯什么'), 'port')
    await userEvent.type(screen.getByLabelText('目标'), '127.0.0.1:3080')
    await userEvent.type(screen.getByLabelText('变了跟你说'), 'DSH 掉了要知道')
    await userEvent.click(screen.getByRole('button', { name: '开始监视' }))

    await waitFor(() => expect(calls.some(call => call.url.endsWith('/sentinel/add'))).toBe(true))
    const call = calls.find(c => c.url.endsWith('/sentinel/add'))!
    expect(call.body).toMatchObject({ kind: 'port', target: '127.0.0.1:3080', note: 'DSH 掉了要知道' })
  })

  it('★没有 command 这个选项——审计结论:这一类不做', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchStub()} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    const select = screen.getByLabelText('盯什么') as HTMLSelectElement
    const values = [...select.options].map(option => option.value)
    expect(values).toEqual(['file', 'http', 'process', 'port'])
  })

  it('目标或 note 空着:按钮点不动(不发一条注定被服务端拒的请求)', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchStub()} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    expect(screen.getByRole('button', { name: '开始监视' })).toBeDisabled()
  })

  it('★服务端拒了:把服务端那句原话摆出来,不谎称加上了', async () => {
    const impl = fetchStub(url => url.endsWith('/sentinel/add')
      ? ({ ok: false, status: 400, json: async () => ({ error: 'note 必须是非空字符串' }) } as Response)
      : undefined)

    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    await userEvent.type(screen.getByLabelText('目标'), '/tmp/a.log')
    await userEvent.type(screen.getByLabelText('变了跟你说'), '日志动了')
    await userEvent.click(screen.getByRole('button', { name: '开始监视' }))

    await waitFor(() => expect(screen.getByText(/note 必须是非空字符串/)).toBeInTheDocument())
  })

  it('加上了:清空输入框并如实说一句,列表在事务官浮窗里看', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchStub()} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    await userEvent.type(screen.getByLabelText('目标'), '/tmp/a.log')
    await userEvent.type(screen.getByLabelText('变了跟你说'), '日志动了')
    await userEvent.click(screen.getByRole('button', { name: '开始监视' }))

    await waitFor(() => expect(screen.getByLabelText('目标')).toHaveValue(''))
    expect(screen.getByText(/在盯着的事/)).toBeInTheDocument()
  })
})
