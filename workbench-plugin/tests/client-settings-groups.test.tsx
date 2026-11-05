/**
 * 设置页整理(2026-09-28,卡 SG)。维护者原话:「现在桌面端的设置页面乱的要死,梳理一遍,把 UI 做好。」
 * 同一天他对更新页说过:「大哥,你搞这几个按钮搞成这样,谁能理解啊?」
 *
 * 这个文件钉三条,它们是这次改动本身,不是实现细节:
 *
 * 1. **分组切换**:顶上一排组名,一次只看一组;点哪一组就只剩那一组的节。
 * 2. **每节最多一颗主按钮**:一节里 `.ben-wb__set-primary` 至多一颗,
 *    其余动作要么是文字链接(`.ben-wb__set-lnk`),要么是行里的次级按钮。
 * 3. **高级默认折叠**:目录、峰谷时段、连接器、体检与修复这些「配一次十年不动」的
 *    默认一个都不在屏上,点「高级」才出来 —— 但**一个都没丢**。
 *
 * 详见 docs/设计-设置页整理-2026-09-28.md。
 * 2026-10-22 起各节内部照 Codex 全局评审页重排:节名跟着稿改了几个,主按钮是描边(`data-kind=outline`),
 * 次要动作是无框或文字(`data-kind=plain|text`);这里照新名字、新件数。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_GROUPS, SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

/** 每条路都给得出一份形状对的回包 —— 让尽量多的节真的渲染出来(不然断言等于没断)。 */
function fullFetch(): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input)
    const body = ((): unknown => {
      if (url.includes('/butler/rules')) {
        return {
          rules: [{
            id: 'r1', text: '标题不要用感叹号', area: 'content', origin: 'said',
            status: 'kept', editable: true, created_at: '2026-09-20T02:00:00.000Z', evidence: [],
          }],
          retired: [],
        }
      }
      if (url.includes('/habits')) return { trial: [], kept: [], retired: [] }
      if (url.includes('/agents/caps')) {
        return {
          line: '两家能改本机文件。',
          checked_at: '2026-09-28T06:00:00.000Z',
          agents: [{
            family: 'claude', title: 'Claude Code', installed: true,
            cells: {
              chat: { state: 'ok', note: '能聊' },
              edit: { state: 'ok', note: '能改本机文件' },
              collect: { state: 'ok', note: '收得回来' },
            },
          }],
        }
      }
      if (url.includes('/agents/quota')) return { agents: [] }
      if (url.includes('/butler/budget')) return { cny: 3, minutes: 20 }
      if (url.includes('/shell/system-awake')) return { enabled: true }
      if (url.includes('/config/paths')) {
        return {
          scan_roots: null, inbox_dirs: null, butler_cwd: null,
          defaults: { scan_roots: [{ path: '~/a', depth: 1 }], inbox_dirs: ['~/b'] },
          effective: { scan_roots: [{ path: '~/a', depth: 1 }], inbox_dirs: ['~/b'], butler_cwd: null, butler_cwd_source: 'none' },
        }
      }
      if (url.includes('/config/ops-skills')) {
        return { file: '~/AGENTS.md', template: 'ops', attached: { ok: true, attached: ['写稿'], expected: ['写稿'], absent: [], stray: [] } }
      }
      if (url.includes('/template')) {
        return {
          current: 'ops', template: 'ops', has_backup: true, last_backup_at: '09-27 21:14',
          templates: [
            { id: 'base', name: '基础', tagline: '什么活都能接', current: false, project_word: '项目', apps: [], board_lanes: [] },
            { id: 'ops', name: '自媒体运营', tagline: '选题到复盘', current: true, project_word: '选题', apps: [], board_lanes: [] },
          ],
        }
      }
      if (url.includes('/modules')) return { modules: [{ id: 'm1', title: '本周数据' }], trash: [] }
      if (url.includes('/model')) return { mode: 'relay', ready: true, relay_token_configured: true, own_key_configured: false }
      if (url.includes('/update/check')) return { current: '0.4.52', latest: '0.4.52' }
      return { deepseek: false, kimi_web: false, claude_api: false, ok: true }
    })()
    return { ok: true, status: 200, json: async () => body }
  }) as unknown as typeof fetch
}

const PEAK = {
  phase: 'peak' as const,
  next_phase: 'offpeak' as const,
  next_switch: '18:02',
  periods: [{ start: '08:58', end: '12:02' }],
}

function renderFull() {
  return render(
    <SettingsDialog
      baseUrl="http://x"
      fetchImpl={fullFetch()}
      onClose={() => {}}
      peak={PEAK}
      currentVersion="0.4.52"
      butler={{ running: true, port: 8792 }}
      meetings={{ dir: '/Users/example/repo/会议' }}
      connector={{ phase: 'ready', installed: true, running: true, port: 7601, version: '1.0.0', downloadBytes: 0, hosts: [] }}
      devices={{
        lan: { enabled: true, host: '10.0.0.2', port: 8791, advertising: true },
        devices: [],
      }}
      account={{ username: 'ben', registered: true, logged_in: true }}
      onOpenSetup={() => {}}
      onReplayFirstRun={() => {}}
      onRedoOnboarding={() => {}}
    />,
  )
}

