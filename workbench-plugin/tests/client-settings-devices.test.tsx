import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog, revokeConfirmText } from '../src/client/SettingsDialog.tsx'
import type { DevicesSection } from '../src/client/SettingsDialog.tsx'
import { qrPath } from '../src/client/PairQr.tsx'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

function fetchSpy() {
  const calls: { url: string, body: unknown }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return { ok: true, json: async () => ({ ok: true, deepseek: false, kimi_web: false, claude_api: false }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function section(over: Partial<DevicesSection> = {}): DevicesSection {
  return {
    lan: { enabled: false, host: '10.86.37.27', port: 8791, advertising: false },
    devices: [],
    ...over,
  }
}

describe('设置 · 手机与设备(2026-09-11 手机配对)', () => {
  it('没接配对服务(不传 devices)时这一节整块不渲染', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
    await openGroup(GROUP.devices)
    expect(screen.queryByRole('heading', { name: '已连接设备' })).toBeNull()
  })

  it('开关反映 lan.enabled;点一下 POST /lan {enabled:true};关着时提示手机连不上', async () => {
    const { impl, calls } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section()} />)
    await openGroup(GROUP.devices)
    const box = screen.getByRole('checkbox', { name: '允许手机在局域网访问' })
    expect(box).not.toBeChecked()
    expect(screen.getByText(/开关关着时,手机连不上工作台/)).toBeTruthy()
    await userEvent.click(box)
    expect(calls.find(call => call.url === 'http://x/lan')?.body).toEqual({ enabled: true })
  })

  it('开着时显示本机地址与端口、广播状态;「添加手机或座机」(原「生成二维码」,10-22 照评审页改字)POST /pair/start(码仍一起生成,接口不变)', async () => {
    const { impl, calls } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={section({ lan: { enabled: true, host: '10.86.37.27', port: 8791, advertising: true } })} />)
    await openGroup(GROUP.devices)
    expect(screen.getByRole('checkbox', { name: '允许手机在局域网访问' })).toBeChecked()
    expect(screen.getByText(/10\.86\.37\.27:8791/)).toBeTruthy()
    expect(screen.getByText(/正在局域网内广播/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '添加手机或座机' }))
    expect(screen.queryByRole('button', { name: '生成配对码' })).toBeNull()
    expect(calls.some(call => call.url === 'http://x/pair/start')).toBe(true)
  })

  it('有二维码:二维码放大居中在上,文案「用手机上的「事务官」扫这个」;6 位码在下面小字「扫不了就在手机上手输:004217」', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={section({
        lan: { enabled: true, host: '10.86.37.27', port: 8791, advertising: true },
        pairing: { code: '004217', expires_at: '2026-09-11T10:05:00.000Z', qr: 'workbench://pair?host=10.86.37.27&port=8791&code=004217' },
      })} />)
    await openGroup(GROUP.devices)
    const pair = screen.getByRole('img', { name: '配对二维码' }).closest('.ben-wb__devices-pair')!
    expect(pair).toBeTruthy()
    const qr = within(pair as HTMLElement).getByRole('img', { name: '配对二维码' })
    expect(qr.getAttribute('width')).toBe('240')
    expect(within(pair as HTMLElement).getByText('用手机上的「事务官」扫这个')).toBeTruthy()
    const fallback = within(pair as HTMLElement).getByText(/扫不了就在手机上手输/)
    expect(fallback).toHaveTextContent('扫不了就在手机上手输:004217')
    expect(fallback.className).toContain('ben-wb__devices-code')
    // 顺序:二维码在前,提示文案其次,6 位码在后
    const html = (pair as HTMLElement).innerHTML
    expect(html.indexOf('配对二维码')).toBeLessThan(html.indexOf('用手机上的'))
    expect(html.indexOf('用手机上的')).toBeLessThan(html.indexOf('扫不了就在手机上手输'))
    // 有效期与次数限制写在二维码底下(10-22 起不再挂在按钮旁边)
    expect(within(pair as HTMLElement).getByText(/前有效 · 用一次就作废;错 5 次锁 10 分钟/)).toBeTruthy()
  })

  it('取不到局域网地址:没有二维码,只显示 6 位码「在手机上手输:004217」,说明原因', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={section({
        lan: { enabled: true, port: 8791, advertising: true },
        pairing: { code: '004217', expires_at: '2026-09-11T10:05:00.000Z' },
      })} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/在手机上手输/)).toHaveTextContent('在手机上手输:004217')
    expect(screen.queryByRole('img', { name: '配对二维码' })).toBeNull()
    expect(screen.getByText(/没有局域网地址就没有二维码/)).toBeTruthy()
    expect(screen.getByText(/取不到本机的局域网地址/)).toBeTruthy()
  })

  it('已配对设备列表:名字、平台、最近连接;「撤销连接」(原「解除配对」)POST /pair/revoke {id}', async () => {
    const { impl, calls } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={section({
        devices: [
          { id: 'd1', name: 'Ben 的 iPhone', platform: 'ios', created_at: '2026-09-11T01:00:00.000Z', last_seen_at: '2026-09-11T02:30:00.000Z' },
          { id: 'd2', name: '展示台', platform: 'android', created_at: '2026-09-11T01:00:00.000Z', last_seen_at: '2026-09-11T01:00:00.000Z' },
        ],
      })} />)
    await openGroup(GROUP.devices)
    const list = screen.getByRole('list', { name: '已配对设备' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ben 的 iPhone')
    expect(rows[0]).toHaveTextContent('ios')
    expect(rows[0]).toHaveTextContent(/最近连接/)
    // 2026-09-25 起撤之前先问一句;10-22 起是共用的确认弹层「撤销设备连接?」,话说清撤的是什么(revokeConfirmText)。
    await userEvent.click(within(rows[0]!).getByRole('button', { name: '撤销连接' }))
    expect(calls.some(call => call.url === 'http://x/pair/revoke')).toBe(false)
    const ask = screen.getByRole('dialog', { name: CONFIRMS.revokeDevice.title })
    expect(ask).toHaveTextContent('撤销「Ben 的 iPhone」的连接,只撤这台电脑对它的信任')
    await userEvent.click(within(ask).getByRole('button', { name: CONFIRMS.revokeDevice.confirm }))
    expect(calls.find(call => call.url === 'http://x/pair/revoke')?.body).toEqual({ id: 'd1' })
  })

  it('一台都没配时如实写「还没有配对的设备」', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section()} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/还没有配对的设备/)).toBeTruthy()
  })
})

