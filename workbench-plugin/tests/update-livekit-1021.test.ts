// @vitest-environment node
/**
 * 热更新多一种产物:**本机通话服务**(`livekit_tgz`,局域网主路卡 M1,2026-10-21)。
 *
 * 三件事:
 *   ① 清单认得它、Mac 这边会下它;
 *   ② 已经装好的机器(0.4.143 及以前用安装包装的,或者由旧插件跑完了那趟更新)**本机没有这个二进制** ——
 *      这是凭据(文件不在),不是「没记过」:版本号一样时也要算「还有一样没装上」(第 ③ 档),
 *      否则发版机那一趟「本机也走一遍更新路」与已装用户都要再等一版才装得上;
 *   ③ 装法:解进 payload(`livekit/livekit-server` + 启动脚本 + 开机自启模板),跑 `livekit` 那一步,在 launchd 之前。
 *
 * 命令全是假的,文件真写在 mktemp 出来的临时 HOME 里。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { LIVEKIT_LAUNCHD_LABEL, LIVEKIT_SERVER_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import { runUpdate } from '../src/server/update/apply.ts'
import { absentKindsOf, behindItems, emptyInstalled, planAssets } from '../src/server/update/installed.ts'
import { parseManifest } from '../src/server/update/manifest.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { DOWNLOADED_ASSET_KINDS, UPDATE_ASSET_KINDS, UPDATE_ASSET_TITLES, type UpdateJobView, type UpdateManifest } from '../src/server/update/types.ts'
import { fakePnpmExec, seedInstalledPnpm } from './setup/pnpmFake.ts'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const SHA = '1'.repeat(64)
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-update-lk-'))
  dirs.push(dir)
  return dir
}

function put(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
}

function manifestOf(kinds: readonly string[], version = '0.4.144'): UpdateManifest {
  const assets: UpdateManifest['assets'] = {}
  for (const kind of kinds) assets[kind as keyof UpdateManifest['assets']] = { url: `http://127.0.0.1:9/updates/${version}/${kind}`, sha256: SHA, size: 100 }
  return { version, assets }
}

/** 假 io:`sw_vers` 回 `macos`;其余命令一律成功。真文件读写。 */
function ioOf(options: { macos?: string, calls?: (readonly string[])[] } = {}): SetupIo {
  return {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[]) => {
      options.calls?.push(cmd)
      if (cmd[0] === 'sw_vers') return { ok: true, code: 0, out: `${options.macos ?? '26.6.2'}\n` }
      return { ok: true, code: 0, out: '' }
    },
    uid: () => 501,
  }
}

describe('① 清单认得它', () => {
  it('是一种会下载的产物,人话名字是「本机通话服务」', () => {
    expect(UPDATE_ASSET_KINDS).toContain('livekit_tgz')
    expect(DOWNLOADED_ASSET_KINDS).toContain('livekit_tgz')
    expect(UPDATE_ASSET_TITLES.livekit_tgz).toBe('本机通话服务')
  })

  it('清单里那一格照常校验(https、sha256、size)', () => {
    const text = JSON.stringify({
      version: '0.4.144',
      assets: {
        plugin_tgz: { url: 'https://api.example.cn/updates/0.4.144/plugin.tgz', sha256: SHA, size: 1 },
        livekit_tgz: { url: 'https://api.example.cn/updates/0.4.144/livekit.tgz', sha256: SHA, size: 17_000_000 },
      },
    })
    expect(parseManifest(text, 'https://api.example.cn/updates/latest.json').assets.livekit_tgz?.size).toBe(17_000_000)
  })
})

