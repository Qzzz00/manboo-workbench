// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { credentialStatus, loadCredentials, saveCredential, volcAsrOf } from '../src/server/credentials.ts'

const dirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-cred-'))
  dirs.push(dir)
  return join(dir, 'nested', 'credentials.json')
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const KEY = 'sk-not-a-real-key-0123456789'

describe('saveCredential / loadCredentials', () => {
  it('存下来能读回，目录不存在时自己建', async () => {
    const file = tempFile()

    await saveCredential(file, 'deepseek', KEY)

    expect((await loadCredentials(file)).deepseek).toBe(KEY)
  })

  it('文件权限必须是 0600——这里面是明文 key，不能让同机其它用户读到', async () => {
    const file = tempFile()

    await saveCredential(file, 'deepseek', KEY)

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('两家分别存，互不覆盖', async () => {
    const file = tempFile()

    await saveCredential(file, 'deepseek', KEY)
    await saveCredential(file, 'kimi_web', 'kimi_session=other-cookie')

    const all = await loadCredentials(file)
    expect(all).toEqual({ deepseek: KEY, kimi_web: 'kimi_session=other-cookie' })
  })

  it('传空字符串＝清除这一家，而不是存一个空 key', async () => {
    const file = tempFile()
    await saveCredential(file, 'deepseek', KEY)

    await saveCredential(file, 'deepseek', '')

    expect((await loadCredentials(file)).deepseek).toBeUndefined()
  })

  it('文件不存在时返回空，不抛——第一次用本来就没有', async () => {
    expect(await loadCredentials(tempFile())).toEqual({})
  })

  it('文件被写坏时返回空而不是崩掉整台服务', async () => {
    const file = tempFile()
    await saveCredential(file, 'deepseek', KEY)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 半行坏 JSON')

    expect(await loadCredentials(file)).toEqual({})
  })
})

describe('零服务器档自带的钥匙(2026-10-21)', () => {
  it('博查搜索一格、火山识别两格,与 DeepSeek 同一种存法', async () => {
    const file = tempFile()
    await saveCredential(file, 'bocha', 'bocha-key-fake')
    await saveCredential(file, 'volc_asr_app_id', '1234')
    await saveCredential(file, 'volc_asr_access_token', 'asr-token-fake')
    expect(await loadCredentials(file)).toEqual({
      bocha: 'bocha-key-fake', volc_asr_app_id: '1234', volc_asr_access_token: 'asr-token-fake',
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('识别那一对:两格都填了才算有', async () => {
    const file = tempFile()
    await saveCredential(file, 'volc_asr_app_id', '1234')
    expect(volcAsrOf(await loadCredentials(file))).toBeUndefined()
    await saveCredential(file, 'volc_asr_access_token', 'asr-token-fake')
    expect(volcAsrOf(await loadCredentials(file))).toEqual({ app_id: '1234', access_token: 'asr-token-fake' })
  })
})

describe('credentialStatus', () => {
  it('只报有没有配，绝不回显 key 本身——这份要发给浏览器', async () => {
    const file = tempFile()
    await saveCredential(file, 'deepseek', KEY)

    const status = await credentialStatus(file)

    expect(status).toEqual({
      deepseek: { configured: true },
      kimi_web: { configured: false },
      claude_api: { configured: false },
      bocha: { configured: false },
      volc_asr_app_id: { configured: false },
      volc_asr_access_token: { configured: false },
    })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('落盘的文件里也不该出现在任何日志式字段里，只有 keys 这一处', async () => {
    const file = tempFile()
    await saveCredential(file, 'deepseek', KEY)

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['keys'])
  })
})
