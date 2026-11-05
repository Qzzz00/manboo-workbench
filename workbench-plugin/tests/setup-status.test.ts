// @vitest-environment node
/**
 * 就绪检查(2026-09-17 登录台卡 A)。
 *
 * **每一条用例都跑在 mktemp 出来的临时 HOME 里**:体检读的每一条路径都由 `home` 算出来
 * (server/setup/paths.ts),所以只要传一个临时目录,它就一个字节都碰不到真实 ~/.dsh。
 * 命令(launchctl / mdfind / osascript / node -p)一律走注入的假 exec,不起任何子进程。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSetupStatus, claudeHooksPointAt, credentialsHaveDeepseekKey, envHasDeepseekKey, latestWebToken, normalizeDshStart } from '../src/server/setup/status.ts'
import { nodeSetupIo, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths, LOCKED_DSH_VERSION } from '../src/server/setup/paths.ts'
import type { SetupItem, SetupStatus } from '../src/server/setup/types.ts'
import { BASE_SKILLS, OPS_SKILLS, PRODUCT_SKILLS } from '../src/server/opsSkills.ts'
import { markers } from '../src/server/memoryMd.ts'
import { seedLockedRuntime } from './setup/dshRuntimeFake.ts'
import { CODEX_TRUST_HOW, type CodexHookTrust } from '../src/server/codexHookTrust.ts'

const NOW = Date.parse('2026-09-17T10:00:00Z')

/** 固定证书签出来的 requirement:认证书,重建多少次都是这一条 ⇒ 授权跨更新保留。 */
const STABLE_SHELL_REQUIREMENT = 'Executable=/Applications/工作台.app/Contents/MacOS/workbench\ndesignated => identifier "ai.ben.workbench" and certificate leaf = H"a8d72e0e41c85afb3c6d9aa79a3c06e70307583f"\n'
/** ad-hoc 签出来的:认 cdhash,二进制一变就变 ⇒ 系统当新 App,授权必掉。 */
const ADHOC_SHELL_REQUIREMENT = 'Executable=/Applications/工作台.app/Contents/MacOS/workbench\n# designated => cdhash H"3fb3d1b090291e9422abc719a9145d1ba71a78e2"\n'
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-setup-home-'))
  dirs.push(dir)
  return dir
}

/** 假命令执行器:按 argv[0](加第二个词)查表,查不到一律失败。 */
function fakeExec(table: Record<string, Partial<SetupExecResult>>): SetupIo['exec'] {
  return async (cmd) => {
    const key = [cmd[0], cmd[1]].filter(Boolean).join(' ')
    const hit = table[key] ?? table[cmd[0] ?? ''] ?? undefined
    if (hit === undefined) return { ok: false, code: 1, out: `没桩:${cmd.join(' ')}` }
    return { ok: hit.ok ?? true, code: hit.code ?? 0, out: hit.out ?? '' }
  }
}

interface Fixture { home: string, repo: string, io: SetupIo }

