/**
 * 设置弹窗里那一行「工作台开着时电脑不睡」(2026-09-28,卡 AW)。
 *
 * 维护者 09-28 早,新 Air、不插电:「电脑自己会锁屏,可能跟没插电有关系,一锁屏小米上就显示
 * 找不到你的电脑。」这一节只有一颗开关(默认开)+ 一句人话说清代价 —— 不插电时更费电,
 * 而屏幕照样会黑会锁。测三件事:默认开、点一下落到 POST、旧插件(404)整节不出现。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog, SYSTEM_AWAKE_LABEL, systemAwakeHint } from '../src/client/SettingsDialog.tsx'
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
    if (url.endsWith('/shell/system-awake')) {
      const payload = init?.method === 'POST'
        ? { ok: true, enabled: JSON.parse(String(init.body)).enabled, applied: true }
        : { enabled: true }
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

describe('电脑睡不睡那一节', () => {
  it('★挂载就读回来:默认开着,旁边那句话把代价说清(费电)、也把边界说清(屏幕照样会黑会锁)', async () => {
    await open()
    const box = await screen.findByLabelText(SYSTEM_AWAKE_LABEL) as HTMLInputElement
    expect(box.checked).toBe(true)
    // 10-22 起代价那句收在「代价与说明」里(评审页那一行只留一句短的),一点就开。
    await userEvent.click(screen.getByRole('button', { name: '代价与说明' }))
    expect(screen.getByText(systemAwakeHint(true))).toBeInTheDocument()
    expect(systemAwakeHint(true)).toContain('费电')
    expect(systemAwakeHint(true)).toMatch(/屏幕照样会黑、会锁/)
    // 不许出现内部词:她不是程序员。
    for (const jargon of ['断言', 'assertion', 'idle', 'IOPM']) {
      expect(systemAwakeHint(true)).not.toContain(jargon)
      expect(systemAwakeHint(false)).not.toContain(jargon)
    }
  })

  it('★点一下关掉 → POST {enabled:false},壳当场生效就说「已经生效」', async () => {
    const { calls } = await open()
    const box = await screen.findByLabelText(SYSTEM_AWAKE_LABEL)
    await userEvent.click(screen.getByRole('button', { name: '代价与说明' }))
    await userEvent.click(box)
    // 这一屏里别的节也各自在发请求,所以只挑打到这条路由的那一条。
    const mine = () => calls.find(c => c.method === 'POST' && c.url.endsWith('/shell/system-awake'))
    await waitFor(() => expect(mine()).toBeDefined())
    const post = mine()!
    expect(post.body).toEqual({ enabled: false })
    expect(await screen.findByText('已经生效')).toBeInTheDocument()
    // 关掉之后那句话要说清后果:一睡手机就连不上。
    expect(screen.getByText(systemAwakeHint(false))).toBeInTheDocument()
  })

  it('★壳没接上:如实说「重开工作台后生效」,不谎称已经生效', async () => {
    await open((url, init) => url.endsWith('/shell/system-awake') && init?.method === 'POST'
      ? ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false, applied: false, reason: '工作台 App 未运行' }) } as Response)
      : undefined)
    await userEvent.click(await screen.findByLabelText(SYSTEM_AWAKE_LABEL))
    expect(await screen.findByText(/重开工作台后生效/)).toBeInTheDocument()
    expect(screen.queryByText('已经生效')).not.toBeInTheDocument()
  })

  it('旧插件(404)→ 整节不出现,不摆一颗点不动的开关', async () => {
    await open(url => url.endsWith('/shell/system-awake')
      ? ({ ok: false, status: 404, json: async () => ({ error: '工作台开关未启用' }) } as Response)
      : undefined)
    // 别的节照常出现(每节各自独立),就是没有这一节。同一组里的「手机与设备」还在。
    await screen.findByRole('tab', { name: GROUP.devices })
    expect(screen.queryByLabelText(SYSTEM_AWAKE_LABEL)).not.toBeInTheDocument()
  })
})