describe('② 本机没有这个二进制 = 有凭据的「没装」', () => {
  it('absentKindsOf:清单带了它、二进制不在、系统够新 → 算没装', async () => {
    const paths = setupPaths({ home: temp() })
    expect(await absentKindsOf(ioOf(), paths, manifestOf(['plugin_tgz', 'livekit_tgz']))).toEqual(['livekit_tgz'])
  })

  it('二进制在、清单没带它、macOS 14(本来就跑不了)—— 三种都不算', async () => {
    const home = temp()
    const paths = setupPaths({ home })
    const calls: (readonly string[])[] = []
    expect(await absentKindsOf(ioOf({ calls }), paths, manifestOf(['plugin_tgz']))).toEqual([])
    // 清单没带它就不必问系统版本(这一问在 /update/check 每一趟都要走)。
    expect(calls).toEqual([])
    expect(await absentKindsOf(ioOf({ macos: '14.6.1' }), paths, manifestOf(['plugin_tgz', 'livekit_tgz']))).toEqual([])
    put(paths.livekitBin, '#!/bin/sh\n', 0o755)
    expect(await absentKindsOf(ioOf(), paths, manifestOf(['plugin_tgz', 'livekit_tgz']))).toEqual([])
  })

  it('planAssets:没记录、本机没有 → 变了(source: missing),第 ③ 档数得着它;有记录也一样(文件被删了,按事实)', () => {
    const plan = planAssets(manifestOf(['plugin_tgz', 'livekit_tgz']), emptyInstalled(), {}, {}, ['livekit_tgz'])
    const item = plan.items.find(one => one.kind === 'livekit_tgz')
    expect(item).toMatchObject({ changed: true, source: 'missing' })
    expect(item?.why).toContain('还没有')
    expect(behindItems(plan).map(one => one.kind)).toEqual(['livekit_tgz'])

    const recorded = { version: '0.4.144', assets: { livekit_tgz: { sha256: SHA, version: '0.4.144', at: '' } } }
    const again = planAssets(manifestOf(['plugin_tgz', 'livekit_tgz']), recorded, {}, {}, ['livekit_tgz'])
    expect(again.items.find(one => one.kind === 'livekit_tgz')).toMatchObject({ changed: true, source: 'missing' })
  })

  it('/update/check:版本号一样、本机没有本机通话服务 → 有更新(第 ③ 档),说得出是哪一样', async () => {
    const home = temp()
    const paths = setupPaths({ home })
    const body = manifestOf(['plugin_tgz', 'livekit_tgz'], '0.4.144')
    const service = createUpdateService({
      io: { ...ioOf(), fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch },
      paths,
      now: () => NOW,
      newId: () => 'job1',
      currentVersion: '0.4.144',
      manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
      applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
    })
    const view = await service.check()
    expect(view.available).toBe(true)
    expect(view.components_behind).toBe(true)
    expect(view.notes).toContain('本机通话服务')
  })
})

