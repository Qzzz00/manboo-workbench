// @vitest-environment node
/**
 * 装机形态测试:**工作台自己带 pnpm**(2026-09-27,卡 PN)。
 *
 * ## 为什么非要这一份
 *
 * 9/27 维护者在一台全新的 MacBook Air(macOS 15.7.3)上双击 0.4.47 的安装包,停在
 * 「装进 profile 失败(命令 `~/.dsh/node/bin/node` 退出码 127)」。根因:DSH 0.1.7 的
 * `dsh plugin add` **自己不装包,它转手给 pnpm**(`dsh-plugin-manager` 的
 * `execa(options.command ?? 'pnpm', …)`,找不到就回 127 并印
 * "pnpm was not found; install pnpm and make it available on PATH")。
 * 维护者那台机器上有 `/opt/homebrew/bin/pnpm`,而 `dshEnv()` 的 PATH 里正好带着
 * `/opt/homebrew/bin` —— 于是这条依赖在开发机上**从来没有暴露过**。裸机上没有 Homebrew、
 * 没有 pnpm,这一步必然 127。
 *
 * 所以工作台从这一版起**自己带一份钉死版本的 pnpm**:
 *   ① 安装包里带那个 .tgz(装的时候不联网也能装上);
 *   ② 没带(热更新那条路)就照 node 的做法下,国内镜像在前、官方在后,一律核同一份 sha256;
 *   ③ 解到 `~/.dsh/pnpm/`,并在 `~/.dsh/node/bin/pnpm` 放一个用自带 node 跑它的小脚本 ——
 *      那一段正是 `dshEnv()` 与 `bin/dsh-start` 的 PATH 第一段,所以安装器、launchd 起的 DSH、
 *      热更新装插件那一步**三条路都找得到**,一处定义。
 *
 * 这一份只用假 io(断言"调了什么命令、写了哪些文件"),真从零装那一遍在隔离环境里跑
 * (docs/交接-0927-从零安装跑通.md)。
 */
import { describe, expect, it } from 'vitest'
import { createSetupInstaller, pnpmShimScript } from '../src/server/setup/install.ts'
import { LOCKED_PNPM_VERSION, NPM_MIRROR_REGISTRY, PNPM_TARBALL_NAME, PNPM_TARBALL_SHA256, PNPM_TARBALL_URLS, setupPaths } from '../src/server/setup/paths.ts'
import type { SetupExecOptions, SetupExecResult, SetupIo } from '../src/server/setup/io.ts'
import type { SetupJobView } from '../src/server/setup/types.ts'

const HOME = '/tmp/wb-pnpm-fake-home'
const paths = setupPaths({ home: HOME })

interface Call { cmd: readonly string[], options?: SetupExecOptions }

interface FakeIo extends SetupIo {
  calls: Call[]
  files: Map<string, { text: string, mode?: number }>
  present: Set<string>
}

/**
 * 假 io。`present` 是"磁盘上已经有的路径";`exec` 由 `reply` 决定每条命令的结果
 * (缺省成功、输出空)。写文件会落进 `files` 并自动算进 `present`。
 */
function fakeIo(options: {
  present?: readonly string[]
  reply?: (cmd: readonly string[]) => SetupExecResult | undefined
} = {}): FakeIo {
  const calls: Call[] = []
  const files = new Map<string, { text: string, mode?: number }>()
  // 插件那个 .tgz 一律当"在"(这一份测的是 pnpm 那一段,不是"安装包全不全")。
  const present = new Set<string>([PLUGIN_TGZ, ...options.present ?? []])
  const io: FakeIo = {
    calls,
    files,
    present,
    readFile: async path => files.get(path)?.text,
    stat: async path => (present.has(path)
      ? { isFile: true, isDirectory: false, size: 1, mtimeMs: 0, executable: true }
      : undefined),
    readdir: async () => ({ ok: false, code: 'ENOENT', message: 'no' }),
    mkdirp: async path => { present.add(path) },
    writeFile: async (path, text, mode) => {
      files.set(path, mode === undefined ? { text } : { text, mode })
      present.add(path)
    },
    appendFile: async (path, text) => {
      const old = files.get(path)?.text ?? ''
      files.set(path, { text: old + text })
      present.add(path)
    },
    copyFile: async (_from, to) => { present.add(to) },
    chmod: async () => {},
    rmrf: async (path) => {
      for (const known of [...present]) if (known === path || known.startsWith(`${path}/`)) present.delete(known)
    },
    rename: async () => ({ ok: true }),
    exec: async (cmd, execOptions) => {
      calls.push({ cmd, ...(execOptions === undefined ? {} : { options: execOptions }) })
      // 假 tar:真 tar 会把 `bin/pnpm.mjs` 解出来,所以这里也要让那条路径"出现"
      // —— 不然"装完当场跑一次"那一关在假 io 里永远过不去(而它正是要测的东西)。
      if (cmd[0] === 'tar' && cmd.includes(paths.pnpmDir)) present.add(paths.pnpmEntry)
      return options.reply?.(cmd) ?? { ok: true, code: 0, out: '' }
    },
    fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    currentNodeBinary: () => paths.nodeBin,
    uid: () => 501,
  }
  return io
}

