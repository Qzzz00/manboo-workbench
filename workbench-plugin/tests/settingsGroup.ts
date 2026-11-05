/**
 * 设置弹窗的分组切换(2026-09-28,卡 SG)。用例里要看某一节,先切到它所在那一组。
 *
 * 2026-09-28 之前这一屏是一条长滚动,所有节同时在 DOM 里,用例 render 完直接断言就行。
 * 现在**一次只渲染一组**——那是这次改动的要点本身(见 SettingsDialog.tsx 顶部),
 * 所以用例也得像人一样先点一下分组。组名一律走这里,改了组名只改这一个文件。
 */
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'

export const GROUP = {
  butler: '事务官的规矩',
  devices: '手机与座机',
  agents: '各家 AI 与账号',
  machine: '这台电脑',
  update: '更新',
  advanced: '高级',
} as const

/** 切到某一组(已经在那一组就什么都不做)。 */
export async function openGroup(label: string): Promise<void> {
  const tab = screen.getByRole('tab', { name: label })
  if (tab.getAttribute('aria-selected') === 'true') return
  await userEvent.click(tab)
}
