/**
 * 模型从哪儿来(2026-09-17,Ben:「配置 API 是后面的步骤,要做成可选的:可以默认使用
 * 我们提供的服务,也可以自己去 DeepSeek 生成 API Key 再填入,不要变成阻塞项」)。
 *
 * 这里**只读一个字段**:`~/.dsh/workbench/model.json` 的 `mode`。额度面板的 DeepSeek 那一格
 * 据此换一套说法 —— `relay` 时那格里的余额不是 Ben 的余额(用的是工作台自家的中转),
 * 照旧显示「¥ 账号余额」等于说了一句假话。
 *
 * ⚠️ 合并提醒:`model.json` 这个文件归 `feat/model-relay` 那张卡所有(中转地址、计量口径、
 * 设置里那一节都是它的)。这里刻意**不写、不建、不校验**这个文件,只在它已经存在时读一眼;
 * 文件不存在 / 读坏了 / mode 认不出 → 一律回 `undefined`,前台按今天的逻辑照旧渲染。
 */

import { DEFAULT_RELAY_URL, parseModelConfig, relayConfigured } from './modelConfig.ts'

export type ModelMode = 'relay' | 'own'

// 同一个文件的路径以 modelConfig.ts 为准(两张并行卡各写了一份,合并时归一)。
export { defaultModelFile } from './modelConfig.ts'

/**
 * 读 mode。**认不出的值不猜**:写着 `mode: "auto"` 的文件回 `undefined`(缺席),
 * 而不是替它选一个 —— 猜错的那一半会让界面上的钱数指向错的账户。
 */
export function parseModelMode(text: string | undefined): ModelMode | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const mode = (parsed as { mode?: unknown }).mode
  return mode === 'relay' || mode === 'own' ? mode : undefined
}

export interface ModelModeReaderDeps {
  readFile: (path: string) => Promise<string | undefined>
  file: string
  now: () => number
  /** 重读的最小间隔。默认 60 秒 —— 跟客户端扫描同一条节流规矩。 */
  refreshMs?: number
}

export interface ModelModeReader {
  /** 上一次读到的 mode。没读过 / 文件不在 → undefined。 */
  view: () => ModelMode | undefined
  /**
   * 这台接没接中转(2026-10-21,零服务器档;`/state.relay_configured`)。model.json 里的地址,没有就是构建带的那一个;
   * 没读过时按构建缺省说。缺席(老的假 reader)= 不报。
   */
  relayConfigured?: () => boolean
  /** 节流过的后台重读。composeState 每拍调一次。 */
  pump: () => void
  read: () => Promise<ModelMode | undefined>
}

/**
 * 跟 clientScan 同一套「请求驱动 + 内部限频」:/state 一秒一拍,不能一秒读一次盘。
 * 只是这份读的是一个几十字节的小文件,节流主要是为了不在热路径上放同步 I/O 的坏习惯。
 */
export function createModelModeReader(deps: ModelModeReaderDeps): ModelModeReader {
  const refreshMs = deps.refreshMs ?? 60_000
  let mode: ModelMode | undefined
  let relay = DEFAULT_RELAY_URL !== ''
  let readAt: number | undefined
  let reading = false

  async function read(): Promise<ModelMode | undefined> {
    const text = await deps.readFile(deps.file)
    mode = parseModelMode(text)
    relay = relayConfigured(parseModelConfig(text, () => ''))
    readAt = deps.now()
    return mode
  }

  return {
    view: () => mode,
    relayConfigured: () => relay,
    pump: () => {
      if (reading) return
      if (readAt !== undefined && deps.now() - readAt < refreshMs) return
      reading = true
      void read().catch(() => {}).finally(() => { reading = false })
    },
    read,
  }
}
