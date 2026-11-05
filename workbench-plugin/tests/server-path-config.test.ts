// @vitest-environment node
/**
 * 路径可配(卡 C,2026-09-17):扫描根 / 收件箱目录 / 事务官仓库目录三项落 app.json,
 * 默认值与今天写死的值逐字一致。这一份只测**纯函数层**(pathConfig.ts)与 app.json 的读写;
 * HTTP、扫描热生效、收件箱重挂各有自己的用例文件。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppConfig, loadAppConfigFile } from '../src/server/appConfig.ts'
import type { WbPathsParsed } from '../src/server/pathConfig.ts'
import {
  WB_PATHS_RESTART_REQUIRED_HINT,
  wbPathsDefaults,
  wbPathsEffective,
  wbPathsParsePatch,
} from '../src/server/pathConfig.ts'

/** 只在"应该被拒"的用例里用:取那句人话,过了反而是用例写错了。 */
function errorOf(parsed: WbPathsParsed): string {
  return parsed.ok ? '(居然过了)' : parsed.error
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-paths-')), 'app.json')
}

describe('路径默认值', () => {
  it('三个扫描根、两个收件箱目录,与改造前写死的值逐字一致', () => {
    const defaults = wbPathsDefaults('/Users/someone')
    expect(defaults.scan_roots).toEqual([
      { path: '/Users/someone/Documents/GitHub', depth: 1 },
      { path: '/Users/someone/Documents/Codex', depth: 2 },
      { path: '/Users/someone/WeChatProjects', depth: 1 },
    ])
    expect(defaults.inbox_dirs).toEqual(['/Users/someone/Downloads', '/Users/someone/Desktop'])
    // 事务官仓库没有默认值:**不猜路径**(猜错会把记忆写进别的仓库)。
    expect(defaults.butler_cwd).toBeUndefined()
  })
})

describe('app.json 里的三项', () => {
  it('没配过时读出来是空的(缺席 ≠ 空数组)', async () => {
    const config = createAppConfig({ file: tmpFile() })
    const view = await config.get()
    expect(view.lan_access).toBe(false)
    expect(view.scan_roots).toBeUndefined()
    expect(view.inbox_dirs).toBeUndefined()
    expect(view.butler_cwd).toBeUndefined()
  })

  it('set 落盘、读回来还在,且不碰别人的键', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, lan_access: true, someone_else: { a: 1 } }))
    await createAppConfig({ file }).set({
      scan_roots: [{ path: '/tmp/a', depth: 2 }],
      inbox_dirs: ['/tmp/in'],
      butler_cwd: '/tmp/repo',
    })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.someone_else).toEqual({ a: 1 })
    expect(raw.lan_access).toBe(true)
    expect(raw.scan_roots).toEqual([{ path: '/tmp/a', depth: 2 }])
    const back = await createAppConfig({ file }).get()
    expect(back.inbox_dirs).toEqual(['/tmp/in'])
    expect(back.butler_cwd).toBe('/tmp/repo')
  })

  it('写坏的形状按缺席兜底,不抛也不留半条', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({
      scan_roots: [{ path: '/tmp/ok', depth: 3 }, { path: 42 }, { depth: 1 }, { path: '/tmp/bad', depth: 9 }],
      inbox_dirs: ['/tmp/ok', 7, ''],
      butler_cwd: 12,
    }))
    const data = await loadAppConfigFile(file)
    // depth 只认 1~3;越界那条整条丢掉,不夹一个猜出来的值。
    expect(data.scan_roots).toEqual([{ path: '/tmp/ok', depth: 3 }])
    expect(data.inbox_dirs).toEqual(['/tmp/ok'])
    expect(data.butler_cwd).toBeUndefined()
  })

  it('空数组是「一个都不要」,与缺席不同', async () => {
    const file = tmpFile()
    await createAppConfig({ file }).set({ scan_roots: [] })
    expect((await createAppConfig({ file }).get()).scan_roots).toEqual([])
  })
})

