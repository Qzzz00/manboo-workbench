// @vitest-environment node
/** ~/.dsh/workbench/app.json:工作台自身的开关(2026-09-11 第一项是「允许手机在局域网访问」)。 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppConfig, loadAppConfigFile } from '../src/server/appConfig.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-app-')), 'app.json')
}

describe('app.json', () => {
  it('没有文件时默认关着局域网访问', async () => {
    const config = createAppConfig({ file: tmpFile() })
    expect(await config.get()).toEqual({ lan_access: false })
  })

  it('set 落盘,重新读回来还是开着', async () => {
    const file = tmpFile()
    expect(await createAppConfig({ file }).set({ lan_access: true })).toEqual({ lan_access: true })
    expect(await createAppConfig({ file }).get()).toEqual({ lan_access: true })
  })

  it('保留文件里不认识的键,不把别人的配置抹掉', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, lan_access: false, someone_else: { a: 1 } }))
    await createAppConfig({ file }).set({ lan_access: true })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.someone_else).toEqual({ a: 1 })
    expect(raw.lan_access).toBe(true)
  })

  it('写坏了按默认兜底,不抛;非布尔的 lan_access 当 false', async () => {
    const file = tmpFile()
    writeFileSync(file, '{ nope')
    expect(await loadAppConfigFile(file)).toEqual({ version: 1, lan_access: false })
    writeFileSync(file, JSON.stringify({ lan_access: 'yes' }))
    expect((await loadAppConfigFile(file)).lan_access).toBe(false)
  })
})
