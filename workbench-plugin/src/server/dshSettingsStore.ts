/**
 * 一处「DSH 的设置在哪」(2026-09-26,卡 U1b)。
 *
 * ## 为什么要有这一处
 *
 * 0.1.7 **把 `settings.yaml` 收走了**:每次启动只要看见它,就先改名成 `settings.yaml.imported`,
 * 再把里面每个顶层段写进当前 profile 的 `cordis.patch.yml`(上游
 * `packages/settings/settings/src/index.ts` 的 `importLegacyDocument()`)。而我们有三处在读写它:
 *
 * - 设置 → 模型的「切到中转 / 切回自己的 Key」(`modelService.ts` 的 `applyToDsh`);
 * - 登录领到令牌之后把那一段写下去(同一条 `applyToDsh`,由 `autoSetup` 走);
 * - 开机时把老机器上我们那一段补齐(`index.ts`)。
 *
 * 升级之后这三处都会断(「里面没有 agent-default-model 这一段」),而**用户机器上两代运行时
 * 都可能在跑** —— 热更新是「装 runtime-next → 换名 → 重启」分步做的,还有回滚这条路。
 * 所以三处一律经这一份:**判据在一个地方,路径在一个地方**。
 *
 * ## 判据(`dshSettingsPlaceOf`,纯函数)
 *
 * 1. **`settings.yaml` 还在 → 就写它**。这一条在两代上都对:0.1.2 本来就读它;0.1.7 下一次启动
 *    会把它整段收进补丁层、并**盖掉补丁层里的同名段**,所以此刻写补丁层等于写了一个会被盖掉的
 *    地方。升级那一刻(换完运行时、还没重启)走的就是这一支 —— 我们写的东西由那次导入带过去,
 *    不重复写、也不会跟导入打架。
 * 2. 文件没了、**装着的运行时 ≥ 0.1.7** → 补丁层(升级已经完成的机器)。
 * 3. 文件没了、装着的还是 0.1.7 以前的 → 仍然是那个文件(回滚过的机器;不在就如实说没跟着切)。
 * 4. 版本读不到:有 `.imported` 就说明"被收走过一次" → 补丁层;连痕迹都没有 → 按我们锁着要装的
 *    那一版(`LOCKED_DSH_VERSION`)。
 *
 * 版本只比前三段,预发布后缀不参与 —— 收走 `settings.yaml` 这件事是整条 0.1.7 线的行为。
 *
 * ## 纪律
 *
 * - **写前备份**:改他的文件之前先 `cp` 一份 `<原名>.bak-workbench-<时刻>`(profile 目录里只有
 *   `cordis.patch.yml` 这个名字会被 DSH 读,备份不会被当成第二份补丁 —— 上游
 *   `loadProfileDirectory` 是按**确切文件名**取的,不扫目录)。
 * - **没改就不备份**:开机那一下每次都跑,堆备份等于慢慢把 profile 目录塞满。
 * - **写坏一个字符 DSH 整个起不来**,所以认不得的文档一律不写(`dshProfilePatch.ts` 里那三道)。
 * - **给人看的话里不出现文件名**:用户不知道 `cordis.patch.yml` 是什么,也不该知道。
 */
import { resolve } from 'node:path'
import type { LiveConfigRequest, LiveConfigRollback } from './dshLiveConfig.ts'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import {
  readAgentDefaultModel, settingsForOwnEndpoint, settingsForOwnKey, settingsForOwnModel, settingsForRelay,
  upgradeManagedRelayBlock,
  type DshSettingsEdit,
} from './dshModelSettings.ts'
import {
  PATCH_DEFAULT_MODEL_ID, PATCH_MODEL_DEFAULTS, PATCH_RELAY_PLUGIN_ID,
  parseProfilePatch, patchForOwnEndpoint, patchForOwnKey, patchForOwnModel, patchForRelay, patchUpgradeManagedRelay,
  readPatchDefaultModel,
} from './dshProfilePatch.ts'
import { LOCKED_DSH_VERSION, setupPaths } from './setup/paths.ts'

