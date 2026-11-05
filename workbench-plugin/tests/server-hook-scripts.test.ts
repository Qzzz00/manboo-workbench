// @vitest-environment node
/**
 * 钩子脚本放到固定位置(2026-09-25,卡 R「接额度用的钩子脚本随插件走」)。
 *
 * 钉的是这几件事:
 * 1. 脚本来源先认「这份代码自己所在的插件包」(package.json 名字对得上的那一层的 bin/),
 *    开发仓库只是最后的兜底;**不看 butler_cwd**(这个模块压根没有那个参数)。
 * 2. 同步到 `<home>/.dsh/workbench/hooks/`:内容有变才覆盖、换上去的能执行;内容一样一个字不写。
 * 3. 来源找不到时,固定位置上原有那一份能跑就接着用;连那一份都没有才算接不上。
 * 4. 接不上时那一句是人话:没有仓库、插件、路径、英文文件名,以「再试一次」收尾。
 *
 * 全部在 mkdtemp 出来的沙箱里跑,一个字节都不碰真实的 `~/.dsh`。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOOK_SCRIPTS_ERRORS,
  PACKAGE_RUNTIME_FILES,
  WB_PLUGIN_PACKAGE_NAME,
  createHookScripts,
  nodeHookScriptsIo,
  wbHookScriptsSource,
  wbPluginPackageRoot,
} from '../src/server/hookScripts.ts'

/** 这份 checkout 里的插件包根(workbench-plugin/)。 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hook-scripts-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  return { dir, home, hooks: join(home, '.dsh', 'workbench', 'hooks') }
}

/** 在沙箱里摆一份"装好的插件包":package.json + lib/ + bin/ 里那两个脚本(内容可以指定)。 */
function fakePackage(root: string, scripts: { hook?: string, statusline?: string } = {}): string {
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: WB_PLUGIN_PACKAGE_NAME, version: '9.9.9' }))
  if (scripts.hook !== undefined) writeFileSync(join(root, 'bin', 'agent-hook.sh'), scripts.hook)
  if (scripts.statusline !== undefined) writeFileSync(join(root, 'bin', 'claude-statusline.sh'), scripts.statusline)
  return join(root, 'lib')
}

const HOOK_V1 = '#!/usr/bin/env bash\n# v1\nexit 0\n'
const HOOK_V2 = '#!/usr/bin/env bash\n# v2\nexit 0\n'
const LINE_V1 = '#!/usr/bin/env bash\n# statusline v1\nprintf x\n'

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('运行时要从包里读的文件', () => {
  it('就这两个钩子脚本(package-files-guard 拿 npm pack 的真实清单逐项对这张表)', () => {
    expect(PACKAGE_RUNTIME_FILES).toEqual(['bin/agent-hook.sh', 'bin/claude-statusline.sh'])
  })
})

describe('脚本从哪来', () => {
  it('这份 checkout:从 src/server 往上找到 package.json 名字对得上的那一层 = workbench-plugin/', async () => {
    const io = nodeHookScriptsIo()
    expect(await wbPluginPackageRoot(join(PLUGIN_ROOT, 'src', 'server'), io)).toBe(PLUGIN_ROOT)
    expect(await wbHookScriptsSource({ moduleDir: join(PLUGIN_ROOT, 'src', 'server'), io }))
      .toEqual({ dir: `${PLUGIN_ROOT}/bin`, from: 'package' })
  })

  it('装好的包(pnpm 那种带版本号的目录名、身边没有任何仓库):认包自己的 bin/', async () => {
    const box = sandbox()
    const pkg = join(box.home, '.dsh', 'profiles', 'web', 'node_modules', '.pnpm', '@ben+dsh-workbench@file+x-9.9.9.tgz', 'node_modules', '@ben', 'dsh-workbench')
    const lib = fakePackage(pkg, { hook: HOOK_V1, statusline: LINE_V1 })
    expect(await wbHookScriptsSource({ moduleDir: lib, io: nodeHookScriptsIo() })).toEqual({ dir: join(pkg, 'bin'), from: 'package' })
  })

  it('名字对不上的 package.json 一律跳过,不拿别的包的 bin/ 顶替', async () => {
    const box = sandbox()
    const other = join(box.dir, 'other-package')
    mkdirSync(join(other, 'lib'), { recursive: true })
    mkdirSync(join(other, 'bin'), { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'someone-else' }))
    writeFileSync(join(other, 'bin', 'agent-hook.sh'), HOOK_V1)
    writeFileSync(join(other, 'bin', 'claude-statusline.sh'), LINE_V1)
    expect(await wbHookScriptsSource({ moduleDir: join(other, 'lib'), io: nodeHookScriptsIo() })).toBeUndefined()
  })

  it('包里没带脚本(卡 R 之前的包就是这样)→ 往上找开发仓库兜底;都没有 → undefined', async () => {
    const box = sandbox()
    // 开发仓库的样子:<repo>/workbench-plugin/bin/…,而跑的那份代码在一个不带脚本的包里。
    const repo = join(box.dir, 'repo')
    mkdirSync(join(repo, 'workbench-plugin', 'bin'), { recursive: true })
    writeFileSync(join(repo, 'workbench-plugin', 'bin', 'agent-hook.sh'), HOOK_V1)
    writeFileSync(join(repo, 'workbench-plugin', 'bin', 'claude-statusline.sh'), LINE_V1)
    const lib = fakePackage(join(repo, 'somewhere', 'pkg'))
    expect(await wbHookScriptsSource({ moduleDir: lib, io: nodeHookScriptsIo() }))
      .toEqual({ dir: join(repo, 'workbench-plugin', 'bin'), from: 'dev_repo' })

    const bare = fakePackage(join(box.dir, 'bare', 'pkg'))
    expect(await wbHookScriptsSource({ moduleDir: bare, io: nodeHookScriptsIo() })).toBeUndefined()
  })
})

