import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectZone } from '../src/client/ProjectZone.tsx'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)

it('总览正文重排后仍可确认状态，未写状态不冒充生成摘要', async () => {
  const user = userEvent.setup()
  const onConfirmStatus = vi.fn()
  const onToggle = vi.fn()
  render(<ProjectZone rows={[{
    id: 'p1', name: '工作台', stage: 'MVP 开发', tone: 'normal', activityText: '今天在动',
    signalText: 'main · 2 未提交', signalError: false, statusStale: false, detailLines: [], fragmentsText: '',
  }]} idleText="" pendingText="0 组 / 0 条" scanErrorTexts={[]}
    expandedId={null} onToggle={onToggle} onConfirmStatus={onConfirmStatus} />)
  await user.click(screen.getByRole('button', { name: '未写状态' }))
  await user.type(screen.getByRole('textbox', { name: '编辑状态:工作台' }), '内部编排已完成')
  await user.click(screen.getByRole('button', { name: '确认' }))
  expect(onConfirmStatus).toHaveBeenCalledWith('p1', '内部编排已完成')
  // 原有真相纪律：提交后等下一拍服务端快照，不在本地伪造成功状态。
  expect(screen.getByRole('button', { name: '未写状态' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '工作台 MVP 开发' }))
  expect(onToggle).toHaveBeenCalledWith('p1')
})

it('对齐的额度列表区分真实金额与未接入，不产生假百分比', () => {
  render(<QuotaPanel quota={{ dsh: { kind: 'balance', currency: 'CNY', total: '218.40', available: true } }}
    now="2026-09-15T10:00:00+08:00" />)
  const list = screen.getByRole('list', { name: '客户端余额与额度' })
  // 余额那一行单独一张单子排在口径那句之上(评审页 0cf75042 余额 / 额度)
  const balance = within(screen.getByRole('list', { name: '余额' })).getByRole('listitem', { name: 'DeepSeek' })
  expect(within(balance).getByText('¥218.40')).toBeInTheDocument()
  expect(balance.textContent).not.toContain('%')
  expect(balance.querySelector('.ben-wb__usage-qtrack')).toBeNull()
  const codex = within(list).getByRole('listitem', { name: 'Codex' })
  expect(within(codex).getByText('未接入')).toBeInTheDocument()
  expect(codex.textContent).not.toMatch(/0%/)
  const disclosure = within(codex).getByText('说明')
  expect(disclosure.closest('details')).not.toHaveAttribute('open')
  fireEvent.click(disclosure)
  expect(disclosure.closest('details')).toHaveAttribute('open')
  expect(within(codex).getByText('取数方式待实测')).toBeVisible()
})