/** 从哪一版起 `settings.yaml` 被收进 profile 的补丁层(上游 `importLegacyDocument` 进来的那一版)。 */
export const DSH_PATCH_SETTINGS_SINCE = '0.1.7'

export type DshSettingsGeneration = 'settings-file' | 'profile-patch'

export interface DshSettingsPlaceInput {
  /** 这台机器上**装着**的 dsh 版本。读不到传 undefined。 */
  runtimeVersion?: string
  settingsFileExists: boolean
  importedExists: boolean
}

export interface DshSettingsPlace {
  generation: DshSettingsGeneration
  /** 判据的人话。**进日志,不给用户看**(里面有文件名)。 */
  why: string
}

/** `a >= b`,只比前三段数字;比不出来(哪一边不像版本号)回 undefined。 */
function atLeast(version: string | undefined, floor: string): boolean | undefined {
  if (version === undefined) return undefined
  const parse = (text: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim())
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const left = parse(version)
  const right = parse(floor)
  if (left === undefined || right === undefined) return undefined
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] as number
    const b = right[i] as number
    if (a !== b) return a > b
  }
  return true
}

/** 判据(纯函数)。四条理由见文件头。 */
export function dshSettingsPlaceOf(input: DshSettingsPlaceInput): DshSettingsPlace {
  if (input.settingsFileExists) {
    return {
      generation: 'settings-file',
      why: 'settings.yaml 还在:0.1.2 直接读它,0.1.7 下一次启动会把它整段收进补丁层并盖掉同名段',
    }
  }
  const installed = atLeast(input.runtimeVersion, DSH_PATCH_SETTINGS_SINCE)
  if (installed === true) {
    return { generation: 'profile-patch', why: `装着的运行时是 ${input.runtimeVersion ?? '?'},settings.yaml 已经被它收走` }
  }
  if (installed === false) {
    return { generation: 'settings-file', why: `装着的运行时是 ${input.runtimeVersion ?? '?'},这一代还认 settings.yaml` }
  }
  if (input.importedExists) {
    return { generation: 'profile-patch', why: '读不到运行时版本,但有 settings.yaml.imported —— 被收走过一次' }
  }
  return atLeast(LOCKED_DSH_VERSION, DSH_PATCH_SETTINGS_SINCE) === true
    ? { generation: 'profile-patch', why: `读不到运行时版本、也没有痕迹,按锁定版本 ${LOCKED_DSH_VERSION} 走补丁层` }
    : { generation: 'settings-file', why: `读不到运行时版本、也没有痕迹,按锁定版本 ${LOCKED_DSH_VERSION} 走 settings.yaml` }
}

export type DshStoreWrite =
  | { ok: true, changed: boolean, generation: DshSettingsGeneration, rollback?: LiveConfigRollback }
  | { ok: false, error: string, generation?: DshSettingsGeneration }

export interface DshSettingsStoreFiles {
  settings: string
  imported: string
  patch: string
  homePatch: string
  runtimePackageJson: string
}

export interface DshSettingsStore {
  /** 这四条路径。**只由 setup/paths.ts 算**,守门用例钉着两边一致。 */
  files: () => DshSettingsStoreFiles
  place: () => Promise<DshSettingsPlace>
  /** 事务官那一侧现在用哪家哪个模型。取不到回 undefined(不编一个)。 */
  readDefaultModel: () => Promise<{ provider?: string, model?: string } | undefined>
  applyRelay: (options: { baseUrl: string, model?: string, extraModels?: readonly string[] }) => Promise<DshStoreWrite>
  /**
   * 切回「自己的 Key」。`own` 给了三种形态(2026-10-23 卡「事务官换Key」+退修):
   * - `{ baseUrl, model }`:自己接的端点 → 写 workbench-own 那条路由;
   * - `{ model }`(没有 baseUrl):地址保持官方、只换模型名 → 不换路由不碰 Key,只写 model 行;
   * - 缺席:照旧 = 指回 deepseek-official(或切走之前那一个),model 行不动。
   */
  applyOwnKey: (
    previousProvider?: string,
    own?: { baseUrl: string, model: string } | { baseUrl?: undefined, model: string } | { baseUrl?: undefined, model?: undefined },
  ) => Promise<DshStoreWrite>
  upgradeManagedRelay: () => Promise<DshStoreWrite>
}