describe('二维码路径', () => {
  it('同一段文本画出来的模块数固定且是确定的;空串也不抛', async () => {
    const a = qrPath('workbench://pair?host=10.86.37.27&port=8791&code=004217')
    const b = qrPath('workbench://pair?host=10.86.37.27&port=8791&code=004217')
    expect(a.size).toBeGreaterThan(20)
    expect(a).toEqual(b)
    expect(a.d.startsWith('M')).toBe(true)
    expect(qrPath('').size).toBeGreaterThan(0)
  })
})

/**
 * 设备那一行显示什么(2026-09-21,座机形态:手机 + 树莓派话筒)。
 *
 * 「在线」在这儿的意思很窄:**最近两分钟向 8791 报过到**。出了局域网报不到就显示
 * 离线 —— 那台设备可能正在房间里好好待着。这一组把那个口径钉住,免得下一个人
 * 以为它是「房里有没有人」。
 */
describe('设置 · 我的设备:话筒与在线', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  function one(over: Partial<DevicesSection['devices'][number]> = {}) {
    return section({
      devices: [{
        id: 'd1', name: '座机话筒', platform: 'handset', kind: 'handset' as const,
        created_at: at(86_400_000), last_seen_at: at(10_000), ...over,
      }],
    })
  }

  it('树莓派那台显示成「话筒(树莓派)」,不是「handset」', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={one()} />)
    await openGroup(GROUP.devices)
    expect(within(screen.getByRole('list', { name: '已配对设备' })).getByText(/树莓派/)).toBeTruthy()
  })

  it('刚报过到的显示在线', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={one()} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/· 在线/)).toBeTruthy()
  })

  it('★ 很久没报到的显示离线,并且**还是把最近连接那个时刻写出来** —— 不粉饰', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={one({ last_seen_at: at(3 * 60 * 60 * 1000) })} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/离线 · 最近连接 /)).toBeTruthy()
  })

  it('老工作台的回包没有 kind:照旧显示 platform 原文,不凭空说成「手机」', async () => {
    const { impl } = fetchSpy()
    const legacy = section({
      devices: [{ id: 'd2', name: '我的手机', platform: 'android', created_at: at(0), last_seen_at: at(0) }],
    })
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={legacy} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/android/)).toBeTruthy()
  })

  it('kind 是 phone 时显示「手机」', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}}
      devices={one({ id: 'd3', name: '我的手机', platform: 'android', kind: 'phone' as const })} />)
    await openGroup(GROUP.devices)
    expect(screen.getByText(/手机 · /)).toBeTruthy()
  })
})