describe('③ 装法', () => {
  /**
   * 跑一趟更新:下下来的原件预先摆好(sha 对上就不发 curl);`tar -xzf <x>.tgz -C <payload>` 是假的,
   * 按包名把它该解出来的几样摆进 payload(livekit.tgz 里有二进制 + 启动脚本 + 开机自启模板)。
   */
  async function update(kinds: readonly string[]): Promise<{ calls: (readonly string[])[], view: UpdateJobView, home: string }> {
    const home = temp()
    const paths = setupPaths({ home })
    seedInstalledPnpm(paths)
    const manifest = manifestOf(kinds)
    const assetsDir = `${paths.updatesDir}/${manifest.version}/assets`
    for (const name of ['plugin.tgz', 'scripts.tgz', 'livekit.tgz']) put(join(assetsDir, name), '假产物')
    const calls: (readonly string[])[] = []
    const io: SetupIo = {
      ...nodeSetupIo(),
      exec: async (cmd: readonly string[], _opts?: SetupExecOptions) => {
        calls.push(cmd)
        const pnpm = fakePnpmExec(paths, cmd)
        if (pnpm !== undefined) return pnpm
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${cmd[cmd.length - 1]?.endsWith('/livekit-server') === true ? '2'.repeat(64) : SHA}  ${cmd[cmd.length - 1]}\n` }
        if (cmd[0] === 'tar' && cmd[1] === '-xzf') {
          const payload = cmd[4] as string
          const file = cmd[2] as string
          if (file.endsWith('/livekit.tgz')) {
            put(join(payload, 'livekit/livekit-server'), '#!/bin/sh\n', 0o755)
            put(join(payload, 'deploy/livekit-start'), '#!/usr/bin/env bash\n')
            put(join(payload, `deploy/${LIVEKIT_LAUNCHD_LABEL}.plist`), '<plist><string>{{HOME}}/.dsh/bin/livekit-start</string></plist>')
          }
          if (file.endsWith('/scripts.tgz')) {
            put(join(payload, 'workbench-plugin/bin/dsh-start'), '#!/usr/bin/env bash\n')
            put(join(payload, 'workbench-plugin/bin/butler-start'), '#!/usr/bin/env bash\n')
            put(join(payload, 'deploy/channel-start'), '#!/usr/bin/env bash\n')
            put(join(payload, 'deploy/livekit-start'), '#!/usr/bin/env bash\n')
            put(join(payload, 'deploy/ai.deepseek.dsh.plist'), '<plist/>')
            put(join(payload, 'butler-server/launchd/ai.deepseek.butler.plist'), '<plist/>')
            put(join(payload, `deploy/${LIVEKIT_LAUNCHD_LABEL}.plist`), '<plist><string>{{HOME}}/.dsh/bin/livekit-start</string></plist>')
          }
          return { ok: true, code: 0, out: '' }
        }
        if (cmd[0] === 'sw_vers') return { ok: true, code: 0, out: '26.6.2\n' }
        if (cmd[1] === '--version') return { ok: true, code: 0, out: `livekit-server version ${LIVEKIT_SERVER_VERSION}\n` }
        return { ok: true, code: 0, out: '' }
      },
      uid: () => 501,
    }
    let seq = 0
    const run = runUpdate({
      io, paths, now: () => NOW, newId: () => `job${(seq += 1)}`, currentVersion: '0.4.143',
      subPollMs: 0, restartDelayMs: 0, restartWatchdogMs: 0, shellQuitTimeoutMs: 20, shellQuitPollMs: 10,
    }, manifest)
    await run.done
    return { calls, view: run.view, home }
  }

  /** 按特征认出跑过的几步。 */
  function stepsOf(calls: readonly (readonly string[])[]): string[] {
    const out: string[] = []
    for (const cmd of calls) {
      const line = cmd.join(' ')
      if (line.includes('plugin --profile web add')) out.push('plugin')
      else if (cmd[1] === '--version' && (cmd[0] ?? '').endsWith('/livekit-server')) out.push('livekit')
      else if (line.includes('launchctl bootstrap') && line.includes('ai.deepseek.dsh')) out.push('launchd')
      else if (line.includes('launchctl kickstart') && line.includes('ai.deepseek.dsh')) out.push('restart')
    }
    return out.filter((step, index) => out.indexOf(step) === index)
  }

  it('带了它:解开 livekit.tgz,在开机自启那一步之前装上;装完记进 installed.json', async () => {
    const { calls, view, home } = await update(['plugin_tgz', 'scripts_tgz', 'livekit_tgz'])
    expect(view.state, view.error).toBe('done')
    expect(calls.some(cmd => cmd[0] === 'tar' && (cmd[2] ?? '').endsWith('/livekit.tgz'))).toBe(true)
    expect(stepsOf(calls)).toEqual(['plugin', 'livekit', 'launchd', 'restart'])
    const paths = setupPaths({ home })
    expect(readFileSync(paths.livekitBin, 'utf8')).toBe('#!/bin/sh\n')
    const installed = JSON.parse(readFileSync(paths.installedJson, 'utf8')) as { assets: Record<string, { sha256: string }> }
    expect(installed.assets.livekit_tgz?.sha256).toBe(SHA)
  })

  it('只带它(启动脚本没变,那一份不下):本机通话服务那一步自己把启动脚本与 launchd 项装上', async () => {
    const { calls, view, home } = await update(['plugin_tgz', 'livekit_tgz'])
    expect(view.state, view.error).toBe('done')
    const paths = setupPaths({ home })
    expect(readFileSync(paths.livekitStart, 'utf8')).toContain('bash')
    expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', paths.livekitPlist])
  })
})