/** 摆一台「什么都装好了」的机器,再由各条用例按需要破坏其中一处。 */
function fullyInstalled(options: { exec?: Record<string, Partial<SetupExecResult>> } = {}): Fixture {
  const home = tempHome()
  const repo = tempHome()
  const write = (path: string, text: string, mode?: number): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text, 'utf8')
    if (mode !== undefined) chmodSync(path, mode)
  }
  const paths = setupPaths({ home, repoRoot: repo, applicationsDir: join(home, 'Applications') })

  write(paths.nodeBin, '#!/bin/sh\n', 0o755)
  seedLockedRuntime(paths.runtimeDir)
  write(paths.profilePatchYml, '- insert:\n    - id: ben-workbench\n')
  write(paths.profilePluginPackageJson, JSON.stringify({ version: '9.9.9' }))
  const startScript = 'set -euo pipefail\nexport WORKBENCH_BUTLER_CWD="$HOME/Documents/GitHub/desktop-workbench"\n'
  write(join(repo, 'workbench-plugin/bin/dsh-start'), startScript)
  write(paths.dshStart, `set -euo pipefail\nexport WORKBENCH_BUTLER_CWD="${repo}"\n`, 0o755)
  write(paths.dshPlist, '<plist/>')
  write(paths.butlerPlist, '<plist/>')
  write(paths.shellAppBinary, 'MZ', 0o755)
  write(join(repo, 'workbench-app/Sources/main.swift'), '// old')
  write(paths.butlerServerEntry, '// butler')
  write(paths.butlerStart, '#!/bin/sh\n', 0o755)
  write(paths.channelWorkerEntry, '// worker')
  write(join(paths.channelWorkerNativeDep, 'index.js'), '// native')
  write(paths.channelStart, '#!/bin/sh\n', 0o755)
  write(paths.dshCredentialsYaml, 'key: x')
  // 一台"装好了"的机器上,事务官的技能段也是接上的(2026-09-22 起切模板会自动写)。
  // 这里写的是**两种模板都写**的那几段 —— fullyInstalled 没有指定模板,那等于做产品。
  write(paths.dshAgentsMd, BASE_SKILLS.map(one => `${markers(one.name).open}\n# ${one.name}\n${markers(one.name).close}\n`).join('\n'))
  write(paths.webStdoutLog, 'dsh web: http://127.0.0.1:3080/?token=abc123\n')
  write(paths.dshEnvFile, 'DEEPSEEK_API_KEY=sk-real\n')
  write(paths.credentialsJson, JSON.stringify({ keys: { deepseek: 'sk-real' } }))
  // 卡 R(2026-09-25):工作台的 hook 指着钩子脚本的固定位置,脚本真在、能执行 —— 与额度面板同一个判据。
  const hooksDir = join(home, '.dsh/workbench/hooks')
  write(join(hooksDir, 'agent-hook.sh'), '#!/bin/sh\nexit 0\n', 0o755)
  write(paths.claudeSettings, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: `${hooksDir}/agent-hook.sh claude` }] }] },
    statusLine: { command: `${hooksDir}/claude-statusline.sh` },
  }))
  mkdirSync(join(home, 'Documents/GitHub'), { recursive: true })

  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: fakeExec({
      'launchctl print': { ok: true, out: 'ai.deepseek.dsh' },
      osascript: { ok: true, out: '3\n' },
      mdfind: { ok: true, out: '/Applications/某某.app\n' },
      [`${paths.nodeBin} -p`]: { ok: true, out: '24.19.0\n' },
      // 一台"装好了"的机器上,壳是拿固定证书签的 —— `codesign -d -r -` 打出来的
      // designated requirement 认的是证书,不是 cdhash。体检那一项读的就是这行。
      'codesign -d': { ok: true, out: STABLE_SHELL_REQUIREMENT },
      ...(options.exec ?? {}),
    }),
    uid: () => 501,
    currentNodeBinary: () => '/somewhere/node',
  }
  return { home, repo, io }
}

async function check(fixture: Fixture, over: { repoRoot?: string | undefined, helper?: () => { connected: boolean, authorized: boolean }, scanRoots?: readonly string[], templateId?: string, codexHookTrust?: CodexHookTrust } = {}): Promise<SetupStatus> {
  const repoRoot = 'repoRoot' in over ? over.repoRoot : fixture.repo
  const paths = setupPaths({
    home: fixture.home,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    applicationsDir: join(fixture.home, 'Applications'),
  })
  return await createSetupStatus({
    io: fixture.io,
    paths,
    pluginVersion: '9.9.9',
    helper: over.helper ?? (() => ({ connected: true, authorized: true })),
    scanRoots: async () => over.scanRoots ?? [join(fixture.home, 'Documents/GitHub')],
    ...(repoRoot === undefined ? {} : { repoRoot }),
    // 当前模板(2026-09-22,卡 ①)。不传 = 这台服务没接模板服务,按"没选过"办。
    ...(over.templateId === undefined ? {} : { templateId: () => over.templateId }),
    // Codex 放没放行工作台的钩子(2026-10-21)。不传 = 这台服务没接这一问,那一项整个缺席。
    ...(over.codexHookTrust === undefined ? {} : { codexHookTrust: async () => over.codexHookTrust as CodexHookTrust }),
    now: () => NOW,
  }).check()
}

function pick(status: SetupStatus, key: string): SetupItem {
  const found = status.items.find(item => item.key === key)
  if (found === undefined) throw new Error(`没有这一项:${key}(有的是 ${status.items.map(i => i.key).join(',')})`)
  return found
}

describe('就绪检查 · 一台装好的机器', () => {
  it('非可选项全绿,all_ok 为真', async () => {
    const status = await check(fullyInstalled())
    const bad = status.items.filter(item => item.optional !== true && item.state !== 'ok')
    expect(bad.map(item => `${item.key}:${item.state} ${item.detail}`)).toEqual([])
    expect(status.all_ok).toBe(true)
    expect(status.checked_at).toBe(new Date(NOW).toISOString())
  })

  it('每一项不 ok 的都带「怎么修」的人话', async () => {
    const home = tempHome()
    const status = await check({ home, repo: tempHome(), io: { ...nodeSetupIo(), exec: fakeExec({}), uid: () => 501, currentNodeBinary: () => '/x/node' } })
    for (const item of status.items.filter(i => i.state !== 'ok')) {
      expect(item.fix, `${item.key} 没写怎么修`).toBeTruthy()
      expect(item.detail).not.toBe('')
    }
  })
})