/**
 * 2026-09-25(卡 fix/evening-gaps 第 2 条):统筹在真壳里「从上翻到下」没找到这一节;
 * 手机配对页写的正是「设置 → 手机与设备 → 生成二维码」,首次流程之后要配第二台手机只有这个入口。
 */
describe('★ 手机与设备:排在前面、能改名、解除配对先问一句', () => {
  const devicesList = [
    { id: 'd1', name: '小米测试机', platform: 'android', kind: 'phone' as const, created_at: '2026-09-24T01:00:00.000Z', last_seen_at: '2026-09-24T02:30:00.000Z' },
  ]

  /**
   * 2026-09-28(卡 SG):「排在第几节」这条断言不再成立,也不该再有 —— 这一屏改成了分组,
   * 没有"第几节"这回事了。要钉住的东西换成**一样的那件事**:它是「手机与座机」那一组的
   * 第一节,而且那一组的名字就在顶上那一排里,翻不丢。
   */
  it('★ 它是「手机与座机」那一组的第一节,组名就在顶上那一排里', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section({ devices: devicesList })} />)
    expect(screen.getByRole('tab', { name: GROUP.devices })).toBeTruthy()
    await openGroup(GROUP.devices)
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const headings = within(dialog).getAllByRole('heading').map(h => h.textContent)
    // 2026-10-21 起组名在内容顶上也写一遍(设置 01),它不算一节
    // 10-22 起这一节照评审页叫「已连接设备」
    expect(headings.filter(one => one !== '设置' && one !== GROUP.devices)[0]).toBe('已连接设备')
  })

  it('★ 撤销连接点「取消」:什么都不发', async () => {
    const { impl, calls } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section({ devices: devicesList })} />)
    await openGroup(GROUP.devices)
    await userEvent.click(screen.getByRole('button', { name: '撤销连接' }))
    const ask = screen.getByRole('dialog', { name: CONFIRMS.revokeDevice.title })
    expect(ask).toHaveTextContent(revokeConfirmText(devicesList[0]!))
    await userEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: CONFIRMS.revokeDevice.title })).toBeNull()
    expect(calls.some(call => call.url === 'http://x/pair/revoke')).toBe(false)
  })

  it('★ 改名:点「改名」就地改,回车存 → POST /pair/rename {id, name}(去掉首尾空白)', async () => {
    const { impl, calls } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section({ devices: devicesList })} />)
    await openGroup(GROUP.devices)
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    const box = screen.getByRole('textbox', { name: '给「小米测试机」改名' })
    await userEvent.clear(box)
    await userEvent.type(box, '  客厅那台  {Enter}')
    expect(calls.find(call => call.url === 'http://x/pair/rename')?.body).toEqual({ id: 'd1', name: '客厅那台' })
    // 存完收起输入框(新名字以下一拍 /state 为准)。
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '给「小米测试机」改名' })).toBeNull())
  })

  it('改名:没改 / 空名字 / 取消 → 什么都不发;Esc 只收起输入框、不关设置', async () => {
    const { impl, calls } = fetchSpy()
    const onClose = vi.fn()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={onClose} devices={section({ devices: devicesList })} />)
    await openGroup(GROUP.devices)
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    await userEvent.click(screen.getByRole('button', { name: '保存「小米测试机」的新名字' }))
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    await userEvent.clear(screen.getByRole('textbox', { name: '给「小米测试机」改名' }))
    await userEvent.click(screen.getByRole('button', { name: '保存「小米测试机」的新名字' }))
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    await userEvent.type(screen.getByRole('textbox', { name: '给「小米测试机」改名' }), '不要了')
    await userEvent.click(screen.getByRole('button', { name: '不改「小米测试机」的名字' }))
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    await userEvent.type(screen.getByRole('textbox', { name: '给「小米测试机」改名' }), '别存{Escape}')
    expect(screen.queryByRole('textbox', { name: '给「小米测试机」改名' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(calls.some(call => call.url === 'http://x/pair/rename')).toBe(false)
  })

  it('改名没成(工作台回错):留着输入框,说一句', async () => {
    const impl = vi.fn(async (url: string) => (String(url).endsWith('/pair/rename')
      ? { ok: false, status: 404, json: async () => ({ error: '没有这台设备' }) }
      : { ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section({ devices: devicesList })} />)
    await openGroup(GROUP.devices)
    await userEvent.click(screen.getByRole('button', { name: '改名:小米测试机' }))
    await userEvent.type(screen.getByRole('textbox', { name: '给「小米测试机」改名' }), '2{Enter}')
    expect(await screen.findByText(/没改成/)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '给「小米测试机」改名' })).toBeTruthy()
  })
})