export interface DshSettingsStoreOptions {
  /** `~/.dsh`(灰度实例与测试传别的)。 */
  dshHome: string
  /** 哪个 profile。缺省 `web` —— `dsh web` 起的就是它。 */
  profileName?: string
  now?: () => Date
  /** 判据与落笔进日志(**里面有文件名,不给用户看**)。 */
  log?: (message: string) => void
  /**
   * 宿主注入的 live reconciler (2026-10-23,卡「换Key运行时」)。
   * 当 DSH 活在 0.1.7 运行时里且拥有 configEditor 时:
   * 由此接口负责持久化并 await DSH loader 完成 reconciliation,
   * 使得后续 selectModel / catalog 立即读到新 model。
   */
  liveReconcile?: ((request: LiveConfigRequest) => Promise<void | LiveConfigRollback>) | undefined
  /** 可选:查询当前运行中 configEditor 的 documentPath(用于观测对比与断言)。 */
  liveDocPath?: (() => string | undefined) | undefined
}

/** 界面上说的那几句。一律**不出现文件名**。 */
const NO_SETTINGS_FILE = '事务官(DSH)那一侧还没有它自己的设置,所以这次没跟着切;工作台与手机通话已经切好了。'
const NO_PROFILE = '事务官(DSH)还没装好自己的运行环境,所以这次没跟着切;工作台与手机通话已经切好了。'
const HOME_PATCH_WINS = '这台电脑上有一份手工加的事务官配置压在上面,工作台写了也不会生效,所以没有动它;要让它也走工作台的模型服务,得请人工合一次。'
const WRITE_FAILED = '没能把这一项写给事务官(DSH),它那一侧还是原来的样子。'