describe('就绪检查 · 逐项', () => {
  it('自有 node 不在就是 missing,按钮指向 node 那一步', async () => {
    const fixture = fullyInstalled()
    rmSync(join(fixture.home, '.dsh/node/bin/node'))
    const item = pick(await check(fixture), 'node')
    expect(item.state).toBe('missing')
    expect(item.action).toEqual({ kind: 'install', step: 'node', label: '装一份自有 node' })
  })

  it('自有 node 版本低于 24 是 stale', async () => {
    const paths = setupPaths({ home: 'x', repoRoot: 'y' })
    void paths
    const fixture = fullyInstalled({ exec: {} })
    const nodeBin = join(fixture.home, '.dsh/node/bin/node')
    fixture.io.exec = fakeExec({ [`${nodeBin} -p`]: { ok: true, out: '20.11.0\n' }, 'launchctl print': { ok: true }, osascript: { ok: true, out: '1' }, mdfind: { ok: true, out: '/A.app' } })
    const item = pick(await check(fixture), 'node')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain('20.11.0')
  })

  it('运行时版本不是锁定版本就是 stale', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/runtime/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.1.1-rc.2' }))
    const item = pick(await check(fixture), 'runtime')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain(LOCKED_DSH_VERSION)
  })

  // 09-23 白屏事故那一幕:dsh 主包版本对得上,cordis 一家却漂了。
  // 0925 升 0.1.7 时把造漂移用的那个包从 `cordis-plugin-hmr`(0.1.7 已经没有它)换成 `cordis`
  // 本身,漂到的正是 0.1.2 那会儿的 4.0.2 —— 对 0.1.7 来说它是"退回到不能用的那一版"。
  it('运行时顶层版本对、但传递依赖漂了(09-23 cordis 一家)也是 stale,按钮是照清单重装', async () => {
    const fixture = fullyInstalled()
    seedLockedRuntime(join(fixture.home, '.dsh/runtime'), { '@deepseek-ai/cordis': '4.0.2' })
    const item = pick(await check(fixture), 'runtime')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain('@deepseek-ai/cordis 应是 4.0.4,装成了 4.0.2')
    expect(item.action).toMatchObject({ kind: 'install', step: 'runtime' })
  })

  it('profile 里装的插件比仓库旧就是 stale,按钮是 plugin 那一步', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/profiles/web/node_modules/@ben/dsh-workbench/package.json'), JSON.stringify({ version: '0.0.1' }))
    const item = pick(await check(fixture), 'profile')
    expect(item.state).toBe('stale')
    expect(item.action).toMatchObject({ kind: 'install', step: 'plugin' })
  })

  it('dsh-start 内容跟仓库对不上就是 stale,但只有 WORKBENCH_BUTLER_CWD 不同不算', async () => {
    const fixture = fullyInstalled()
    expect(pick(await check(fixture), 'dsh_start').state).toBe('ok')
    writeFileSync(join(fixture.home, '.dsh/bin/dsh-start'), 'set -euo pipefail\n# 少了一行\n')
    expect(pick(await check(fixture), 'dsh_start').state).toBe('stale')
  })

  it('plist 在但 launchd 里没这一项 → missing', async () => {
    const fixture = fullyInstalled({ exec: { 'launchctl print': { ok: false, code: 113, out: 'Could not find service' } } })
    const item = pick(await check(fixture), 'launchd_dsh')
    expect(item.state).toBe('missing')
    expect(item.action).toMatchObject({ kind: 'install', step: 'launchd' })
  })

  it('壳比仓库源码旧 → stale', async () => {
    const fixture = fullyInstalled()
    // 源码比壳新。用 utimes 显式把 mtime 拨到一分钟之后 —— 只靠"再写一次"的话两者
    // 在同一毫秒里,会被那道 5 秒宽限(见 status.ts)正确地判成「刚装好」。
    const source = join(fixture.repo, 'workbench-app/Sources/main.swift')
    writeFileSync(source, '// 改过了')
    const later = new Date(Date.now() + 60_000)
    utimesSync(source, later, later)
    const item = pick(await check(fixture), 'shell_app')
    expect(item.state).toBe('stale')
    expect(item.fix).toContain('辅助功能')
  })

  it('壳是固定证书签的 → 体检如实说"更新不掉授权"', async () => {
    const item = pick(await check(fullyInstalled()), 'shell_app')
    expect(item.state).toBe('ok')
    expect(item.detail).toContain('签名身份固定')
  })

  it('壳是 ad-hoc 签的 → 体检如实说"每次重建都要重新授权"', async () => {
    const fixture = fullyInstalled({ exec: { 'codesign -d': { ok: true, out: ADHOC_SHELL_REQUIREMENT } } })
    const item = pick(await check(fixture), 'shell_app')
    expect(item.state).toBe('ok')
    expect(item.detail).toContain('ad-hoc')
    expect(item.detail).toContain('重新授权')
  })

  it('codesign 读不出签名 → 不猜,如实说读不出来', async () => {
    const fixture = fullyInstalled({ exec: { 'codesign -d': { ok: false, code: 1, out: 'code object is not signed at all' } } })
    const item = pick(await check(fixture), 'shell_app')
    expect(item.detail).toContain('签名读不出来')
  })

  it('壳没连上 → 辅助功能那项是 needs_user,按钮打开系统设置', async () => {
    const item = pick(await check(fullyInstalled(), { helper: () => ({ connected: false, authorized: false }) }), 'accessibility')
    expect(item.state).toBe('needs_user')
    expect(item.action).toEqual({ kind: 'open_pane', pane: 'accessibility', label: '去授权' })
  })

  /**
   * 2026-09-18(fix/landscape-firstrun-glitches):壳连上了却报未授权时,还要再分一次 ——
   * 「真没给过」与「给过了、但那条记录对应的是旧签名的壳」。判定本体在
   * tests/server-accessibility.test.ts,这两条钉的是**体检说出来的那句话**。
   * 这个 fixture 里没有 sqlite3 的桩,所以 TCC 探测拿到的是 unknown(真机上的常态)。
   */
  it('★以前授权过**另一个**签名、现在证书签名的壳报未授权 → 说「旧签名记录」,去 − 再 +', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/workbench/accessibility-grant.json'), JSON.stringify({ requirement: 'cdhash H"3fb3d1b090291e9422abc719a9145d1ba71a78e2"' }))
    const item = pick(await check(fixture, { helper: () => ({ connected: true, authorized: false }) }), 'accessibility')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('旧签名')
    expect(item.fix).toContain('移除')
    expect(item.fix).toContain('重新添加')
    expect(item.fix).toContain('以后更新不会再要')
  })

  /**
   * 2026-09-23 从零重装自跑:新机器从没授权过,证书签名的壳 + 未授权被一律说成「旧记录」,
   * 让新用户去删一条根本不存在的东西。没有「以前授权过」的记录 ⇒ 只说「还没授权」。
   */
  it('★新机器(从没见过授权)、证书签名的壳报未授权 → 「还没有辅助功能授权」,绝不让他去移除什么', async () => {
    const item = pick(await check(fullyInstalled(), { helper: () => ({ connected: true, authorized: false }) }), 'accessibility')
    expect(item.detail).toContain('还没有辅助功能授权')
    expect(item.fix).toContain('去授权')
    expect(item.fix).not.toContain('移除')
    expect(`${item.detail}${item.fix ?? ''}`).not.toContain('bash')
  })

  it('以前授权过的就是现在这个签名(他自己关了/删了)→ 仍说「还没有授权」,不说旧记录', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/workbench/accessibility-grant.json'), JSON.stringify({ requirement: 'identifier "ai.ben.workbench" and certificate leaf = H"a8d72e0e41c85afb3c6d9aa79a3c06e70307583f"' }))
    const item = pick(await check(fixture, { helper: () => ({ connected: true, authorized: false }) }), 'accessibility')
    expect(item.detail).toContain('还没有辅助功能授权')
  })

  it('已授权时把壳此刻的签名要求记一笔 —— 以后才分得清「从没授权」与「旧签名」', async () => {
    const fixture = fullyInstalled()
    await check(fixture)
    const saved = JSON.parse(readFileSync(join(fixture.home, '.dsh/workbench/accessibility-grant.json'), 'utf8')) as { requirement: string }
    expect(saved.requirement).toBe('identifier "ai.ben.workbench" and certificate leaf = H"a8d72e0e41c85afb3c6d9aa79a3c06e70307583f"')
  })

  it('壳是 ad-hoc 签的、报未授权 → 照旧那句「还没有辅助功能授权」(ad-hoc 掉授权是它的常态,说「旧记录」就是猜)', async () => {
    const fixture = fullyInstalled({ exec: { 'codesign -d': { ok: true, out: ADHOC_SHELL_REQUIREMENT } } })
    const item = pick(await check(fixture, { helper: () => ({ connected: true, authorized: false }) }), 'accessibility')
    expect(item.detail).toContain('没有辅助功能授权')
    expect(item.fix).not.toContain('移除')
  })

  it('扫描根 EPERM → 文稿授权 needs_user;目录不存在不算没授权', async () => {
    const fixture = fullyInstalled()
    const denied: SetupIo = {
      ...fixture.io,
      readdir: async path => (path.includes('Documents') ? { ok: false, code: 'EPERM', message: 'EPERM scandir' } : { ok: true, names: [] }),
    }
    const item = pick(await check({ ...fixture, io: denied }), 'documents')
    expect(item.state).toBe('needs_user')
    expect(item.action).toMatchObject({ kind: 'open_pane', pane: 'files' })

    const absent: SetupIo = { ...fixture.io, readdir: async () => ({ ok: false, code: 'ENOENT', message: 'no such file' }) }
    expect(pick(await check({ ...fixture, io: absent }), 'documents').state).toBe('ok')
  })

  it('osascript 失败 → 日历 needs_user(而且是可选项,不拦 all_ok)', async () => {
    const fixture = fullyInstalled({ exec: { osascript: { ok: false, code: 1, out: 'not authorized' } } })
    const status = await check(fixture)
    expect(pick(status, 'calendar').state).toBe('needs_user')
    expect(pick(status, 'calendar').optional).toBe(true)
    expect(status.all_ok).toBe(true)
    // 2 = 日历 + 完全磁盘访问(2026-10-13)。临时 HOME 下那几条探针目录都不在,
    // 那一项照「判断不了」算 —— 它也是可选项,一样不拦 all_ok。
    expect(status.optional_pending).toBe(2)
  })

  it('DeepSeek key 只配了一处(他选了用自己的 Key)→ needs_user,而且 detail 里绝不出现 key 本身', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/workbench/model.json'), JSON.stringify({ mode: 'own' }))
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    const item = pick(await check(fixture), 'deepseek_key')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('.env')
    expect(JSON.stringify(item)).not.toContain('sk-real')
  })

  /**
   * 2026-09-23 从零重装自跑:默认走工作台中转,顶上却挂「还没填 DeepSeek 密钥」。
   * 判据改成先看 model.json 的 mode:relay(含文件不在 = 默认)一律不催 Key。
   */
  it('★走工作台中转(令牌已领)、一把 DeepSeek Key 都没有 → ok 且可选,不催他填 Key', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    writeFileSync(join(fixture.home, '.dsh/workbench/credentials.json'), JSON.stringify({ keys: {} }))
    writeFileSync(join(fixture.home, '.dsh/workbench/model.json'), JSON.stringify({ mode: 'relay', relay_url: 'https://relay.test', relay_token: 'rt-secret' }))
    const status = await check(fixture)
    const item = pick(status, 'deepseek_key')
    expect(item.state).toBe('ok')
    expect(item.optional).toBe(true)
    expect(item.detail).toContain('工作台提供的模型服务')
    expect(JSON.stringify(item)).not.toContain('rt-secret')
  })

  it('★model.json 里只有中转地址(我们的构建 / 自建中转的新机器)= 默认中转 → 同样不催 Key', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    writeFileSync(join(fixture.home, '.dsh/workbench/credentials.json'), JSON.stringify({ keys: {} }))
    writeFileSync(join(fixture.home, '.dsh/workbench/model.json'), JSON.stringify({ relay_url: 'https://relay.test' }))
    expect(pick(await check(fixture), 'deepseek_key').state).toBe('ok')
  })

  it('零服务器档(构建不带中转、model.json 也不在):要自己的 Key,这时就催;话里不提「切回工作台的服务」', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    writeFileSync(join(fixture.home, '.dsh/workbench/credentials.json'), JSON.stringify({ keys: {} }))
    const item = pick(await check(fixture), 'deepseek_key')
    expect(item.state).toBe('needs_user')
    expect(item.fix).toContain('这台没接中转')
    expect(item.fix).not.toContain('切回')
  })

  it('中转令牌还没领到 → 仍不催 Key(那是「模型服务还没接上 → 重试」那一条的事)', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    writeFileSync(join(fixture.home, '.dsh/workbench/model.json'), JSON.stringify({ mode: 'relay', relay_url: 'https://relay.test' }))
    const item = pick(await check(fixture), 'deepseek_key')
    expect(item.state).toBe('ok')
    expect(item.detail).toContain('重试')
  })

  it('他自己切到「用自己的 Key」而且两处都没填 → needs_user,话里说清是他选的、也给切回去的路', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.dsh/.env'), '# 空的\n')
    writeFileSync(join(fixture.home, '.dsh/workbench/credentials.json'), JSON.stringify({ keys: {} }))
    writeFileSync(join(fixture.home, '.dsh/workbench/model.json'), JSON.stringify({ mode: 'own', relay_url: 'https://relay.test' }))
    const item = pick(await check(fixture), 'deepseek_key')
    expect(item.state).toBe('needs_user')
    expect(item.fix).toContain('用自己的 DeepSeek Key')
    expect(item.fix).toContain('切回')
  })

  it('★Claude hook 还指着旧位置(开发仓库里)→ stale,修法是那颗按钮,不叫他去抄模板、换仓库路径', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: '/别处/desktop-workbench/workbench-plugin/bin/agent-hook.sh claude' }] }] },
    }))
    const item = pick(await check(fixture), 'claude_hooks')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain('旧位置')
    expect(item.fix).toContain('帮我接上 Claude')
    expect(`${item.detail}${item.fix}`).not.toMatch(/仓库路径|workbench-plugin|hooks\.json/)
  })

  it('★只有别人的 hook(不是工作台的)→ needs_user:有任意一条 hook 不等于接上了', async () => {
    const fixture = fullyInstalled()
    writeFileSync(join(fixture.home, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: '/opt/headroom/bin/headroom-hook.sh' }] }] },
    }))
    expect(pick(await check(fixture), 'claude_hooks').state).toBe('needs_user')
  })

  it('★hook 指着固定位置但那个脚本不在了 → stale(重启一次工作台会放回去)', async () => {
    const fixture = fullyInstalled()
    const script = join(fixture.home, '.dsh/workbench/hooks/agent-hook.sh')
    chmodSync(script, 0o644)
    const item = pick(await check(fixture), 'claude_hooks')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain('不在了')
  })

  it('没配仓库根 → butler_cwd missing,且它不是可选项', async () => {
    const status = await check(fullyInstalled(), { repoRoot: undefined })
    const item = pick(status, 'butler_cwd')
    expect(item.state).toBe('missing')
    expect(item.optional).toBeUndefined()
    expect(status.all_ok).toBe(false)
  })

  it('客户端没装 → needs_user + 下载链接,但不拦 all_ok', async () => {
    const fixture = fullyInstalled({ exec: { mdfind: { ok: true, out: '\n' } } })
    const status = await check(fixture)
    const item = pick(status, 'client_kimi')
    expect(item.state).toBe('needs_user')
    expect(item.action).toMatchObject({ kind: 'link' })
    expect(status.all_ok).toBe(true)
    // 5 家客户端 + 完全磁盘访问那一项(2026-10-13,临时 HOME 下判断不了)。
    expect(status.optional_pending).toBe(6)
  })

  it('lastAllOk 在检查之前是 undefined(不瞎猜一个 false)', async () => {
    const fixture = fullyInstalled()
    const service = createSetupStatus({
      io: fixture.io,
      paths: setupPaths({ home: fixture.home, repoRoot: fixture.repo }),
      pluginVersion: '9.9.9',
      scanRoots: async () => [],
      now: () => NOW,
    })
    expect(service.lastAllOk()).toBeUndefined()
    await service.check()
    expect(service.lastAllOk()).toBe(false)
    expect(service.lastCheckedAt()).toBe(NOW)
  })
})

