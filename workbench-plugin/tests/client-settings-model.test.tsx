/**
 * 设置弹窗里的「模型服务」一节(2026-09-17)。
 *
 * 验的是**一个不懂代码的人看到什么**:默认那一项是选中的、写着不用填任何东西、
 * 今天用了多少一眼看得见;切换过去之后界面跟着变;出问题时说的是人话。
 * 2026-10-22 起照评审页:「用工作台提供的服务」一行开关、「使用自己的账号」一行「选择」(原来是两颗单选)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_NO_RELAY_LINE, ModelPanel } from '../src/client/ModelPanel.tsx'
import { formatTokens, usagePercent } from '../src/client/model.ts'

afterEach(cleanup)

const RELAY_READY = {
  mode: 'relay',
  relay_url: 'https://api.aibooo.cn',
  relay_token_configured: true,
  own_key_configured: false,
  ready: true,
  usage: { day: '2026-09-17', used_tokens: 12_000, daily_token_limit: 50_000, remaining_tokens: 38_000 },
}

function stub(over: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: { url: string, method: string, body: unknown }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const custom = over(url, init)
    if (custom !== undefined) return custom
    if (url.endsWith('/model')) return new Response(JSON.stringify(RELAY_READY), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('「模型服务」一节', () => {
  it('默认那一项写着不用填任何东西,并且是选中的', async () => {
    const { impl } = stub()
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/当前选择,无需填写自己的密钥/)).toBeInTheDocument()
    const relay = screen.getByRole('checkbox', { name: '用工作台提供的服务' })
    await waitFor(() => expect(relay).toBeChecked())
    expect(screen.getByText('正在用')).toBeInTheDocument()
  })

  it('第二项告诉他贴到哪(去哪申请那条链接在「各家的登录与密钥」DeepSeek 那一行里)', async () => {
    const { impl } = stub()
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    const hint = await screen.findByText(/密钥统一在「各家的登录与密钥」维护/)
    expect(hint).toHaveTextContent('各家的登录与密钥')
    // 不出现只有程序员看得懂的词。
    expect(hint.textContent ?? '').not.toMatch(/base ?URL|endpoint|token/i)
  })

  it('今天用了多少一眼看得见', async () => {
    const { impl } = stub()
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/今天已经用了 1\.2 万/)).toBeInTheDocument()
    expect(screen.getByText(/今日上限 5 万/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '今日模型用量' })).toHaveAttribute('aria-valuenow', '24')
  })

  it('★ 中转给了元:显示「今天花了 ¥x.xx / 上限 ¥5」,条按钱算(2026-09-23)', async () => {
    const { impl } = stub(url => (url.endsWith('/model')
      ? new Response(JSON.stringify({
        ...RELAY_READY,
        usage: {
          day: '2026-09-23', used_tokens: 526_000, daily_token_limit: 500_000, remaining_tokens: 0,
          used_cny: 0.3856, daily_cost_limit_cny: 5, remaining_cny: 4.6144,
        },
      }), { status: 200 })
      : undefined))
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/今天花了 ¥0\.39/)).toBeInTheDocument()
    expect(screen.getByText(/上限 ¥5/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '今日模型用量' })).toHaveAttribute('aria-valuenow', '8')
    // token 撞过老上限也不算用完:额度按钱算。
    expect(screen.queryByText(/明天零点自动恢复/)).toBeNull()
  })

  it('按元花满了才说明天恢复', async () => {
    const { impl } = stub(url => (url.endsWith('/model')
      ? new Response(JSON.stringify({
        ...RELAY_READY,
        usage: {
          day: '2026-09-23', used_tokens: 1, daily_token_limit: 500_000, remaining_tokens: 499_999,
          used_cny: 5.01, daily_cost_limit_cny: 5, remaining_cny: 0,
        },
      }), { status: 200 })
      : undefined))
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/明天零点自动恢复/)).toBeInTheDocument()
  })

  it('用完了就说明天恢复,并指一条现在能走的路', async () => {
    const { impl } = stub(url => (url.endsWith('/model')
      ? new Response(JSON.stringify({
        ...RELAY_READY,
        usage: { day: '2026-09-17', used_tokens: 50_000, daily_token_limit: 50_000, remaining_tokens: 0 },
      }), { status: 200 })
      : undefined))
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/明天零点自动恢复/)).toBeInTheDocument()
  })

  it('点第二项就 PUT 过去,界面跟着变', async () => {
    const own = {
      mode: 'own', relay_url: 'https://api.aibooo.cn', relay_token_configured: true,
      own_key_configured: false, ready: false,
    }
    const { impl, calls } = stub((url, init) => (init?.method === 'PUT'
      ? new Response(JSON.stringify({ ok: true, status: own, hints: ['事务官(DSH)那一侧也切回你自己的 Key 了'] }), { status: 200 })
      : undefined))
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    await screen.findByText(/当前选择,无需填写自己的密钥/)

    const ownRow = screen.getByText('使用自己的账号').closest('.ben-wb__srow') as HTMLElement
    await userEvent.click(within(ownRow).getByRole('button', { name: '选择' }))

    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true))
    expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ mode: 'own' })
    expect(await screen.findByText(/还没填密钥/)).toBeInTheDocument()
    expect(screen.getByText(/事务官\(DSH\)那一侧也切回/)).toBeInTheDocument()
  })

  describe('own 档:自己接的端点(2026-10-23,卡「事务官换Key」)', () => {
    const OWN_STATUS = {
      mode: 'own', relay_url: 'https://api.aibooo.cn', relay_token_configured: true,
      own_key_configured: true, ready: true,
      own_base_url: 'https://api.deepseek.com/v1', own_model: 'deepseek-v4-flash',
    }

    it('选「自己的账号」后展开三格:地址与模型名预填,密钥只显示「已填」', async () => {
      const { impl } = stub(url => (url.endsWith('/model')
        ? new Response(JSON.stringify(OWN_STATUS), { status: 200 })
        : undefined))
      render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
      // 地址与模型名预填(都不是秘密)。
      expect(await screen.findByLabelText('模型服务的地址')).toHaveValue('https://api.deepseek.com/v1')
      expect(screen.getByLabelText('模型服务的模型名')).toHaveValue('deepseek-v4-flash')
      // 密钥是密码框、只显示「已填」,永不回显内容。
      const key = screen.getByLabelText('模型服务的密钥')
      expect(key).toHaveAttribute('type', 'password')
      expect(key).toHaveAttribute('placeholder', '已填(重填一串就替换掉)')
      expect(key).toHaveValue('')
    })

    it('改了地址与模型名:blur 就 PUT 过去,值原样(不自动补 /v1)', async () => {
      const { impl, calls } = stub((url, init) => {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({ ok: true, status: { ...OWN_STATUS, own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'deepseek-v4-flash' }, hints: [] }), { status: 200 })
        }
        if (url.endsWith('/model') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(OWN_STATUS), { status: 200 })
        }
        return undefined
      })
      render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
      const base = await screen.findByLabelText('模型服务的地址')
      await userEvent.clear(base)
      await userEvent.type(base, 'https://ark.cn-beijing.volces.com/api/plan/v3')
      fireEvent.blur(base)
      await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true))
      expect(calls.find(c => c.method === 'PUT')?.body)
        .toEqual({ mode: 'own', own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3' })
    })

    it('密钥走 /credentials 存(只往外送),存完清空草稿', async () => {
      const { impl, calls } = stub((url, init) => {
        if (url.endsWith('/credentials') && init?.method === 'POST') {
          return new Response(JSON.stringify({ deepseek: { configured: true } }), { status: 200 })
        }
        if (url.endsWith('/model') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(OWN_STATUS), { status: 200 })
        }
        return undefined
      })
      render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
      const key = await screen.findByLabelText('模型服务的密钥')
      await userEvent.type(key, 'sk-his-own-key')
      await userEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(calls.some(c => c.url.endsWith('/credentials'))).toBe(true))
      const saved = calls.find(c => c.url.endsWith('/credentials'))
      expect(saved?.body).toEqual({ provider: 'deepseek', key: 'sk-his-own-key' })
      await waitFor(() => expect(screen.getByLabelText('模型服务的密钥')).toHaveValue(''))
    })

    it('「试一下」打一句话回来:成了说它的半句话,没成说人话', async () => {
      const { impl, calls } = stub((url, init) => {
        if (url.endsWith('/model/try') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true, message: '在,说。' }), { status: 200 })
        }
        if (url.endsWith('/model') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(OWN_STATUS), { status: 200 })
        }
        return undefined
      })
      render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
      await screen.findByLabelText('模型服务的地址')
      await userEvent.click(screen.getByRole('button', { name: '试一下' }))
      await waitFor(() => expect(calls.some(c => c.url.endsWith('/model/try'))).toBe(true))
      expect(await screen.findByText(/接上了,它回:在,说。/)).toBeInTheDocument()
    })
  })

  it('领不到凭证时说人话,并给一颗「重新接一次」', async () => {
    const notReady = {
      mode: 'relay', relay_url: 'https://api.aibooo.cn', relay_token_configured: false,
      own_key_configured: false, ready: false,
      usage_error: '连不上模型服务,今天的用量暂时看不到。',
    }
    const { impl, calls } = stub((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/model/reissue')) {
        return new Response(JSON.stringify({ ok: true, status: RELAY_READY, hints: ['已经接上工作台提供的模型服务,不用填任何东西。'] }), { status: 200 })
      }
      if (url.endsWith('/model') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(notReady), { status: 200 })
      }
      return undefined
    })
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/连不上模型服务/)).toBeInTheDocument()
    expect(screen.getByText('还没接上')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '重新接一次' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/model/reissue'))).toBe(true))
    expect(await screen.findByText(/已经接上工作台提供的模型服务/)).toBeInTheDocument()
  })

  it('这台没接中转:不给「用工作台提供的服务」那一项,只说用自己的密钥', async () => {
    const { impl } = stub(url => url.endsWith('/model')
      ? new Response(JSON.stringify({ mode: 'own', relay_url: '', relay_configured: false, relay_token_configured: false, own_key_configured: false, ready: false }), { status: 200 })
      : undefined)
    render(<ModelPanel baseUrl="http://x" fetchImpl={impl} />)
    await waitFor(() => expect(screen.getByText(MODEL_NO_RELAY_LINE)).toBeInTheDocument())
    expect(screen.queryByText('用工作台提供的服务')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新接一次' })).not.toBeInTheDocument()
    expect(screen.getByText('使用自己的账号')).toBeInTheDocument()
  })

  it('服务端没这条路由(旧插件):说一句话,不画点不动的控件', async () => {
    const { impl } = stub(url => (url.endsWith('/model') ? new Response('{}', { status: 404 }) : undefined))
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText(/还是旧版本/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('服务连不上:照样渲染,不整块消失', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    render(<ModelPanel baseUrl="http://127.0.0.1:8791" fetchImpl={impl} />)
    expect(await screen.findByText('模型服务')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '用工作台提供的服务' })).toBeInTheDocument()
    expect(screen.getByText('使用自己的账号')).toBeInTheDocument()
  })
})

describe('数字怎么写成人话', () => {
  it('上万的用「万」', () => {
    expect(formatTokens(12_000)).toBe('1.2 万')
    expect(formatTokens(50_000)).toBe('5 万')
    expect(formatTokens(999)).toBe('999')
  })

  it('百分比夹在 0–100', () => {
    expect(usagePercent({ day: 'd', used_tokens: 60_000, daily_token_limit: 50_000, remaining_tokens: 0 })).toBe(100)
    expect(usagePercent({ day: 'd', used_tokens: 0, daily_token_limit: 0, remaining_tokens: 0 })).toBe(0)
  })
})
