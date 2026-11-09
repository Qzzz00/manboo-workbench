/**
 * 「多人协作区」总开关(2026-11-09,开源版默认关掉这一整块)。
 *
 * 这一块原本横穿四端:8791 的 /collab/* 路由与后台长轮询、桌面插件的协作区面板、
 * 手机 App 的协作区下级页、relay 中转的 15 张表与 /v1/* 路由。它不是一个能整目录删掉的插件,
 * 所以用**一个总开关**在所有入口同时收口,而不是到处判空。
 *
 * 读法(优先级从高到低):
 *   1. 环境变量 `WORKBENCH_COLLAB_ENABLED` = 1/true/on → 开;= 0/false/off → 关。
 *   2. `~/.dsh/workbench/app.json` 的 `collab_enabled`(只认真正的布尔)。
 *   3. **都没配 = 关**。这一条是故意的:开源版开箱就不带多人协作,要开必须明确写下来。
 *
 * 启动时读一次(与 `endpoints.ts` / `lan_access` 同一条规矩):改了 app.json 或环境变量要重启工作台。
 * 服务端算出来的这一格会随 `/state.collab_enabled` 下发给桌面与手机,两端不再各自猜。
 *
 * relay 是独立进程、不读 app.json,它读**同一个环境变量**(`relay/server/collabFeature.cjs`,
 * 与这里的取值规则逐字一致)。完整开启本功能时,两边都要设 `WORKBENCH_COLLAB_ENABLED=1`。
 */
export const COLLAB_ENV_KEY = 'WORKBENCH_COLLAB_ENABLED'

const ON = new Set(['1', 'true', 'on', 'yes'])
const OFF = new Set(['0', 'false', 'off', 'no'])

export function collabFeatureOf(input: { env?: string | undefined, saved?: boolean | undefined } = {}): boolean {
  const raw = input.env?.trim().toLowerCase()
  if (raw !== undefined && raw !== '' && ON.has(raw)) return true
  if (raw !== undefined && raw !== '' && OFF.has(raw)) return false
  // 缺席 / 写坏 / 写成字符串 "true" 一律按「没配」处理,而没配 = 关。
  return input.saved === true
}
