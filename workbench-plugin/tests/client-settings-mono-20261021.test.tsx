/**
 * 设置按「设置 01」重排(2026-10-21):左侧竖排六组;各节照旧都在下面。
 * 10-22 拍板 14 / 15 照评审页 0cf75042 `slot=settings`:每组顶上「组名 + 一句说明 + ?」,下面一排跳转小钮(只写节名),
 * 点一下跳到那一节;没接线、拉不到的那一节,小钮一起藏。左栏 / 顶栏带进来的落点直接跳到那一节。
 * 原来入口行上的状态挪到各节标题右边(规矩、学到的按记录数;没有就说没有,不编数)。各节内部见 `client-settings-sections-20261022`。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_ENTRIES, SETTINGS_GROUPS, SettingsDialog, habitsEntryLine, rulesEntryLine } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

const rule = (id: string, status: string) => ({ id, text: id, title: id, area: 'all', origin: 'said', status, editable: true, created_at: '', updated_at: '', evidence: [] })
const habit = (id: string, status: string) => ({ id, kind: 'dispatch', kind_title: '默认派给谁', text: id, status, evidence: [], applied: 0, adopted_at: '', updated_at: '' })

function fetchAll(): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input)
    const body = url.includes('/butler/rules')
      ? { rules: [rule('a', 'active'), rule('b', 'active'), rule('c', 'kept')], retired: [rule('d', 'removed')] }
      : url.includes('/habits')
        ? { trial: [habit('h1', 'trial'), habit('h2', 'trial')], kept: [habit('h3', 'kept')], retired: [] }
        : {}
    return { ok: true, status: 200, json: async () => body }
  }) as unknown as typeof fetch
}

let scrolled: string[] = []
beforeEach(() => {
  scrolled = []
  // 跳的是那一节的 <section>(外层是 display:contents,没有盒子);记下它的节名 id。
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute('aria-labelledby') ?? this.id) } as typeof Element.prototype.scrollIntoView
})

describe('状态那一句(节名右边)', () => {
  it('规矩:照做几条、撤下几条;一条都没有就直说', () => {
    expect(rulesEntryLine({ rules: [rule('a', 'active'), rule('b', 'trial')], retired: [rule('d', 'removed')] } as never)).toBe('2 条正在照做 · 1 条已撤下')
    expect(rulesEntryLine({ rules: [], retired: [] } as never)).toBe('还没有记下的规矩')
  })

  it('学到的:试用几条、留下几条;0 也写', () => {
    expect(habitsEntryLine({ trial: [habit('a', 'trial')], kept: [], retired: [] } as never)).toBe('1 条试用 · 0 条留下')
  })

  it('显示在那一节的标题右边', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    const rules = (await screen.findByRole('heading', { name: '记住的规矩', level: 3 })).closest('section') as HTMLElement
    await waitFor(() => expect(within(rules).getByText('3 条正在照做 · 1 条已撤下')).toHaveClass('ben-wb__ss-aside'))
    const habits = (await screen.findByRole('heading', { name: '它学到了什么', level: 3 })).closest('section') as HTMLElement
    await waitFor(() => expect(within(habits).getByText('2 条试用 · 1 条留下')).toHaveClass('ben-wb__ss-aside'))
  })
})

describe('设置 01 的骨架', () => {
  it('六组竖排在左边,底下一句「按 Esc 关闭」', () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    expect(screen.getByRole('tablist', { name: '设置分组' })).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByText('按 Esc 关闭')).toBeInTheDocument()
  })

  it('组首「组名 + 一句说明」照评审页;下面一排跳转小钮,只写节名', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    expect(SETTINGS_GROUPS.map(one => one.desc)).toEqual([
      '规矩、学到的做法,以及你想交代的事。', '管理设备连接与电脑唤醒。', '先看能做什么,再管理账号和额度来源。',
      '账号、布局和你自己的组件。', '查看当前版本与更新状态。', '目录、连接器和诊断入口。',
    ])
    expect(screen.getByText('规矩、学到的做法,以及你想交代的事。')).toHaveClass('ben-wb__setgrp-desc')
    const jump = screen.getByRole('navigation', { name: '这一组有什么' })
    for (const entry of SETTINGS_ENTRIES.butler.filter(one => ['rules', 'habits', 'sentinel', 'demo'].includes(one.id))) {
      expect(await within(jump).findByRole('button', { name: entry.title })).toHaveTextContent(new RegExp(`^${entry.title}$`))
    }
  })

  it('组首那颗 ? 点开是这一组的长说明', () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '这一组管什么' }))
    expect(screen.getByRole('dialog', { name: '这一组管什么' })).toHaveTextContent(SETTINGS_GROUPS[0]!.lead)
  })

  it('没接线的节不列小钮(形象与音色、会议没传就没有那一颗)', () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    const list = screen.getByRole('navigation', { name: '这一组有什么' })
    expect(within(list).queryByRole('button', { name: /形象与音色/ })).toBeNull()
    expect(within(list).queryByRole('button', { name: /会议转写/ })).toBeNull()
  })

  it('点小钮跳到那一节', () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} />)
    fireEvent.click(within(screen.getByRole('navigation', { name: '这一组有什么' })).getByRole('button', { name: '哨兵' }))
    expect(scrolled).toEqual(['ben-wb-sentinel-form'])
  })

  it('左栏 / 顶栏带来的落点:开在那一组、跳到那一节', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} openAt={{ group: 'butler', row: 'habits' }} />)
    await waitFor(() => expect(scrolled).toContain('ben-wb-habits'))
  })

  it('换一组,小钮跟着换;那一节拉不到数据,小钮一起藏', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchAll()} onClose={() => {}} connector={{ phase: 'ready', installed: true, running: true, port: 7601, version: '1.0.0', downloadBytes: 0, hosts: [] }} />)
    await openGroup(GROUP.advanced)
    const list = screen.getByRole('navigation', { name: '这一组有什么' })
    expect(within(list).getByRole('button', { name: /连接器/ })).toBeInTheDocument()
    // 目录那一节拉回来的形状不对,整节不出,入口行也不出
    await waitFor(() => expect(within(list).queryByRole('button', { name: /目录/ })).toBeNull())
  })
})
