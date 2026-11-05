// @vitest-environment node
/**
 * 装机形态测试:**在一台装着 0.1.7 的机器上,领到令牌之后事务官那一侧真的接上了中转**
 * (2026-09-26,卡 U1b)。
 *
 * ## 为什么非要这一份
 *
 * 0.1.7 把 `settings.yaml` 收进了 profile 的补丁层,于是「切到中转」这条路要跨三样东西:
 * 我们**判**该写哪儿、我们**写出来的那几行**、以及 DSH **认不认**那几行。
 * 三处各对一次,中间任何一处错位(把 `name:` 写错一个字、缩进差两格、模型名中转不认),
 * 单元测试全绿而真机上「设置里说切好了、事务官一开口还是 no API key」——
 * 那正是升级路上会被用户撞到的那个断点(U1 交接第六节)。
 *
 * 所以这一份按真形态跑:
 *   1. 临时 HOME 里摆一台"已经升到 0.1.7 的机器":`runtime` 指着真的 0.1.7 运行时、
 *      profile 用**真的登录台函数**(`profilePackageJson` / `renderProfilePatch`)建、
 *      `settings.yaml` 不在而 `.imported` 在(= DSH 已经把我们播的那份收走了);
 *   2. 跑**真的** `createModelService().update({ mode: 'relay' })` —— 真领令牌(假中转)、
 *      真经 `dshSettingsStore` 判该写哪儿、真落盘;
 *   3. **起真的 dsh** 把整棵 profile 合出来(`dsh web --dump-config`),断言它合出来的
 *      `agent-default-model` 与 `llm-pi-ai` 两行**就是我们写进去的那几个值**。
 *
 * ## 哪几样是假的 / 硬线
 *
 * - **中转是假的**(一个本地函数,不发网络请求),令牌是夹具里的假串,凭据不进日志。
 * - **不起服务、不占端口**:`--dump-config` 只把合成结果打到 stdout 就退出,不 listen、不 mount。
 * - **生产一个字节不碰**:`DSH_HOME` 是 mkdtemp 出来的;`runtime` 是**符号链接**指向那份
 *   已经装好的 0.1.7(514MB,不拷);`launchctl` 一次都不跑。
 *
 * ## 没有那份运行时时怎么办
 *
 * 0.1.7 的运行时不进 git(514MB)。所以没有它时这一份**整个跳过并说清原因** ——
 * 它验的是"真 DSH 认不认",拿假 dsh 验等于什么都没验。装法见
 * `docs/交接-0925-升级U1-运行时与安装器.md` 第一节;也可以用 `WB_DSH_RUNTIME` 指一份别的。
 *
 * 运行时在哪、怎么起它,收在 `tests/setup/realDshRuntime.ts`(2026-09-26 抽出来共用):
 * 生产切换之后 `runtime-next` 换名成了 `runtime`,原来只认 `runtime-next` 的写法会让这一份
 * 在切换过的机器上**整份跳过而没人知道** —— 现在两处都找。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createModelService } from '../src/server/modelService.ts'
import { profilePackageJson, renderProfilePatch } from '../src/server/setup/install.ts'
import { DSH_RELAY_TOKEN_ENV } from '../src/server/dshModelSettings.ts'
import { readPatchDefaultModel, readPatchRelayProvider } from '../src/server/dshProfilePatch.ts'
import { SEEDED_DEFAULT_MODEL, setupPaths } from '../src/server/setup/paths.ts'
// 运行时在哪、怎么起它、没有时怎么跳过:与 install-shape-profile-patch.test.ts 共用同一份。
import { READY, RUNTIME, WHY_SKIPPED, dumpConfig } from './setup/realDshRuntime.ts'

const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-model-')
const boxes: string[] = []
afterEach(() => {
  // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

/** 夹具里的假令牌。**真令牌一次都不出现在这份文件里,也不进日志。** */
const FAKE_TOKEN = 'wb_fake_token_for_tests'