describe('生效值(effective)', () => {
  it('没配就用默认', () => {
    const effective = wbPathsEffective({ lan_access: false }, { home: '/Users/someone' })
    expect(effective.scan_roots).toEqual(wbPathsDefaults('/Users/someone').scan_roots)
    expect(effective.inbox_dirs).toEqual(wbPathsDefaults('/Users/someone').inbox_dirs)
    expect(effective.butler_cwd).toBeUndefined()
  })

  it('配了就用配的', () => {
    const effective = wbPathsEffective(
      { lan_access: false, scan_roots: [{ path: '/w', depth: 2 }], inbox_dirs: [], butler_cwd: '/repo' },
      { home: '/Users/someone' },
    )
    expect(effective.scan_roots).toEqual([{ path: '/w', depth: 2 }])
    expect(effective.inbox_dirs).toEqual([])
    expect(effective.butler_cwd).toBe('/repo')
  })

  it('WORKBENCH_BUTLER_CWD 压过 app.json,并说出这一条来自哪里', () => {
    const effective = wbPathsEffective(
      { lan_access: false, butler_cwd: '/from-file' },
      { home: '/Users/someone', envButlerCwd: '/from-env' },
    )
    expect(effective.butler_cwd).toBe('/from-env')
    expect(effective.butler_cwd_source).toBe('env')
  })

  it('环境变量是空串等于没配,退回 app.json', () => {
    const effective = wbPathsEffective(
      { lan_access: false, butler_cwd: '/from-file' },
      { home: '/Users/someone', envButlerCwd: '' },
    )
    expect(effective.butler_cwd).toBe('/from-file')
    expect(effective.butler_cwd_source).toBe('app.json')
  })

  it('两处都没有时来源是「没配」', () => {
    expect(wbPathsEffective({ lan_access: false }, { home: '/h' }).butler_cwd_source).toBe('none')
  })
})

describe('PUT 的入参校验(纯函数层)', () => {
  const home = '/Users/someone'

  it('不是对象 → 一句人话', () => {
    expect(wbPathsParsePatch(null, home)).toEqual({ ok: false, error: 'body 要是一个对象' })
    expect(wbPathsParsePatch([], home).ok).toBe(false)
  })

  it('一个键都没给 → 拒绝,免得一次空 PUT 看起来像成功了', () => {
    expect(wbPathsParsePatch({}, home)).toEqual({
      ok: false,
      error: '没有要改的东西:scan_roots / inbox_dirs / butler_cwd 至少给一个',
    })
  })

  it('scan_roots 形状不对 → 指名道姓说第几条', () => {
    expect(errorOf(wbPathsParsePatch({ scan_roots: [{ path: '', depth: 1 }] }, home))).toBe('第 1 个扫描根的路径是空的')
    expect(errorOf(wbPathsParsePatch({ scan_roots: [{ path: '/a', depth: 4 }] }, home))).toBe('第 1 个扫描根的层数要在 1~3 之间')
    expect(errorOf(wbPathsParsePatch({ scan_roots: 'x' }, home))).toBe('scan_roots 要是一个数组')
  })

  it('相对路径 → 拒绝,不替他猜工作目录', () => {
    expect(errorOf(wbPathsParsePatch({ inbox_dirs: ['Downloads'] }, home))).toBe('第 1 个收件箱目录要写绝对路径(以 / 开头)')
  })

  it('~ 开头按家目录展开,末尾多余的斜杠去掉', () => {
    const parsed = wbPathsParsePatch({ inbox_dirs: ['~/Downloads/', '~'] }, home)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.patch.inbox_dirs).toEqual(['/Users/someone/Downloads', '/Users/someone'])
  })

  it('butler_cwd 给空串 = 清掉这一项(退回环境变量 / 不配)', () => {
    const parsed = wbPathsParsePatch({ butler_cwd: '' }, home)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.patch.butler_cwd).toBe('')
  })

  it('同一个扫描根写两遍 → 拒绝,不默默去重', () => {
    const parsed = wbPathsParsePatch({ scan_roots: [{ path: '/a', depth: 1 }, { path: '/a/', depth: 2 }] }, home)
    expect(errorOf(parsed)).toBe('扫描根 /a 写了两遍')
  })

  it('要重启的提示是一句人话,里面点名 kickstart', () => {
    expect(WB_PATHS_RESTART_REQUIRED_HINT).toContain('kickstart')
  })
})