export function createDshSettingsStore(options: DshSettingsStoreOptions): DshSettingsStore {
  // 路径全部由登录台那一份算(2026-09-04 事故纪律:不在第二处拼 `~/.dsh` 下面的路径)。
  const paths = setupPaths({ home: options.dshHome, dshHome: options.dshHome })
  const profileName = options.profileName ?? 'web'
  const profileDir = `${paths.dshHome}/profiles/${profileName}`
  const files: DshSettingsStoreFiles = {
    settings: paths.dshSettingsYaml,
    imported: paths.dshSettingsImported,
    patch: `${profileDir}/cordis.patch.yml`,
    homePatch: `${paths.dshHome}/cordis.patch.yml`,
    runtimePackageJson: paths.runtimeDshPackageJson,
  }
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})

  const readTextOr = async (path: string): Promise<string | undefined> => {
    try { return await readFile(path, 'utf8') }
    catch { return undefined }
  }
  const exists = async (path: string): Promise<boolean> => {
    try { await stat(path); return true }
    catch { return false }
  }

  async function runtimeVersion(): Promise<string | undefined> {
    const text = await readTextOr(files.runtimePackageJson)
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : undefined
    }
    catch { return undefined }
  }

  async function place(): Promise<DshSettingsPlace> {
    const version = await runtimeVersion()
    const got = dshSettingsPlaceOf({
      ...(version === undefined ? {} : { runtimeVersion: version }),
      settingsFileExists: await exists(files.settings),
      importedExists: await exists(files.imported),
    })
    log(`DSH 设置读写:${got.generation}(${got.why})`)
    return got
  }

  /**
   * 家那一层的补丁(`$DSH_HOME/cordis.patch.yml`)**排在 profile 那一层后面**
   * (上游 `readProfilePatches`:bundle 各层 → profile 的 → 家里这一份 → 命令行 overlay),
   * 所以它按 id 压着我们要改的那一行。真有这种机器时,写进 profile 那一层**不会生效** ——
   * 那就不写,如实说一句,而不是写完骗人说切好了。
   */
  async function homePatchClaimsOurRows(): Promise<boolean> {
    const text = await readTextOr(files.homePatch)
    if (text === undefined) return false
    const doc = parseProfilePatch(text)
    if (!doc.ok) {
      // 认不出来就按最保守的算(粗判一下有没有提到那两个 id)。
      return text.includes(PATCH_DEFAULT_MODEL_ID) || text.includes(PATCH_RELAY_PLUGIN_ID)
    }
    return doc.rows.some(row => !row.insert && (row.id === PATCH_DEFAULT_MODEL_ID || row.id === PATCH_RELAY_PLUGIN_ID))
  }

  /** 备份 + 落盘。写不动就当没写过(绝不抛给上层)。 */
  async function commit(file: string, text: string, hadFile: boolean): Promise<DshStoreWrite | undefined> {
    try {
      if (hadFile) {
        const stamp = now().toISOString().replace(/[:.]/g, '')
        try { await copyFile(file, `${file}.bak-workbench-${stamp}`) }
        catch { /* 备份不上也照改 —— 原文件在 git 之外,备份只是多一道 */ }
      }
      else {
        await mkdir(file.replace(/\/[^/]+$/, ''), { recursive: true })
      }
      await writeFile(file, text, 'utf8')
      log(`已写:${file}`)
      return undefined
    }
    catch {
      return { ok: false, error: WRITE_FAILED }
    }
  }

  /** 一次「读 → 改 → 写」。`edit` 是两代各自那一套纯函数。 */
  async function edit(
    kind: 'relay' | 'own' | 'upgrade',
    apply: (generation: DshSettingsGeneration, text: string) => DshSettingsEdit,
  ): Promise<DshStoreWrite> {
    const at = await place()
    const generation = at.generation

    if (generation === 'settings-file') {
      if (options.liveReconcile !== undefined) return { ok: false, error: '当前事务官运行环境不支持在线应用旧版设置，请完成运行环境重启后重试。', generation }
      const text = await readTextOr(files.settings)
      if (text === undefined) {
        // 升级把它收走之后又回滚到 0.1.2 的机器会走到这儿。不新建 —— 新建一份等于替他做选择,
        // 而且下次启动(要是又换回 0.1.7)会把这份新的收进补丁层、盖掉他真正选过的那一套。
        return kind === 'upgrade'
          ? { ok: true, changed: false, generation }
          : { ok: false, error: NO_SETTINGS_FILE, generation }
      }
      const out = apply(generation, text)
      if (!out.ok) return { ok: false, error: out.error, generation }
      if (!out.changed) return { ok: true, changed: false, generation }
      const failed = await commit(files.settings, out.text, true)
      return failed ?? { ok: true, changed: true, generation }
    }

    if (!await exists(profileDir)) {
      return kind === 'upgrade'
        ? { ok: true, changed: false, generation }
        : { ok: false, error: NO_PROFILE, generation }
    }
    if (await homePatchClaimsOurRows()) {
      return kind === 'upgrade'
        ? { ok: true, changed: false, generation }
        : { ok: false, error: HOME_PATCH_WINS, generation }
    }
    const existing = await readTextOr(files.patch)
    // 上游建 profile 时会写一份只有注释 + `[]` 的模板;还没有这个文件时按空文档算。
    const out = apply(generation, existing ?? '')
    if (options.liveReconcile !== undefined) {
      if (options.liveDocPath?.() !== undefined && resolve(options.liveDocPath() as string) !== resolve(files.patch)) {
        return { ok: false, error: '事务官运行中的配置位置与本次设置不一致，未完成模型切换。', generation }
      }
      // 不先写文件：ConfigEditor 必须读到旧配置，才能承担校验、持久化、应用与回滚。
      // 同值重试也必须 await，盘上相等不能证明运行时已经应用。
      try {
        const rollback = await options.liveReconcile({ patchPath: files.patch, text: out.ok ? out.text : existing ?? '', sourceText: existing ?? '', apply: text => apply(generation, text) })
        log(`[model] DshStoreWrite: generation=${generation}, changed=${out.ok ? out.changed : true}, sameDocPath=true`)
        return { ok: true, changed: out.ok ? out.changed : true, generation, ...(rollback === undefined ? {} : { rollback }) }
      }
      catch {
        log('[model] live 配置应用失败')
        return { ok: false, error: '事务官配置热加载失败，未完成模型切换。', generation }
      }
    }
    if (!out.ok) return { ok: false, error: out.error, generation }
    if (!out.changed) return { ok: true, changed: false, generation }
    const failed = await commit(files.patch, out.text, existing !== undefined)
    return failed ?? { ok: true, changed: true, generation }
  }

  return {
    files: () => ({ ...files }),
    place,

    async readDefaultModel() {
      const at = await place()
      if (at.generation === 'settings-file') {
        const text = await readTextOr(files.settings)
        return text === undefined ? undefined : readAgentDefaultModel(text)
      }
      const text = await readTextOr(files.patch)
      if (text === undefined) return { ...PATCH_MODEL_DEFAULTS.upstream }
      if (!parseProfilePatch(text).ok) return undefined
      // 补丁按 id **整体替换** config,所以"补丁里没有那一行"就等于"跑的是上游缺省那一组"。
      return { ...PATCH_MODEL_DEFAULTS.upstream, ...readPatchDefaultModel(text) }
    },

    applyRelay: relay => edit('relay', (generation, text) => {
      const restored = relay.model === undefined ? { ok: true as const, text, changed: false }
        : generation === 'settings-file' ? settingsForOwnModel(text, undefined, relay.model)
        : patchForOwnModel(text, { ...PATCH_MODEL_DEFAULTS, model: relay.model })
      if (!restored.ok) return restored
      const out = generation === 'settings-file' ? settingsForRelay(restored.text, relay)
        : patchForRelay(restored.text, { ...relay, ...PATCH_MODEL_DEFAULTS })
      return out.ok ? { ...out, changed: out.text !== text } : out
    }),

    applyOwnKey: (previousProvider, own) => edit('own', (generation, text) => {
      if (own !== undefined && own.baseUrl !== undefined) {
        return generation === 'settings-file'
          ? settingsForOwnEndpoint(text, { baseUrl: own.baseUrl, model: own.model })
          : patchForOwnEndpoint(text, { baseUrl: own.baseUrl, model: own.model, ...PATCH_MODEL_DEFAULTS })
      }
      if (own !== undefined && own.model !== undefined) {
        return generation === 'settings-file'
          ? settingsForOwnModel(text, previousProvider, own.model)
          : patchForOwnModel(text, {
              ...PATCH_MODEL_DEFAULTS,
              model: own.model,
              ...(previousProvider === undefined ? {} : { previousProvider }),
            })
      }
      return generation === 'settings-file'
        ? settingsForOwnKey(text, previousProvider)
        : patchForOwnKey(text, {
            ...PATCH_MODEL_DEFAULTS,
            ...(previousProvider === undefined ? {} : { previousProvider }),
          })
    }),

    upgradeManagedRelay: () => edit('upgrade', (generation, text) => generation === 'settings-file'
      ? upgradeManagedRelayBlock(text)
      : patchUpgradeManagedRelay(text)),
  }
}
