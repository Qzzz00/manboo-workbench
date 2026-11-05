import { describe, expect, it, vi } from 'vitest'
import { EMPTY_CREDENTIAL_STATUS, fetchCredentialStatus, submitCredential } from '../src/client/credentials.ts'

const KEY = 'sk-not-a-real-key-0123456789'
const BASE = 'http://127.0.0.1:8791'

function jsonFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch
}

describe('fetchCredentialStatus', () => {
  it('把服务端的状态翻成界面用的两个布尔', async () => {
    const status = await fetchCredentialStatus(
      BASE,
      jsonFetch({ deepseek: { configured: true }, kimi_web: { configured: false }, claude_api: { configured: false } }),
    )

    expect(status).toEqual({ ...EMPTY_CREDENTIAL_STATUS, deepseek: true })
  })

  it('服务没起时当作都没配，界面照常渲染而不是白屏', async () => {
    const failing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch

    expect(await fetchCredentialStatus(BASE, failing)).toEqual(EMPTY_CREDENTIAL_STATUS)
  })
})

describe('submitCredential', () => {
  it('把 Key POST 上去，并回传新的状态', async () => {
    const fetchImpl = jsonFetch({ deepseek: { configured: true }, kimi_web: { configured: false }, claude_api: { configured: false } })

    const status = await submitCredential(BASE, 'deepseek', KEY, fetchImpl)

    expect(status).toEqual({ ...EMPTY_CREDENTIAL_STATUS, deepseek: true })
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'deepseek', key: KEY })
  })

  it('打到 /credentials 这个口子上', async () => {
    const fetchImpl = jsonFetch({ deepseek: { configured: true }, kimi_web: { configured: false }, claude_api: { configured: false } })

    await submitCredential(BASE, 'kimi_web', KEY, fetchImpl)

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/credentials`)
  })

  it('失败时抛出可读的错误，且错误信息里不带 Key', async () => {
    const failing = vi.fn(async () => { throw new Error(`connect refused while sending ${KEY}`) }) as unknown as typeof fetch

    await expect(submitCredential(BASE, 'deepseek', KEY, failing)).rejects.toThrow()
    await expect(submitCredential(BASE, 'deepseek', KEY, failing)).rejects.not.toThrow(new RegExp(KEY))
  })
})