describe('就绪检查 · 那几个纯函数', () => {
  it('normalizeDshStart 抹掉仓库路径那一行的值', () => {
    const a = 'x\nexport WORKBENCH_BUTLER_CWD="/a/b"\ny'
    const b = 'x\nexport WORKBENCH_BUTLER_CWD="/c/d"\ny'
    expect(normalizeDshStart(a)).toBe(normalizeDshStart(b))
  })

  it('latestWebToken 取最新一条', () => {
    const log = 'dsh web: http://127.0.0.1:3080/?token=old\n…\ndsh web: http://127.0.0.1:3080/?token=new\n'
    expect(latestWebToken(log)).toBe('http://127.0.0.1:3080/?token=new')
    expect(latestWebToken('没有')).toBeUndefined()
  })

  it('envHasDeepseekKey 认 export 与引号,空值算没有', () => {
    expect(envHasDeepseekKey('DEEPSEEK_API_KEY=sk-1')).toBe(true)
    expect(envHasDeepseekKey('export DEEPSEEK_API_KEY="sk-1"')).toBe(true)
    expect(envHasDeepseekKey('DEEPSEEK_API_KEY=')).toBe(false)
    expect(envHasDeepseekKey('# DEEPSEEK_API_KEY=sk-1')).toBe(false)
  })

  it('credentialsHaveDeepseekKey 读坏了算没有', () => {
    expect(credentialsHaveDeepseekKey('{"keys":{"deepseek":"sk"}}')).toBe(true)
    expect(credentialsHaveDeepseekKey('{"keys":{}}')).toBe(false)
    expect(credentialsHaveDeepseekKey('不是 json')).toBe(false)
  })

  it('claudeHooksPointAt 数得出 hook 条数与里面的绝对路径', () => {
    const found = claudeHooksPointAt(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'curl /a/b.sh' }, { command: '/c/d.sh' }] }] },
      statusLine: { command: '/e/f.sh' },
    }))
    expect(found.hooks).toBe(2)
    expect(found.statusLine).toBe(true)
    expect([...found.paths].sort()).toEqual(['/a/b.sh', '/c/d.sh', '/e/f.sh'])
  })
})

