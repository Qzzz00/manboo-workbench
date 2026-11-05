/**
 * 工作台往外连的几条地址(2026-10-21,开源整理):`~/.dsh/workbench/endpoints.json`。
 *
 * 默认值就是之前写死在各处的那几个,**什么都不配行为一字不变**。开源用户自建服务、或者干脆不想连,
 * 在这份文件里改(环境变量压过文件,给测试与灰度用;DSH 进程的环境不好改,日常改文件):
 *
 * ```json
 * { "aiboo_url": "http://…", "aihot_url": "https://…", "update_manifest_url": "https://…/latest.json" }
 * ```
 *
 * - `aiboo_url`(`WORKBENCH_AIBOO_URL`):Aiboo 云。今晨快报取 `<它>/api/dj/commute/today`;AiDJ 电台的默认地址也是它
 *   (`aidj-config.json` 里另填了 `base_url` 的以那一份为准)。本仓库没有这台服务的后端源码。
 * - `aihot_url`(`WORKBENCH_AIHOT_URL`):早报底稿 AIHOT 日报。
 * - `update_manifest_url`(`WORKBENCH_UPDATE_URL`,沿用原来那个变量):热更新清单。缺省是构建带的那一个,
 *   开源构建没带(2026-10-21,零服务器是缺省)= 不查更新。
 * - `viz_cdn_url`(`WORKBENCH_VIZ_CDN_URL`):「图谱」格 graph.html 的绘图组件 vis-network 的下载地址
 *   (钉死版本,装/建时下一次、长期使用)。写 `"off"` = 不下(图谱页装不起来时照实说)。
 * - `uv_bootstrap_url`(`WORKBENCH_UV_BOOTSTRAP_URL`):uv 缺席时的官方安装脚本下载地址。
 *   默认 `https://astral.sh/uv/install.sh`。写 `"off"` = 不自动下载安装脚本(未装 uv 时直接报错)。
 *
 * 任一项写 `"off"` = 那一条不连(快报不取、早报不拉 AIHOT、不查更新、不下绘图组件、不下 uv 脚本)。认不出的值(不是 http/https)退回默认。
 * 中转不在这里:它一直在 `model.json` 的 `relay_url`;房间地址在 `channel.json`。全表见
 * `docs/开源-对外连接清单-2026-10-21.md`。
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_AIDJ_BASE } from './aidj.ts'
import { AIHOT_BASE_URL } from './feedAihot.ts'
import { NO_RELAY_NOTE } from './modelConfig.ts'
import { DEFAULT_MANIFEST_URL } from './update/service.ts'

/** 「图谱」格绘图组件的默认下载地址(vis-network,版本钉死;sha256 钉在 server/graphify.ts)。 */
export const DEFAULT_VIZ_CDN_URL = 'https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js'
/** uv 缺席时的官方安装脚本下载地址。 */
export const DEFAULT_UV_BOOTSTRAP_URL = 'https://astral.sh/uv/install.sh'

export interface Endpoints {
  /** undefined = 关了。 */
  aiboo_url: string | undefined
  aihot_url: string | undefined
  update_manifest_url: string | undefined
  /** 「图谱」格的 vis-network 下载地址;undefined = 不下。 */
  viz_cdn_url: string | undefined
  /** uv 官方安装脚本下载地址;undefined = 不下。 */
  uv_bootstrap_url: string | undefined
}

export const DEFAULT_ENDPOINTS: Readonly<Endpoints> = {
  aiboo_url: DEFAULT_AIDJ_BASE,
  aihot_url: AIHOT_BASE_URL,
  // 构建没带更新地址(开源构建)= 关:不查更新,「检查更新」那里说 UPDATE_NOT_CONFIGURED。
  update_manifest_url: DEFAULT_MANIFEST_URL === '' ? undefined : DEFAULT_MANIFEST_URL,
  viz_cdn_url: DEFAULT_VIZ_CDN_URL,
  uv_bootstrap_url: DEFAULT_UV_BOOTSTRAP_URL,
}

/** 不查更新时「检查更新」那一句(开源构建没带更新地址,或 endpoints.json 里写了 off)。 */
export const UPDATE_NOT_CONFIGURED = `${NO_RELAY_NOTE},不自动查更新;新版本到项目主页下载。自己有更新地址的,写进 endpoints.json 的 update_manifest_url。`

const ENV_OF: Record<keyof Endpoints, string> = {
  aiboo_url: 'WORKBENCH_AIBOO_URL',
  aihot_url: 'WORKBENCH_AIHOT_URL',
  update_manifest_url: 'WORKBENCH_UPDATE_URL',
  viz_cdn_url: 'WORKBENCH_VIZ_CDN_URL',
  uv_bootstrap_url: 'WORKBENCH_UV_BOOTSTRAP_URL',
}

export function defaultEndpointsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/endpoints.json`
}

const OFF = Symbol('off')

/** 一个值 → 地址 / 关 / 认不出(undefined,往下一层找)。 */
function pick(value: unknown): string | typeof OFF | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.toLowerCase() === 'off') return OFF
  const url = trimmed.replace(/\/+$/, '')
  // 只认 http/https:一行配置不该能把请求打到 file:// 或别的协议上去(同 aidj.ts parseAidjConfig)。
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url) ? url : undefined
}

/** 同步读:启动时读一次(改了要重启 DSH,与 channel.json 一样)。坏文件当没有,不抛。 */
export function loadEndpoints(home: string, env: Record<string, string | undefined> = process.env): Endpoints {
  let file: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(defaultEndpointsFile(home), 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) file = parsed as Record<string, unknown>
  }
  catch { /* 没有或写坏了 = 全用默认 */ }
  const out = { ...DEFAULT_ENDPOINTS }
  for (const key of Object.keys(ENV_OF) as Array<keyof Endpoints>) {
    const chosen = pick(env[ENV_OF[key]]) ?? pick(file[key])
    if (chosen === OFF) out[key] = undefined
    else if (chosen !== undefined) out[key] = chosen
  }
  return out
}
