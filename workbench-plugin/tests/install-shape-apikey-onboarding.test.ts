// @vitest-environment node
/**
 * 装机形态测试:**第一次打开工作台,上游不弹「添加一个 API Key」框**(2026-09-26,卡 AK)。
 *
 * ## 这份守的是什么
 *
 * 维护者 09-26:「我看现在首次使用,好像会弹出来要填写 API key 的弹窗」。
 * 那个框是上游 `ui-settings-models` 的 `deepseek-official` 那一步(`DeepSeekOnboardingDialog`),
 * 弹的时候 `OnboardingModal` 把 `#root` 设成 inert —— **我们的注册页整页点不动**。
 *
 * 判据全在上游 `store.ts` 的 `onboardingReadiness` → `providerUsable`:
 * **一个能用的 provider 都没有**才弹;能用 = 路由已注册 且(profile 没写 `apiKeyEnv`,
 * 或写了而那个凭据已配)。我们那条 `workbench-relay` 写的是 `apiKeyEnv: WORKBENCH_RELAY_TOKEN`,
 * 而令牌是**用户注册之后我们的服务器才发下来的** —— 第一次打开的那一刻,这条判据在物理上
 * 就满足不了。所以这份测试分两半:
 *
 * - **上半(叫上游自己的判断函数)**:证明「中转配好 + 令牌在 = 不再需要 API key」,
 *   以及「令牌还没下发 = 上游一定会弹」—— 后者正是为什么光靠喂满判据修不了首屏。
 * - **下半(真 dsh 合一遍)**:证明我们写进补丁层那一行**真的被上游读到了**
 *   (按 id 找不到只 warn 一句然后跳过,界面上一切正常 —— U4 那个 cookie 的坑就是这么活下来的)。
 *
 * ## 哪几样是假的 / 硬线
 *
 * - 令牌是夹具里的假串,**真令牌一次都不出现在这份文件里,也不进日志**;
 * - **不起服务、不占端口**:`--dump-config` 只把合成结果打到 stdout 就退出;
 * - **生产一个字节不碰**:`DSH_HOME` 是 mkdtemp 出来的,`runtime` 是符号链接指向那份已装好的
 *   0.1.7(514MB,不拷),`launchctl` 一次都不跑。
 *
 * 没有那份真运行时时下半**整个跳过并说清原因**(见 `tests/support/dshRuntime.ts`)。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROFILE_MODELS_ONBOARDING_MARK, PROFILE_MODELS_ONBOARDING_ROW_ID,
  profilePackageJson, renderProfilePatch,
} from '../src/server/setup/install.ts'
import { DSH_RELAY_PROVIDER, DSH_RELAY_TOKEN_ENV } from '../src/server/dshModelSettings.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { dshNode, pickDshRuntime } from './support/dshRuntime.ts'

const RUNTIME = pickDshRuntime()
const NODE = dshNode()

/** 上游 checkout(同 `client-onboarding-gate.test.ts` 的口子)。 */
const harnessDir = process.env.DSH_HARNESS_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deepseek-harness')
const harnessRead = (rel: string) => readFileSync(join(harnessDir, 'packages', 'client', rel), 'utf8')

/**
 * 上游那份判据的**真代码**,运行时 import 进来直接调。
 *
 * 为什么不用 `import ... from`:那会把上游那个文件拖进我们的 `tsc --noEmit`,而它 import 的
 * `@deepseek-ai/dsh-api-remotes/client` 等几个包不在我们的 node_modules 里(我们只链了 9 个)。
 * 运行时 import 拿到的是真函数,类型检查这一侧当它是普通对象 —— 要的就是「调的是上游那一份,
 * 不是我们抄过来的一份」。`store.ts` 的运行时依赖只有 `@deepseek-ai/dsh-client-store`
 * (vitest.config.ts 里有别名),其余全是 `import type`,所以加载得动。
 */