/**
 * 卡 HR(2026-09-28,维护者:「座机找不到,我在另一台 Air 上已经把座机解除配对了」)。
 *
 * 查出来的实情:本机这条「解除配对」只把 `~/.dsh/workbench/devices.json` 里那条记录标上
 * `revokedAt`(server/devices.ts 的 revoke),**一个字节都没碰账号那边**——座机手里那把
 * 中转设备令牌(`/channel/relay-handset` 领的,记在 relay 的 tokens 表里)照旧有效,
 * 它照旧领得到进房凭证、照旧进得了账号房间,提机照旧有人接。
 *
 * 所以这一节验的是**那句确认话别再撒谎**:以前写「这台话筒要重新扫码才能连回来」——
 * 两处都不对(座机不扫码;而且它压根没「断」)。现在要说清三件事:
 *   ① 撤的只是这台电脑的信任;② 账号那把钥匙不动,提机照样有人接;③ 想连回这台电脑怎么做。
 */
describe('★ 卡 HR:解除配对那句话要说清「账号那把钥匙不动」', () => {
  const handset = {
    id: 'h1', name: '座机话筒', platform: 'handset', kind: 'handset' as const,
    created_at: '2026-09-27T01:00:00.000Z', last_seen_at: '2026-09-28T02:30:00.000Z',
  }
  const phone = {
    id: 'd1', name: '小米测试机', platform: 'android', kind: 'phone' as const,
    created_at: '2026-09-24T01:00:00.000Z', last_seen_at: '2026-09-24T02:30:00.000Z',
  }

  it('★ 座机:不提「扫码」(它没有摄像头),说的是手机上「添加座机」再走一次', () => {
    const said = revokeConfirmText(handset)
    expect(said).not.toContain('扫码')
    expect(said).toContain('添加座机')
  })

  it('★ 座机与手机都说清:只撤这台电脑,账号那把钥匙不动,要彻底移除去「账号 → 我的设备」', () => {
    for (const device of [handset, phone]) {
      const said = revokeConfirmText(device)
      expect(said).toContain('只撤这台电脑')
      expect(said).toContain('账号')
      expect(said).toContain('我的设备')
    }
  })

  it('★ 手机那一行照旧说「重新扫一次码」(它有摄像头,入口就是二维码)', () => {
    expect(revokeConfirmText(phone)).toContain('扫')
  })

  it('★ 设备列表底下有一句:座机没列在这儿不等于丢了', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section({ devices: [phone] })} />)
    await openGroup(GROUP.devices)
    // 10-22 起这句收在「没看到座机?」那颗文字键里,一点就开
    await userEvent.click(screen.getByRole('button', { name: '没看到座机?' }))
    expect(screen.getByText(/座机没列在这儿不等于丢了/)).toBeTruthy()
  })

  it('★ 一台都没配对时也有那句话:他正是在这一屏上找不到座机的', async () => {
    const { impl } = fetchSpy()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} devices={section()} />)
    await openGroup(GROUP.devices)
    // 10-22 起这句收在「没看到座机?」那颗文字键里,一点就开
    await userEvent.click(screen.getByRole('button', { name: '没看到座机?' }))
    expect(screen.getByText(/座机没列在这儿不等于丢了/)).toBeTruthy()
  })
})