describe('落脚目录与源码仓库是两件事(2026-09-18 桌面安装包)', () => {
  it('没有源码仓库、只有 app.json 里的落脚目录:那一项是绿的', async () => {
    const home = tempHome()
    const cwd = join(home, 'Documents/工作台')
    mkdirSync(cwd, { recursive: true })
    const status = createSetupStatus({
      io: nodeSetupIo(),
      paths: setupPaths({ home }),
      pluginVersion: '0.0.0',
      scanRoots: async () => [],
      butlerCwd: async () => cwd,
      now: () => Date.now(),
    })
    const item = (await status.check()).items.find(one => one.key === 'butler_cwd')
    expect(item?.state).toBe('ok')
    expect(item?.detail).toBe(cwd)
  })

  it('两条都没有时如实说没配,并把人指到设置里', async () => {
    const home = tempHome()
    const status = createSetupStatus({
      io: nodeSetupIo(),
      paths: setupPaths({ home }),
      pluginVersion: '0.0.0',
      scanRoots: async () => [],
      now: () => Date.now(),
    })
    const item = (await status.check()).items.find(one => one.key === 'butler_cwd')
    expect(item?.state).toBe('missing')
    expect(item?.fix).toContain('app.json')
  })
})


/**
 * 事务官的运营技能接没接上(2026-09-22,卡 ①「技能一键接上」)。
 *
 * 判据只有一条:`~/.dsh/AGENTS.md` 里有没有那几个标记段。这一组同时钉着
 * 「**可选**」那一格 —— 它不该让初始化页天天自己弹出来(判据见 SetupItem.optional)。
 */