describe('同步到固定位置', () => {
  it('★第一次:两个脚本放到 <home>/.dsh/workbench/hooks/,内容与包里一字不差,能执行', async () => {
    const box = sandbox()
    const lib = fakePackage(join(box.dir, 'pkg'), { hook: HOOK_V1, statusline: LINE_V1 })
    const scripts = createHookScripts({ home: box.home, moduleDir: lib })
    expect(scripts.dir).toBe(box.hooks)
    expect(scripts.hookScript).toBe(join(box.hooks, 'agent-hook.sh'))
    const result = await scripts.ensure()
    expect(result).toEqual({ ok: true, dir: box.hooks, from: 'package', changed: ['agent-hook.sh', 'claude-statusline.sh'], stale: [] })
    expect(readFileSync(join(box.hooks, 'agent-hook.sh'), 'utf8')).toBe(HOOK_V1)
    expect(readFileSync(join(box.hooks, 'claude-statusline.sh'), 'utf8')).toBe(LINE_V1)
    expect(mode(join(box.hooks, 'agent-hook.sh'))).toBe(0o755)
    expect(mode(join(box.hooks, 'claude-statusline.sh'))).toBe(0o755)
    // 目录里只有这两个(改名前那个临时文件不留下)。
    expect(readdirSync(box.hooks).sort()).toEqual(['agent-hook.sh', 'claude-statusline.sh'])
  })

  it('★内容一样就一个字不写(每次起服务都调,不能每次都换一遍)', async () => {
    const box = sandbox()
    const lib = fakePackage(join(box.dir, 'pkg'), { hook: HOOK_V1, statusline: LINE_V1 })
    const scripts = createHookScripts({ home: box.home, moduleDir: lib })
    await scripts.ensure()
    const before = statSync(join(box.hooks, 'agent-hook.sh')).ino
    const again = await scripts.ensure()
    expect(again.ok && again.changed).toEqual([])
    expect(statSync(join(box.hooks, 'agent-hook.sh')).ino).toBe(before)
  })

  it('★插件升级了(包里内容变了)→ 换成新的;位置不变,命令不用改', async () => {
    const box = sandbox()
    const pkg = join(box.dir, 'pkg')
    const lib = fakePackage(pkg, { hook: HOOK_V1, statusline: LINE_V1 })
    await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
    writeFileSync(join(pkg, 'bin', 'agent-hook.sh'), HOOK_V2)
    const result = await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
    expect(result.ok && result.changed).toEqual(['agent-hook.sh'])
    expect(readFileSync(join(box.hooks, 'agent-hook.sh'), 'utf8')).toBe(HOOK_V2)
    expect(mode(join(box.hooks, 'agent-hook.sh'))).toBe(0o755)
  })

  it('内容一样但执行权限丢了 → 补上,不重写内容', async () => {
    const box = sandbox()
    const lib = fakePackage(join(box.dir, 'pkg'), { hook: HOOK_V1, statusline: LINE_V1 })
    await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
    chmodSync(join(box.hooks, 'agent-hook.sh'), 0o644)
    const result = await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
    expect(result.ok && result.changed).toEqual([])
    expect(mode(join(box.hooks, 'agent-hook.sh'))).toBe(0o755)
  })

  it('★来源找不到(包里没有、也没有开发仓库)但固定位置上原有一份能跑 → 接着用它(不删、不改)', async () => {
    const box = sandbox()
    const good = fakePackage(join(box.dir, 'good'), { hook: HOOK_V1, statusline: LINE_V1 })
    await createHookScripts({ home: box.home, moduleDir: good }).ensure()
    const broken = fakePackage(join(box.dir, 'broken'))
    const result = await createHookScripts({ home: box.home, moduleDir: broken }).ensure()
    expect(result).toEqual({ ok: true, dir: box.hooks, from: 'kept', changed: [], stale: [] })
    expect(readFileSync(join(box.hooks, 'agent-hook.sh'), 'utf8')).toBe(HOOK_V1)
  })

  it('★来源找不到、固定位置上也没有 → 接不上(no_source),一个文件都不造', async () => {
    const box = sandbox()
    const broken = fakePackage(join(box.dir, 'broken'))
    const result = await createHookScripts({ home: box.home, moduleDir: broken }).ensure()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no_source')
    expect(result.error).toBe(HOOK_SCRIPTS_ERRORS.no_source)
    expect(existsSync(box.hooks)).toBe(false)
  })

  it('★放不进去(目录只读)→ write_failed;原有一份能跑时先接着用它、只记一笔 stale', async () => {
    const box = sandbox()
    const pkg = join(box.dir, 'pkg')
    const lib = fakePackage(pkg, { hook: HOOK_V1, statusline: LINE_V1 })

    // 第一次就放不进去:那就是真接不上。
    mkdirSync(box.hooks, { recursive: true })
    chmodSync(box.hooks, 0o500)
    try {
      const first = await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
      expect(first.ok).toBe(false)
      if (first.ok) return
      expect(first.reason).toBe('write_failed')
      expect(first.error).toBe(HOOK_SCRIPTS_ERRORS.write_failed)
      expect(first.detail).toContain('agent-hook.sh')
    }
    finally { chmodSync(box.hooks, 0o700) }

    // 放进去一份 v1,再升级到 v2 时目录只读:v1 还能跑 → ok,stale 里记一笔。
    await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
    writeFileSync(join(pkg, 'bin', 'agent-hook.sh'), HOOK_V2)
    chmodSync(box.hooks, 0o500)
    try {
      const upgraded = await createHookScripts({ home: box.home, moduleDir: lib }).ensure()
      expect(upgraded).toEqual({ ok: true, dir: box.hooks, from: 'package', changed: [], stale: ['agent-hook.sh'] })
      expect(readFileSync(join(box.hooks, 'agent-hook.sh'), 'utf8')).toBe(HOOK_V1)
    }
    finally { chmodSync(box.hooks, 0o700) }
  })

  it('★家目录不知道 → no_home,不往根目录下放任何东西', async () => {
    const scripts = createHookScripts({ home: '', moduleDir: join(PLUGIN_ROOT, 'src', 'server') })
    expect(scripts.dir).toBeUndefined()
    expect(scripts.hookScript).toBeUndefined()
    const result = await scripts.ensure()
    expect(result.ok === false && result.reason).toBe('no_home')
  })

  it('同时来两次(起服务那一下撞上「接上」)→ 排队,结果一致,不留半份', async () => {
    const box = sandbox()
    const lib = fakePackage(join(box.dir, 'pkg'), { hook: HOOK_V1, statusline: LINE_V1 })
    const scripts = createHookScripts({ home: box.home, moduleDir: lib })
    const [a, b] = await Promise.all([scripts.ensure(), scripts.ensure()])
    expect(a.ok && a.changed).toEqual(['agent-hook.sh', 'claude-statusline.sh'])
    expect(b.ok && b.changed).toEqual([])
    expect(readdirSync(box.hooks).sort()).toEqual(['agent-hook.sh', 'claude-statusline.sh'])
  })
})

describe('接不上时那一句', () => {
  it('★三种都是人话:不出现仓库、插件、路径、英文文件名,也不叫他去改设置;以「再试一次」给下一步', () => {
    for (const text of Object.values(HOOK_SCRIPTS_ERRORS)) {
      expect(text).not.toMatch(/仓库|插件|设置|\/|[A-Za-z]/)
      expect(text).toContain('再试一次')
      expect(text).toContain('你的配置一个字都没动')
    }
  })
})