/** 跑一步,等它跑完,把作业回出来。 */
async function runStep(io: SetupIo, prebuilt: Record<string, string> = {}): Promise<SetupJobView> {
  const installer = createSetupInstaller({
    io,
    paths,
    repoRoot: '/tmp/wb-pnpm-fake-payload',
    now: () => 0,
    newId: () => 'job',
    prebuilt,
  })
  const started = installer.start('plugin')
  await installer.wait(started.id)
  return installer.job(started.id) as SetupJobView
}

const PLUGIN_TGZ = '/tmp/wb-pnpm-fake-payload/plugin/x.tgz'
const BUNDLED_TGZ = `/tmp/wb-pnpm-fake-payload/pnpm/${PNPM_TARBALL_NAME}`

/** 一条命令有没有被调过(前缀匹配)。 */
function called(io: FakeIo, prefix: readonly string[]): Call | undefined {
  return io.calls.find(call => prefix.every((part, index) => call.cmd[index] === part))
}

describe('自带 pnpm', () => {
  it('钉死的版本、镜像顺序、sha256 都在仓库里(换版本要一起改)', () => {
    expect(LOCKED_PNPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(PNPM_TARBALL_NAME).toBe(`pnpm-${LOCKED_PNPM_VERSION}.tgz`)
    // 国内镜像在前、官方在后(同 node 的那条理由:nodejs.org / npmjs.org 在国内会断流)。
    expect(PNPM_TARBALL_URLS[0]).toContain('npmmirror.com')
    expect(PNPM_TARBALL_URLS[PNPM_TARBALL_URLS.length - 1]).toContain('registry.npmjs.org')
    for (const url of PNPM_TARBALL_URLS) expect(url.endsWith(`/${PNPM_TARBALL_NAME}`)).toBe(true)
    expect(PNPM_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('小脚本用自带 node 跑自带 pnpm,不碰机器上别的 node', () => {
    const script = pnpmShimScript(paths)
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`exec "${paths.nodeBin}" "${paths.pnpmEntry}" "$@"`)
    expect(script).not.toContain('/opt/homebrew')
  })

  it('安装包里带了 .tgz 就不联网:核 sha256 → 解包 → 写小脚本 → 当场跑一次', async () => {
    const io = fakeIo({
      present: [BUNDLED_TGZ],
      reply: (cmd) => {
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  ${BUNDLED_TGZ}\n` }
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(view.state).toBe('done')
    // 一条 curl 都没跑(安装包里带着,装的时候不该联网)。
    expect(called(io, ['curl'])).toBeUndefined()
    expect(called(io, ['shasum', '-a', '256', BUNDLED_TGZ])).toBeDefined()
    const untar = called(io, ['tar', '-xzf', BUNDLED_TGZ])
    expect(untar?.cmd).toContain(paths.pnpmDir)
    expect(io.files.get(paths.pnpmBin)?.mode).toBe(0o755)
    expect(io.files.get(paths.pnpmBin)?.text).toBe(pnpmShimScript(paths))
    // 装完当场跑一次(不验就等于把"装没装上"留给下一步去报一串怪错)。
    expect(called(io, [paths.pnpmBin, '--version'])).toBeDefined()
  })

  it('装 pnpm 排在 `dsh plugin add` 之前,而且那一步的 PATH 第一段就是自带 node 的 bin', async () => {
    const io = fakeIo({
      present: [BUNDLED_TGZ],
      reply: (cmd) => {
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  x\n` }
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        return undefined
      },
    })
    await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    const shim = io.calls.findIndex(call => call.cmd[0] === paths.pnpmBin)
    const add = io.calls.findIndex(call => call.cmd.includes('plugin') && call.cmd.includes('add'))
    expect(shim).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThan(shim)
    expect(io.calls[add]?.options?.env?.PATH?.startsWith(`${paths.dshHome}/node/bin:`)).toBe(true)
  })

  /**
   * 装插件那一步**是要联网的**:`dsh plugin add` 转手给 pnpm,pnpm 要去 registry 取这个
   * 插件的 peer 依赖(2026-09-27 隔离环境实测 96 个包、约 37MB)。国内那条线断流是常态,
   * 所以照 node 的做法留一条镜像退路 —— 只是顺序反过来:官方在前(它给 integrity),
   * 镜像在后(不通时总比装不上强)。
   */
  it('`plugin add` 官方源没成时,换国内镜像再试一次', async () => {
    const attempts: string[][] = []
    const io = fakeIo({
      present: [BUNDLED_TGZ, paths.pnpmEntry, paths.pnpmBin],
      reply: (cmd) => {
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        if (cmd.includes('plugin') && cmd.includes('add')) {
          attempts.push([...cmd])
          return cmd.some(part => part.startsWith('--registry='))
            ? { ok: true, code: 0, out: '' }
            : { ok: false, code: 1, out: 'ERR_PNPM_META_FETCH_FAIL  request to https://registry.npmjs.org/… failed' }
        }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(view.state).toBe('done')
    expect(attempts).toHaveLength(2)
    // 第一趟不带 --registry(官方源);第二趟才换镜像。
    expect(attempts[0]?.some(part => part.startsWith('--registry='))).toBe(false)
    expect(attempts[1]?.at(-1)).toBe(`--registry=${NPM_MIRROR_REGISTRY}`)
  })

  it('两条源都没成:失败那句话里两次的退出码都在', async () => {
    const io = fakeIo({
      present: [BUNDLED_TGZ, paths.pnpmEntry, paths.pnpmBin],
      reply: (cmd) => {
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        if (cmd.includes('plugin') && cmd.includes('add')) return { ok: false, code: 1, out: '连不上' }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(view.state).toBe('failed')
    expect(view.error).toContain('装进 profile 失败')
    expect(view.error).toContain('国内镜像')
  })

  it('已经装好了就一个字不动(幂等):不解包、不写文件', async () => {
    const io = fakeIo({
      present: [paths.pnpmEntry, paths.pnpmBin, BUNDLED_TGZ],
      reply: cmd => (cmd[0] === paths.pnpmBin ? { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` } : undefined),
    })
    await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(called(io, ['tar'])).toBeUndefined()
    expect(io.files.has(paths.pnpmBin)).toBe(false)
  })

  it('装着的那份版本不对(比如上一版带的旧 pnpm)就重新装一份', async () => {
    const io = fakeIo({
      present: [paths.pnpmEntry, paths.pnpmBin, BUNDLED_TGZ],
      reply: (cmd) => {
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  x\n` }
        // 第一次探是旧版本,解包之后再探才是钉死那一版。
        if (cmd[0] === paths.pnpmBin) {
          return io.calls.filter(call => call.cmd[0] === paths.pnpmBin).length <= 1
            ? { ok: true, code: 0, out: '9.0.0\n' }
            : { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        }
        return undefined
      },
    })
    await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(called(io, ['tar'])).toBeDefined()
    expect(io.files.get(paths.pnpmBin)?.text).toBe(pnpmShimScript(paths))
  })

  it('没带 .tgz(热更新那条路)就按镜像顺序下,核同一份 sha256', async () => {
    const io = fakeIo({
      reply: (cmd) => {
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  x\n` }
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ })

    expect(view.state).toBe('done')
    const curl = called(io, ['curl'])
    expect(curl?.cmd.at(-1)).toBe(PNPM_TARBALL_URLS[0])
    expect(curl?.cmd).toContain(`${paths.pnpmDownloadDir}/${PNPM_TARBALL_NAME}`)
  })

  it('第一条源下不成就换下一条', async () => {
    const io = fakeIo({
      reply: (cmd) => {
        if (cmd[0] === 'curl') {
          return cmd.at(-1) === PNPM_TARBALL_URLS[0] ? { ok: false, code: 7, out: '连不上' } : { ok: true, code: 0, out: '' }
        }
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  x\n` }
        if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ })

    expect(view.state).toBe('done')
    expect(io.calls.filter(call => call.cmd[0] === 'curl')).toHaveLength(2)
  })

  it('sha256 对不上就停在这一步,而且不留那个坏包', async () => {
    const io = fakeIo({
      present: [BUNDLED_TGZ],
      reply: cmd => (cmd[0] === 'shasum' ? { ok: true, code: 0, out: `dead${'0'.repeat(60)}  x\n` } : undefined),
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(view.state).toBe('failed')
    expect(view.error).toContain('sha256')
    expect(called(io, ['tar'])).toBeUndefined()
    // 一个装不上 pnpm 的机器不许往下走到 plugin add(那只会回一句 127,没人看得懂)。
    expect(io.calls.some(call => call.cmd.includes('plugin') && call.cmd.includes('add'))).toBe(false)
  })

  it('装完跑不起来 / 版本不对,失败那句话里说的是 pnpm,不是 127', async () => {
    const io = fakeIo({
      present: [BUNDLED_TGZ],
      reply: (cmd) => {
        if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  x\n` }
        if (cmd[0] === paths.pnpmBin) return { ok: false, code: 1, out: '起不来' }
        return undefined
      },
    })
    const view = await runStep(io, { pluginTarball: PLUGIN_TGZ, pnpmTarball: BUNDLED_TGZ })

    expect(view.state).toBe('failed')
    expect(view.error).toContain('pnpm')
  })
})