describe('就绪检查 · 运营技能', () => {
  const block = (name: string): string => `${markers(name).open}\n# ${name}\n${markers(name).close}\n`

  it('AGENTS.md 压根不在 → missing,而且是可选的(不拖累 all_ok)', async () => {
    const fixture = fullyInstalled()
    // 引导还没走过的机器上本来就没有这份文件 —— 如实说"文件不在",不报错、不吓人。
    rmSync(join(fixture.home, '.dsh/AGENTS.md'))
    const item = pick(await check(fixture, { templateId: 'ops' }), 'ops_skills')
    expect(item.state).toBe('missing')
    expect(item.optional).toBe(true)
    expect(item.detail).toContain('AGENTS.md')
    expect(item.action).toEqual({ kind: 'config', target: 'template', label: '去接上技能' })
  })

  it('★运营模板、只写了一半 → missing,缺的那几段点名列出来', async () => {
    const fixture = fullyInstalled()
    mkdirSync(join(fixture.home, '.dsh'), { recursive: true })
    writeFileSync(join(fixture.home, '.dsh/AGENTS.md'), [...BASE_SKILLS, OPS_SKILLS[0] as { name: string }].map(one => block(one.name)).join('\n'))
    const item = pick(await check(fixture, { templateId: 'ops' }), 'ops_skills')
    expect(item.state).toBe('missing')
    expect(item.detail).toContain(`该有 ${BASE_SKILLS.length + OPS_SKILLS.length} 段`)
    expect(item.detail).toContain('运营-复盘')
    expect(item.fix).toContain('重新接上')
  })

  it('★运营模板、十几段都在 → ok', async () => {
    const fixture = fullyInstalled()
    mkdirSync(join(fixture.home, '.dsh'), { recursive: true })
    writeFileSync(join(fixture.home, '.dsh/AGENTS.md'), [...BASE_SKILLS, ...OPS_SKILLS].map(one => block(one.name)).join('\n'))
    const item = pick(await check(fixture, { templateId: 'ops' }), 'ops_skills')
    expect(item.state).toBe('ok')
    expect(item.detail).toContain('自媒体运营模板')
  })

  it('★切回做产品却没摘干净 → stale,说清还剩哪几段', async () => {
    const fixture = fullyInstalled()
    mkdirSync(join(fixture.home, '.dsh'), { recursive: true })
    // 2026-09-23:做产品那一包也得在,否则这一条会先红在「少一段」上而不是「还剩几段该摘」。
    writeFileSync(
      join(fixture.home, '.dsh/AGENTS.md'),
      [...BASE_SKILLS, ...PRODUCT_SKILLS, ...OPS_SKILLS].map(one => block(one.name)).join('\n'),
    )
    const item = pick(await check(fixture, { templateId: 'product' }), 'ops_skills')
    expect(item.state).toBe('stale')
    expect(item.detail).toContain(`还剩 ${OPS_SKILLS.length} 段`)
    expect(item.detail).toContain('运营-总纲')
  })

  it('做产品模板、基础那几段 + 做产品那一包 → ok(运营那几段按规矩就不该写)', async () => {
    const fixture = fullyInstalled()
    mkdirSync(join(fixture.home, '.dsh'), { recursive: true })
    writeFileSync(
      join(fixture.home, '.dsh/AGENTS.md'),
      [...BASE_SKILLS, ...PRODUCT_SKILLS].map(one => block(one.name)).join('\n'),
    )
    const item = pick(await check(fixture, { templateId: 'product' }), 'ops_skills')
    expect(item.state).toBe('ok')
    expect(item.detail).toContain('按规矩没写')
  })
})

