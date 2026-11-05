/**
 * 壳里挡住上游首次设置框(2026-09-23)。前半验我们这一步的行为;后半是**自检**:读链进来的上游源码,
 * 确认「只画第一个没 complete 的那一步、按 order 升序」和上游两步的 order 还是那样 —— 变了就红,
 * 提醒重看 src/client/onboardingGate.ts(不然壳里又会弹「添加一个 API Key」并锁住整页)。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { GATE_ID, GATE_ORDER, ShellOnboardingGate, shellGateHolds } from '../src/client/onboardingGate.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { window.history.replaceState(null, '', '/') })

function render(complete: () => void) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => { root.render(createElement(ShellOnboardingGate, { complete })) })
  const html = host.innerHTML
  act(() => { root.unmount() })
  host.remove()
  return html
}

describe('ShellOnboardingGate', () => {
  it('壳里(?ben-workbench=app):不画、不 complete —— 后面的上游步骤排不到', () => {
    window.history.replaceState(null, '', '/?ben-workbench=app')
    const complete = vi.fn()
    expect(shellGateHolds()).toBe(true)
    expect(render(complete)).toBe('')
    expect(complete).not.toHaveBeenCalled()
  })
  it('浏览器里直接开 DSH:马上 complete,上游照旧', () => {
    const complete = vi.fn()
    expect(shellGateHolds()).toBe(false)
    expect(render(complete)).toBe('')
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it('apply 把它排进 settings.onboarding,在上游两步之前', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('uiWorkspace', { connectWorkspace: async () => 's', openSession: vi.fn() } as never)
    const slots = ctx.get('slots') as SlotRegistry
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('settings.onboarding' as never)).toHaveLength(0)
    slots.register({ name: 'root', children: { 'settings.onboarding': { kind: 'list', scope: 'root' } } } as never, () => null)
    const entry = slots.entries('settings.onboarding' as never)[0]
    expect(entry?.component).toBe(ShellOnboardingGate)
    expect(entry?.options).toMatchObject({ id: GATE_ID, order: GATE_ORDER })
  })
})

describe('自检:上游 settings.onboarding 的排法没变(变了就重看 onboardingGate.ts)', () => {
  // 上游 checkout 在哪:默认 worktree 父目录那个共用符号链接,升级卡用 DSH_HARNESS_DIR 指到自己的
  // checkout(共用那份同时还有别的卡在旧版上跑,不能切 tag)。同 vitest.config.ts 的口子。
  const harnessDir = process.env.DSH_HARNESS_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deepseek-harness')
  const root = join(harnessDir, 'packages', 'client')
  const harness = (rel: string) => readFileSync(join(root, rel), 'utf8')
  it('SettingsRoot 只画第一个没 complete 的那一步;步骤按 order 升序', () => {
    expect(harness('ui-settings-general/src/client/SettingsRoot.tsx')).toContain('onboardingSteps.find(step => !completedOnboarding.has(step.id))')
    expect(harness('ui-settings-general/src/client/index.ts')).toMatch(/\.sort\(\(a, b\) => a\.order - b\.order\)/)
  })
  it('上游两步的 order 都比我们大', () => {
    const models = harness('ui-settings-models/src/client/index.ts')
    // 0.1.7-rc.2:deepseek-official 那一步的 id 与 order 之间多了一行 children,所以中间放宽成非贪婪。
    const orders = [...models.matchAll(/name: 'settings\.onboarding',\s*id: '([^']+)',[\s\S]*?order: (-?\d+)/g)].map(m => [m[1], Number(m[2])] as const)
    expect(orders.map(([id]) => id)).toEqual(['welcome-notice', 'deepseek-official'])
    for (const [, order] of orders) expect(order).toBeGreaterThan(GATE_ORDER)
  })
  /**
   * 0.1.7-rc.2 多出来的「点名要某一步」那条绕过口(升级卡 U2 复核)。
   * 我们这一步只挡「按 order 取第一个没 complete 的」,点名那条挡不住;
   * 挡它的地方在 profile patch(把账号那套界面关掉)。这两条钉住那个事实:
   * 点名的唯一入口是 settings.launcher 的 openOnboarding,而全上游只有 AccountMenu 调它。
   * 哪天多出第二个调用者,这里当场红 —— 那时要么 patch 里也关掉它,要么这一步改成「点名也拦」。
   */
  it('★点名绕过口只有一个入口:settings.launcher 的 openOnboarding', () => {
    const settingsRoot = harness('ui-settings-general/src/client/SettingsRoot.tsx')
    expect(settingsRoot).toContain('onboardingSteps.find(step => step.id === requestedOnboarding)')
    expect(settingsRoot).toContain('openOnboarding: (id) => { close(); setRequestedOnboarding(id) }')
    expect(harness('ui-settings/src/client/contract/slots.ts')).toContain('openOnboarding: (id: string) => void')
  })
  it('★全上游只有 ui-settings-account 的 AccountMenu 点名(账号界面关掉,这条口就不存在)', () => {
    const callers = [...clientPackages()].filter((pkg) => {
      const files = sourceFiles(join(root, pkg, 'src'))
      return files.some(f => /\bopenOnboarding\(/.test(readFileSync(f, 'utf8')))
    })
    expect(callers).toEqual(['ui-settings-account'])
  })
})

/** `packages/client` 下的包目录名。 */
function clientPackages(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deepseek-harness')
  const base = join(process.env.DSH_HARNESS_DIR ?? dir, 'packages', 'client')
  return readdirSync(base).filter(name => existsSync(join(base, name, 'package.json'))).sort()
}

/** 目录下所有 .ts / .tsx(递归)。 */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}
