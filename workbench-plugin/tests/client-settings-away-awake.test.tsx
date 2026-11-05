/**
 * 设置弹窗里那一行「出门时电脑不睡」(2026-10-03,卡「出门时电脑不睡」;**缺省关**)。
 *
 * 它就摆在「工作台开着时电脑不睡」旁边 —— 两颗都是「我不在电脑前的时候这台电脑该怎么办」,
 * 一颗管整机、一颗管屏幕。这一节测四件事:**缺省关**、点一下落到 POST、
 * 「这会儿手机在不在外面」那一行**不知道就说不知道**、旧插件(404)整节不出现。
 *
 * 写法对齐 client-settings-system-awake.test.tsx(同一组、同一套 fetch 假件)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AWAY_AWAKE_LABEL,
  AWAY_NO_RELAY_LINE,
  awayAwakeHint,
  awayAwakePhoneLine,
  SettingsDialog,
  SYSTEM_AWAKE_LABEL,
} from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

function stub(over: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: { url: string, method: string, body: any }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const custom = over(url, init)
    if (custom !== undefined) return custom
    // 旁边那颗「工作台开着时电脑不睡」也要答得出来 —— 两颗并排摆着那一条测的就是它们各自独立。
    if (url.endsWith('/shell/system-awake')) {
      const payload = init?.method === 'POST'
        ? { ok: true, enabled: JSON.parse(String(init.body)).enabled, applied: true }
        : { enabled: true }
      return { ok: true, status: 200, json: async () => payload } as Response
    }
    if (url.endsWith('/shell/away-keep-awake')) {
      const payload = init?.method === 'POST'
        ? { ok: true, enabled: JSON.parse(String(init.body)).enabled, phone_away: true, active: JSON.parse(String(init.body)).enabled, applied: true }
        : { enabled: false, phone_away: true, active: false }
      return { ok: true, status: 200, json: async () => payload } as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function open(over?: Parameters<typeof stub>[0]) {
  const { impl, calls } = stub(over)
  render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
  await openGroup(GROUP.devices)
  return { calls }
}

/** 10-22 起两颗开关的代价那几句与「这会儿手机在不在外面」收在「代价与说明」里(评审页那两行只留一句短的),一点就开。 */
async function costs(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: '代价与说明' }))
}

describe('这台没接中转(零服务器档)', () => {
  it('「代价与说明」里说「这台没接中转」,不说「问不到」也不说「在外面连着」', async () => {
    const { impl } = stub()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} relayConfigured={false} />)
    await openGroup(GROUP.devices)
    await screen.findByLabelText(AWAY_AWAKE_LABEL)
    await costs()
    expect(screen.getByText(AWAY_NO_RELAY_LINE)).toBeInTheDocument()
    expect(screen.queryByText(awayAwakePhoneLine(true))).not.toBeInTheDocument()
  })
})

describe('出门在外的时候那一节', () => {
  it('★★挂载就读回来:**缺省关**;旁边那句话把代价说清(屏一直亮着)、也说清为什么要它(锁屏送不进)', async () => {
    await open()
    const box = await screen.findByLabelText(AWAY_AWAKE_LABEL) as HTMLInputElement
    expect(box.checked, '★缺省关').toBe(false)
    await costs()
    expect(screen.getByText(awayAwakeHint(false))).toBeInTheDocument()
    expect(awayAwakeHint(true), '代价:她看不见家里那块屏亮着,所以必须写出来').toContain('一直亮着')
    expect(awayAwakeHint(true)).toContain('锁屏')
    expect(awayAwakeHint(false), '关着那一句要说清后果:排着等她回家解锁').toContain('解锁')
    // 不许出现内部词:她不是程序员。
    for (const jargon of ['断言', 'assertion', 'idle', 'IOPM', 'PreventUserIdle']) {
      expect(awayAwakeHint(true)).not.toContain(jargon)
      expect(awayAwakeHint(false)).not.toContain(jargon)
    }
  })

  it('★和「工作台开着时电脑不睡」是两颗,同一组里并排摆着(她问「要怎样才能不锁屏」时分得清)', async () => {
    await open()
    expect(await screen.findByLabelText(AWAY_AWAKE_LABEL)).toBeInTheDocument()
    expect(await screen.findByLabelText(SYSTEM_AWAKE_LABEL)).toBeInTheDocument()
    expect(AWAY_AWAKE_LABEL).not.toBe(SYSTEM_AWAKE_LABEL)
  })

  it('★点一下打开 → POST {enabled:true},壳当场生效就说「已经生效」', async () => {
    const { calls } = await open()
    const box = await screen.findByLabelText(AWAY_AWAKE_LABEL)
    await costs()
    await userEvent.click(box)
    // 这一屏里别的节也各自在发请求,所以只挑打到这条路由的那一条。
    const mine = () => calls.find(c => c.method === 'POST' && c.url.endsWith('/shell/away-keep-awake'))
    await waitFor(() => expect(mine()).toBeDefined())
    expect(mine()!.body).toEqual({ enabled: true })
    expect(await screen.findByText('已经生效')).toBeInTheDocument()
    expect(screen.getByText(awayAwakeHint(true))).toBeInTheDocument()
  })

  it('★★「这会儿手机在不在外面」:在外面连着那一行就说在外面', async () => {
    await open()
    await screen.findByLabelText(AWAY_AWAKE_LABEL)
    await costs()
    expect(screen.getByText(awayAwakePhoneLine(true))).toBeInTheDocument()
    expect(awayAwakePhoneLine(true)).toContain('在外面连着')
  })

  it('★★那一格缺席(没接通道层 / 工人掉线)→ **说问不到**,不许显示成「没在外面」', async () => {
    await open(url => url.endsWith('/shell/away-keep-awake')
      ? ({ ok: true, status: 200, json: async () => ({ enabled: true }) } as Response)
      : undefined)
    await screen.findByLabelText(AWAY_AWAKE_LABEL)
    await costs()
    expect(screen.getByText(awayAwakePhoneLine(undefined))).toBeInTheDocument()
    expect(awayAwakePhoneLine(undefined)).toContain('问不到')
    expect(awayAwakePhoneLine(undefined)).not.toBe(awayAwakePhoneLine(false))
  })

  it('★壳没接上:如实说「重开工作台后生效」,不谎称已经生效', async () => {
    await open((url, init) => url.endsWith('/shell/away-keep-awake') && init?.method === 'POST'
      ? ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: true, applied: false, reason: '工作台 App 未运行' }) } as Response)
      : undefined)
    await userEvent.click(await screen.findByLabelText(AWAY_AWAKE_LABEL))
    expect(await screen.findByText(/重开工作台后生效/)).toBeInTheDocument()
    expect(screen.queryByText('已经生效')).not.toBeInTheDocument()
  })

  it('旧插件(404)→ 整节不出现,不摆一颗点不动的开关', async () => {
    await open(url => url.endsWith('/shell/away-keep-awake')
      ? ({ ok: false, status: 404, json: async () => ({ error: '工作台开关未启用' }) } as Response)
      : undefined)
    // 别的节照常出现(每节各自独立),就是没有这一节。旁边那颗「电脑不睡」还在。
    expect(await screen.findByLabelText(SYSTEM_AWAKE_LABEL)).toBeInTheDocument()
    expect(screen.queryByLabelText(AWAY_AWAKE_LABEL)).not.toBeInTheDocument()
  })
})