type Readiness = { kind: string, reason?: string }
async function upstreamJudge(): Promise<{
  providerUsable: (row: unknown) => boolean
  onboardingReadiness: (state: unknown) => Readiness
}> {
  const url = pathToFileURL(join(harnessDir, 'packages/client/ui-settings-models/src/client/store.ts')).href
  const mod = await import(/* @vite-ignore */ url) as Record<string, unknown>
  return {
    providerUsable: mod.providerUsable as (row: unknown) => boolean,
    onboardingReadiness: mod.onboardingReadiness as (state: unknown) => Readiness,
  }
}

/** 夹具里的假令牌。**真令牌一次都不出现在这份文件里。** */
const FAKE_TOKEN_REF_CONFIGURED = { configured: true, source: 'user-env', writable: true }

/**
 * 我们这台机器在上游那张「provider 表」里长什么样。
 *
 * 两行都照真形态写:`workbench-relay` 是 pi-ai 的 `directoryEntries` 给的(hand-declared 路由,
 * `settingsNs` 取补丁里那一行的 id `llm-pi-ai`,`settingsPath` 是 `['providers', <路由名>]`),
 * `deepseek-official` 是上游 `llm-deepseek` 那条(base 组合里两代都在)。
 * `apiKeyEnv` 就是我们写进补丁层的那个引用名 —— **只有名字,没有值**。
 */
function rowsOfThisMachine(options: { relayTokenConfigured: boolean }): unknown[] {
  return [
    {
      entry: {
        provider: DSH_RELAY_PROVIDER,
        displayName: '工作台提供的模型服务',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', DSH_RELAY_PROVIDER],
        active: true,
        declared: true,
      },
      configured: true,
      removable: true,
      apiKeyEnv: DSH_RELAY_TOKEN_ENV,
      credential: options.relayTokenConfigured ? FAKE_TOKEN_REF_CONFIGURED : { configured: false, writable: true },
    },
    {
      entry: {
        provider: 'deepseek-official',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: [],
        active: true,
      },
      configured: false,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    },
  ]
}

function stateOf(rows: unknown[]): unknown {
  return { status: 'ready', error: null, credentialError: null, writable: true, rows, namespaces: new Map() }
}

describe('★上游自己的判据:什么时候它认为「还需要一个 API Key」', () => {
  it('中转配好、令牌也在 → provider-ready(上游自己说:不需要 API key)', async () => {
    const { onboardingReadiness, providerUsable } = await upstreamJudge()
    const rows = rowsOfThisMachine({ relayTokenConfigured: true })
    expect(providerUsable(rows[0])).toBe(true)
    expect(onboardingReadiness(stateOf(rows)).kind).toBe('provider-ready')
  })

  /**
   * ★ 这一条是「为什么光把凭据位喂满修不了首屏」的证据。
   * 第一次打开工作台时用户还没注册,令牌**还不存在** —— 上游这时一定判 `credential-missing`,
   * 也就是一定弹。所以首屏那一层只能用上游自己给的开关(见下面那一组)。
   */
  it('令牌还没下发(第一次打开的那一刻)→ credential-missing:上游一定弹', async () => {
    const { onboardingReadiness, providerUsable } = await upstreamJudge()
    const rows = rowsOfThisMachine({ relayTokenConfigured: false })
    expect(providerUsable(rows[0])).toBe(false)
    expect(onboardingReadiness(stateOf(rows)).kind).toBe('credential-missing')
  })

  it('判据本身没变:providerUsable 还是那三句(变了就来重看这张卡)', () => {
    const store = harnessRead('ui-settings-models/src/client/store.ts')
    expect(store).toContain('if (!row.entry.active) return false')
    expect(store).toContain('if (row.apiKeyEnv === undefined) return true')
    expect(store).toContain("return row.credential?.configured === true")
    expect(store).toContain('if (state.rows.some(providerUsable)) return { kind: \'provider-ready\' }')
  })
})