/** 一个不发网络请求的假中转:发令牌、报用量。 */
const fakeRelay: typeof fetch = async (url) => {
  const href = String(url)
  if (href.endsWith('/register-device')) {
    return new Response(JSON.stringify({ token: FAKE_TOKEN }), { status: 201 })
  }
  if (href.endsWith('/usage')) {
    return new Response(JSON.stringify({
      day: '2026-09-26', used_tokens: 0, daily_token_limit: 50_000, remaining_tokens: 50_000,
    }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
}

/** 摆出「已经升到 0.1.7、DSH 已经把我们播的那份设置收走了」的那台机器。 */
function upgradedMachine() {
  const home = mkdtempSync(BOX_PREFIX)
  boxes.push(home)
  const paths = setupPaths({ home })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  // 用例跑的是开源缺省(构建不带中转,2026-10-21);这里测的是接了中转的那一档,地址写进 model.json。
  writeFileSync(`${paths.dshHome}/workbench/model.json`, JSON.stringify({ relay_url: 'https://relay.test' }))
  // 514MB 不拷:符号链接指向那份真的运行时(只读着用)。
  symlinkSync(RUNTIME, paths.runtimeDir)
  mkdirSync(paths.profileDir, { recursive: true })
  writeFileSync(paths.profilePackageJson, profilePackageJson())
  writeFileSync(paths.profilePatchYml, renderProfilePatch(undefined))
  // 升级已经发生过:原件留着(U1 那条"留着不删"),`settings.yaml` 不在。
  writeFileSync(paths.dshSettingsImported, 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n')
  return { home, paths }
}

describe.skipIf(!READY)('0.1.7 形态:领令牌 → 写进补丁层 → 真 dsh 读得到', () => {
  it('切到中转:令牌进 .env(0600)、两行补丁写进 profile、不去重建被收走的那个文件', async () => {
    const box = upgradedMachine()
    const service = createModelService({
      modelFile: `${box.paths.dshHome}/workbench/model.json`,
      credentialFile: `${box.paths.dshHome}/workbench/credentials.json`,
      dshHome: box.paths.dshHome,
      fetchImpl: fakeRelay,
    })

    const result = await service.update({ mode: 'relay' })
    expect(result.ok).toBe(true)
    expect(result.hints.join('\n')).toContain('事务官(DSH)那一侧也切好了')

    // ① 令牌落在 DSH 读得到的地方,权限 0600。
    const env = readFileSync(box.paths.dshEnvFile, 'utf8')
    expect(env).toContain(`${DSH_RELAY_TOKEN_ENV}=${FAKE_TOKEN}`)
    expect(statSync(box.paths.dshEnvFile).mode & 0o777).toBe(0o600)

    // ② 两行补丁在 profile 的补丁层里(不是在那个被收走的文件里)。
    const patch = readFileSync(box.paths.profilePatchYml, 'utf8')
    expect(readPatchDefaultModel(patch)).toEqual({ provider: 'workbench-relay', model: SEEDED_DEFAULT_MODEL })
    expect(readPatchRelayProvider(patch)).toMatchObject({ ok: true, found: true })
    expect(existsSync(box.paths.dshSettingsYaml)).toBe(false)

    // ③ 登录台补的那几行(插件、cookie 寿命、关掉的上游入口)一个都没被挤掉。
    expect(patch).toContain('ben-workbench')
    expect(patch).toContain('cookieMaxAgeDays: 3650')
    expect(patch).toContain('- id: ui-sidebar-terminal')
  })

  it('★ 起真的 dsh:它合出来的那两行就是我们写进去的值(写错一个字这里会红)', async () => {
    const box = upgradedMachine()
    const service = createModelService({
      modelFile: `${box.paths.dshHome}/workbench/model.json`,
      credentialFile: `${box.paths.dshHome}/workbench/credentials.json`,
      dshHome: box.paths.dshHome,
      fetchImpl: fakeRelay,
    })
    await service.update({ mode: 'relay' })

    const { config: dump, warnings } = dumpConfig(box.paths.dshHome, box.paths.runtimeDir)

    /**
     * ★ 先看 dsh 有没有**抱怨过我们那两行**。上游 `applyEntryPatches` 对"补丁指着一个不存在的 id"
     * 的处理是 `warn("patch: entry %C not found")` **然后跳过**,合成结果里一个字都看不出来 ——
     * 也就是「界面上一切正常、事务官那侧一个字没改」。这一条守门就是冲着那种沉默去的。
     * (顺手记一笔:这一份最初跑出来时,同一次 dump 里 dsh 就在抱怨 `client-connection` 不存在 ——
     * 登录台 `PROFILE_COOKIE_BLOCK` 的 id 写错了,上游两代都叫 `connection`。已修;登录台写的
     * **每一行**现在由 `install-shape-profile-patch.test.ts` 用同一招逐行守着。)
     */
    for (const id of ['agent-default-model', 'llm-pi-ai']) {
      expect(warnings).not.toContain(`entry "${id}" not found`)
      expect(warnings).not.toContain(`name mismatch for "${id}"`)
    }

    /**
     * 整块逐字断言。它一次证明三件事:
     * ① 那一行**没有被跳过** —— 上游 `applyEntryPatches` 见到 `name` 与目标不一致会整行跳过
     *    (只在日志里 warn),跳过之后这里合出来的就还是上游缺省的 `deepseek-official`;
     * ② config **是整份的** —— 补丁按 id 整体替换 config,少写 `model` 会让这一项起不来;
     * ③ 模型名是**中转认的那个**,不是上游缺省的 `deepseek-flash`。
     */
    expect(dump).toContain([
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: workbench-relay',
      `    model: ${SEEDED_DEFAULT_MODEL}`,
    ].join('\n'))

    // 我们那条路由:地址、凭据引用的**名字**(不是值)、以及能看图那几个的 input 真被读成了一个表。
    for (const line of [
      "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '      workbench-relay:',
      '        api: openai-completions',
      '        baseURL: https://relay.test/v1',
      `        apiKeyEnv: ${DSH_RELAY_TOKEN_ENV}`,
      `          - id: ${SEEDED_DEFAULT_MODEL}`,
      '            input:\n              - text\n              - image',
    ]) {
      expect(dump).toContain(line)
    }

    // 合的时候确实读了我们这份补丁(上游会在段头写清楚它被谁打过补丁)。
    expect(dump).toContain(`patched by ${box.paths.profilePatchYml}`)
    // 凭据只以"环境变量名"的形式出现,值一个字节都不在合成结果里。
    expect(dump).not.toContain(FAKE_TOKEN)
  })

  it('切回自己的 Key:真 dsh 合出来就回到上游那条路由,而我们那条路由留着', async () => {
    const box = upgradedMachine()
    const service = createModelService({
      modelFile: `${box.paths.dshHome}/workbench/model.json`,
      credentialFile: `${box.paths.dshHome}/workbench/credentials.json`,
      dshHome: box.paths.dshHome,
      fetchImpl: fakeRelay,
    })
    await service.update({ mode: 'relay' })
    await service.update({ mode: 'own' })

    const { config: dump } = dumpConfig(box.paths.dshHome, box.paths.runtimeDir)
    expect(dump).toContain([
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: deepseek-official',
      `    model: ${SEEDED_DEFAULT_MODEL}`,
    ].join('\n'))
    expect(dump).toContain('      workbench-relay:')
    // 令牌从 .env 里收走了,不留在磁盘上。
    expect(readFileSync(box.paths.dshEnvFile, 'utf8')).not.toContain(FAKE_TOKEN)
  })
})

describe.skipIf(READY)('跳过说明', () => {
  it('没有那份真运行时,这一份验不了(验的正是"真 DSH 认不认")', () => {
    console.log(`[装机形态·模型] 跳过:${WHY_SKIPPED}`)
    expect(READY).toBe(false)
  })
})