describe('① 分组切换:一次只看一组', () => {
  it('顶上一排就是 SETTINGS_GROUPS,第一组默认选中', () => {
    renderFull()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(one => one.textContent)).toEqual(SETTINGS_GROUPS.map(one => one.label))
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('点另一组:这一组的节出来,上一组的节整块走掉(不是藏起来,是不在 DOM 里)', async () => {
    renderFull()
    expect(await screen.findByRole('heading', { name: '记住的规矩' })).toBeTruthy()
    await openGroup(GROUP.devices)
    expect(screen.getByRole('heading', { name: '已连接设备' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '记住的规矩' })).toBeNull()
    await openGroup(GROUP.butler)
    expect(await screen.findByRole('heading', { name: '记住的规矩' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '已连接设备' })).toBeNull()
  })

  it('★ 一节都没少:六组走一遍,原来那一条长滚动上的每一节都还在', async () => {
    renderFull()
    const seen = new Set<string>()
    // 每节各自拉各自的数据:先等第一组填满,再一组组翻,免得数到一半还没回来的那几节。
    await screen.findByRole('heading', { name: '记住的规矩' })
    for (const one of SETTINGS_GROUPS) {
      await openGroup(one.label)
      await new Promise(resolve => setTimeout(resolve, 0))
      for (const heading of screen.getAllByRole('heading')) {
        if (heading.textContent !== null) seen.add(heading.textContent)
      }
    }
    // 09-28 之前那条长滚动上的十七节,一个不落(标题改过名的按新名字算;10-22 照评审页又改过一轮名,
    // 「电脑睡不睡」与「出门时」并成「电脑保持唤醒」一节,「更新」拆成「应用更新 / 运行环境」两节)。
    for (const title of [
      '记住的规矩', '它学到了什么', '哨兵', '形象与音色',
      '已连接设备', '电脑保持唤醒', '连接状态',
      '各家能做什么', '模型服务', '各家的登录与密钥',
      '工作台账号', '工作布局', '自定义组件',
      '应用更新', '运行环境',
      '目录', '峰谷时段', '连接器', '体检与引导',
    ]) {
      expect(seen, `少了「${title}」`).toContain(title)
    }
  })
})

describe('② 每一节最多一颗主按钮', () => {
  it('★ 六组各自数一遍:任何一节里主按钮(描边 / 实心)都不超过一颗', async () => {
    const { container } = renderFull()
    await screen.findByRole('heading', { name: '记住的规矩' })
    for (const one of SETTINGS_GROUPS) {
      await openGroup(one.label)
      await new Promise(resolve => setTimeout(resolve, 0))
      const sections = container.querySelectorAll('.ben-wb__setgrp section')
      expect(sections.length, `「${one.label}」这一组一节都没渲染出来,这条断言就是空的`).toBeGreaterThan(0)
      for (const section of sections) {
        const primary = section.querySelectorAll('[data-kind=outline],[data-kind=primary]')
        const title = section.querySelector('h2,h3')?.textContent ?? '(没标题)'
        expect(primary.length, `「${title}」这一节有 ${primary.length} 颗主按钮`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('★ 次要动作长成文字链接,不是第二颗一样重的按钮', async () => {
    renderFull()
    await openGroup(GROUP.advanced)
    const setup = screen.getByRole('heading', { name: '体检与引导' }).closest('section')
    expect(setup).not.toBeNull()
    const box = within(setup as HTMLElement)
    expect(box.getByRole('button', { name: '开始体检' })).toHaveAttribute('data-kind', 'outline')
    expect(box.getByRole('button', { name: '重新走一遍首次流程' })).toHaveAttribute('data-kind', 'plain')
    expect(box.getByRole('button', { name: '打开「重新设置工作台」' })).toHaveAttribute('data-kind', 'plain')
  })
})

describe('③ 高级默认折叠', () => {
  it('★ 打开设置时,「高级」里那几节一个都不在屏上', () => {
    renderFull()
    for (const title of ['目录', '峰谷时段', '连接器', '体检与引导']) {
      expect(screen.queryByRole('heading', { name: title }), `「${title}」不该一上来就在屏上`).toBeNull()
    }
    // 但那一组的门一直在,不是把功能藏没了。
    expect(screen.getByRole('tab', { name: GROUP.advanced })).toBeTruthy()
  })

  it('★ 点了「高级」才出来,并且四节都出来(不可改清单上的那几个入口一个不能丢)', async () => {
    renderFull()
    await openGroup(GROUP.advanced)
    for (const title of ['目录', '峰谷时段', '连接器', '体检与引导']) {
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy()
    }
  })

  it('「高级」是最后一组,不抢默认那一组的位置', () => {
    expect(SETTINGS_GROUPS[SETTINGS_GROUPS.length - 1]?.id).toBe('advanced')
    expect(SETTINGS_GROUPS[0]?.id).not.toBe('advanced')
  })
})

describe('④ 界面上不说程序员的话', () => {
  it('★ 六组走一遍,屏上不出现「命令行 / CLI / API Key / token / JSON / 环境变量」这类词', async () => {
    const { container } = renderFull()
    const banned = ['命令行', 'CLI', 'API Key', 'api key', 'JSON', '环境变量', 'setup-token', 'launchd', 'endpoint']
    for (const one of SETTINGS_GROUPS) {
      await openGroup(one.label)
      const text = container.textContent ?? ''
      for (const word of banned) {
        expect(text.includes(word), `「${one.label}」这一组里出现了「${word}」`).toBe(false)
      }
    }
  })
})