/**
 * Codex 放没放行工作台的钩子(2026-10-21,卡「Codex 钩子信任」)。
 *
 * 新版 Codex 对没放行过的钩子静悄悄跳过;「配置里写着」≠「Codex 在跑」。这一项问的是 Codex 自己
 * (`hooks/list`,见 codexHookTrust.ts),然后用人话告诉她去哪儿点一次 —— 不让她碰终端。
 */
describe('就绪检查 · Codex 放没放行工作台的钩子', () => {
  it('没接这一问的宿主(老用例、没给依赖)→ 这一项整个缺席', async () => {
    const status = await check(fullyInstalled())
    expect(status.items.some(item => item.key === 'codex_hooks')).toBe(false)
  })

  it('★配置里压根没有工作台的钩子 → 不出这一项(那是「接上」那颗按钮的事,这里不催没接过的人)', async () => {
    const status = await check(fullyInstalled(), { codexHookTrust: { state: 'not_wired' } })
    expect(status.items.some(item => item.key === 'codex_hooks')).toBe(false)
  })

  it('都放行了 → ok,而且是可选项', async () => {
    const item = pick(await check(fullyInstalled(), { codexHookTrust: { state: 'trusted', count: 3 } }), 'codex_hooks')
    expect(item.state).toBe('ok')
    expect(item.optional).toBe(true)
    expect(item.detail).toContain('3')
  })

  it('★没放行(维护者这台 10-21)→ needs_user:说清少了什么,告诉她去 Codex 的哪一页点哪颗,给「再核一次」', async () => {
    const status = await check(fullyInstalled(), { codexHookTrust: { state: 'needs_review', count: 3, pending: 3, modified: 0 } })
    const item = pick(status, 'codex_hooks')
    expect(item.state).toBe('needs_user')
    expect(item.optional).toBe(true)
    expect(item.detail).toContain('3')
    expect(item.detail).toContain('会话区')
    expect(item.fix).toContain(CODEX_TRUST_HOW)
    expect(item.fix).toContain('全部信任')
    expect(item.action).toEqual({ kind: 'recheck', label: '再核一次' })
    // 不让她碰终端:不出现命令行、文件路径、英文术语。
    expect(`${item.detail}${item.fix}`).not.toMatch(/终端|codex exec|hooks\.json|config\.toml|trust|hook(?!\.sh)/i)
    // 可选项不拦 all_ok。
    expect(status.all_ok).toBe(true)
  })

  it('改过 / 挪了位置(modified)→ 同样要再放行一次,detail 说的是「对不上」', async () => {
    const item = pick(await check(fullyInstalled(), { codexHookTrust: { state: 'needs_review', count: 3, pending: 1, modified: 1 } }), 'codex_hooks')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('对不上')
    expect(item.fix).toContain(CODEX_TRUST_HOW)
  })

  it('她在 Codex 里关掉了 → needs_user,修法是「打开」不是「信任」', async () => {
    const item = pick(await check(fullyInstalled(), { codexHookTrust: { state: 'disabled', count: 3, disabled: 1 } }), 'codex_hooks')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('关掉')
    expect(item.fix).toContain('打开')
    expect(item.action).toEqual({ kind: 'recheck', label: '再核一次' })
  })

  it('配置里有、Codex 没认出来 → needs_user', async () => {
    const item = pick(await check(fullyInstalled(), { codexHookTrust: { state: 'not_loaded' } }), 'codex_hooks')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('没认出来')
  })

  it('★问不到 → needs_user 并如实说「问不到」,不亮绿灯也不说成「没放行」', async () => {
    const item = pick(await check(fullyInstalled(), { codexHookTrust: { state: 'unknown' } }), 'codex_hooks')
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('问不到')
    expect(item.detail).not.toContain('还没放行')
    expect(item.action).toEqual({ kind: 'recheck', label: '再核一次' })
  })
})