describe('★上游给的那个开关还在、名字没变、语义没变', () => {
  it('Host 半区的配置项就叫 credentialOnboarding,缺省 true,而且只有这一个键', () => {
    const config = harnessRead('ui-settings-models/src/onboarding-config.ts')
    expect(config).toContain('credentialOnboarding: boolean')
    expect(config).toContain('credentialOnboarding: z.boolean().default(true)')
    // 补丁按 id **整体替换** config:上游哪天加了第二个键,我们这一行就会把它抹掉 —— 那时这条红。
    const keys = [...new Set([...config.matchAll(/^ {2}(\w+):/gm)].map(m => m[1]))]
    expect(keys).toEqual(['credentialOnboarding'])
    // 注释原话(我们据此说「工作台就是那个原生壳」)。
    expect(config).toContain('when no native shell owns credential onboarding')
  })

  it('配成 false 之后上游那一步自己让位:complete() 然后画 null', () => {
    const dialog = harnessRead('ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx')
    // automatic 就是从这个配置项来的。
    expect(harnessRead('ui-settings-models/src/client/index.ts')).toContain('automatic: credentialOnboarding')
    // 不是自动、也不是被点名 → 标记这一步做完(不挡住后面的),然后什么都不画。
    expect(dialog).toContain('(!automatic && !explicit)')
    expect(dialog).toContain('if (!automatic && !explicit) return null')
    // 「点名要这一步」那条路还留着 —— 我们关的只是自动弹的那一下。
    expect(dialog).toContain('const [apiKey, setApiKey] = useState(explicit)')
  })

  it('上游 web 组合里那一行是光秃秃的 id + name(写 config 不会抹掉它原有的东西)', () => {
    const bundle = readFileSync(join(harnessDir, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
    const at = bundle.indexOf(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}\n`)
    expect(at, '上游 web 组合里没有这一行了?').toBeGreaterThan(0)
    const row = bundle.slice(at, bundle.indexOf('\n\n', at))
    expect(row).toContain("name: '@deepseek-ai/dsh-client-ui-settings-models'")
    expect(row).not.toContain('config:')
  })
})

describe('补丁层:新装写上,老机器幂等补上', () => {
  it('新装:那一行与 credentialOnboarding: false 都在', () => {
    const patch = renderProfilePatch(undefined)
    expect(patch).toContain(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}\n  config:\n    credentialOnboarding: false\n`)
  })

  it('★老机器(升上来之前写的那份补丁,没有这一段)→ 补一次;再跑一次一个字不动', () => {
    const old = '# 工作台登录台生成(可以继续往下加别的补丁)。\n'
      + '\n- insert:\n    - id: ben-workbench\n      name: \'@ben/dsh-workbench\'\n'
      + '\n- id: connection\n  config:\n    trustedHosts: !!js ctx.webRuntime.trustedHosts\n    cookieMaxAgeDays: 3650\n'
      + '\n# 对用户关掉的上游新入口(升 0.1.7 时定)。\n- id: ui-sidebar-terminal\n  disabled: true\n'
    expect(old).not.toContain(PROFILE_MODELS_ONBOARDING_MARK)
    const once = renderProfilePatch(old)
    expect(once).toContain(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}`)
    expect(once).toContain('credentialOnboarding: false')
    // 他原来那几行一个字节都没动。
    expect(once.startsWith(old)).toBe(true)
    // 幂等:开机 / 热更新每次都跑,不能每次都往后堆一段。
    expect(renderProfilePatch(once)).toBe(once)
  })

  it('★维护者自己把这一段删了(他就想要上游那个框)→ 不再塞回去', () => {
    const full = renderProfilePatch(undefined)
    // 只删我们那几行,注释里那句记号留着 —— 记号就是"补过了"的凭证。
    const removed = full.replace(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}\n  config:\n    credentialOnboarding: false\n`, '')
    expect(removed).not.toContain(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}`)
    expect(renderProfilePatch(removed)).toBe(removed)
  })
})

const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-apikey-')
const boxes: string[] = []
afterEach(() => {
  // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

/** 摆出一台「登录台刚建好 profile」的机器。 */
function freshMachine() {
  const home = mkdtempSync(BOX_PREFIX)
  boxes.push(home)
  const paths = setupPaths({ home })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  symlinkSync(RUNTIME.dir, paths.runtimeDir) // 514MB 不拷,只读着用
  mkdirSync(paths.profileDir, { recursive: true })
  writeFileSync(paths.profilePackageJson, profilePackageJson())
  writeFileSync(paths.profilePatchYml, renderProfilePatch(undefined))
  return { home, paths }
}

function dumpConfig(dshHome: string, runtimeDir: string): { config: string, warnings: string } {
  const run = spawnSync(
    NODE,
    [join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--dump-config'],
    { cwd: runtimeDir, env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (run.status !== 0) throw new Error(`dsh --dump-config 退了 ${String(run.status)}:${run.stderr}`)
  return { config: run.stdout, warnings: run.stderr }
}

describe.skipIf(!RUNTIME.ready)('0.1.7 形态:真 dsh 合出来的那一行就是我们写进去的', () => {
  it('★它没被跳过,而且合出来带着 credentialOnboarding: false', () => {
    const box = freshMachine()
    const { config: dump, warnings } = dumpConfig(box.paths.dshHome, box.paths.runtimeDir)

    /**
     * ★ 先看 dsh 有没有抱怨过这一行。上游 `applyEntryPatches` 对「补丁指着一个不存在的 id」
     * 是 `warn("patch: entry %C not found")` **然后跳过** —— 合成结果里一个字都看不出来,
     * 界面上也一切正常,而那个框照弹。U4 撞出来的 cookie 那个坑就是这么活了三个版本的。
     */
    expect(warnings).not.toContain(`entry "${PROFILE_MODELS_ONBOARDING_ROW_ID}" not found`)
    expect(warnings).not.toContain(`name mismatch for "${PROFILE_MODELS_ONBOARDING_ROW_ID}"`)

    expect(dump).toContain([
      `- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}`,
      "  name: '@deepseek-ai/dsh-client-ui-settings-models'",
      '  config:',
      '    credentialOnboarding: false',
    ].join('\n'))
    expect(dump).toContain(`patched by ${box.paths.profilePatchYml}`)
    /**
     * 页本身没被关掉 —— 想自己填 Key 的人照样进得去。
     * 只看**这一行自己那一块**(到同缩进的下一个 `- id:` 为止):整段 dump 里到处都是
     * 别人的 `disabled: true`,拿正则在全文里找会误判。
     */
    const at = dump.indexOf(`- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}\n`)
    expect(at, 'dump 里没有这一行?').toBeGreaterThan(0)
    const indent = ' '.repeat(at - (dump.lastIndexOf('\n', at - 1) + 1))
    const nextRow = dump.indexOf(`\n${indent}- id: `, at + 1)
    const block = dump.slice(at, nextRow === -1 ? undefined : nextRow)
    expect(block).toContain('credentialOnboarding: false')
    expect(block).not.toContain('disabled:')
  })

  it('★整份补丁层零告警(这一行加进来没把别的行带歪)', () => {
    const box = freshMachine()
    const { warnings } = dumpConfig(box.paths.dshHome, box.paths.runtimeDir)
    expect(warnings).not.toContain('not found')
    expect(warnings).not.toContain('name mismatch')
  })
})

describe.skipIf(RUNTIME.ready)('跳过说明', () => {
  it('没有那份真运行时,下半验不了(验的正是"真 DSH 认不认")', () => {
    console.log(`[装机形态·API Key 框] 跳过:${RUNTIME.why}`)
    expect(RUNTIME.ready).toBe(false)
  })
})
