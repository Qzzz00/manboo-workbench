/**
 * 确认类操作统一成居中弹层(10-22 统筹定 28,评审页 0cf75042 那 8 处 `.modal`):标题一问、一句后果、「取消」+ 一颗线框键。
 * 本卡接了顶栏「恢复布局」;设置里那七处(停止服务、清理演示、撤销设备、退出登录、切换布局、卸掉连接器、撤回做法)
 * 在设置卡 `ui-round-2-settings` 改的文件里,由它接 `ConfirmDialog` 与 `CONFIRMS` 的标题。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRMS, ConfirmDialog } from '../src/client/ui/index.tsx'

afterEach(cleanup)

describe('ConfirmDialog', () => {
  it('标题一问、一句后果;「取消」与确认键各一颗,确认键是线框次按钮', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog title="卸掉连接器?" body="依赖这个连接器的功能会暂时不可用。" confirm="卸掉" onConfirm={onConfirm} onCancel={onCancel} />)
    const dlg = screen.getByRole('dialog', { name: '卸掉连接器?' })
    expect(dlg).toHaveTextContent('依赖这个连接器的功能会暂时不可用。')
    const yes = within(dlg).getByRole('button', { name: '卸掉' })
    expect(yes).toHaveAttribute('data-variant', 'secondary')
    fireEvent.click(yes)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('八处的标题照评审页', () => {
    expect(Object.values(CONFIRMS).map(one => one.title)).toEqual([
      '停止形象与音色服务?', '清理演示数据?', '撤销设备连接?', '退出登录?', '切换布局?', '卸掉连接器?', '恢复默认布局?', '撤回这个做法?',
    ])
  })
})
