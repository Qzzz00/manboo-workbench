/**
 * 哨兵的浏览器侧数据层(2026-09-09)。
 *
 * 只有「加一条」需要在这里发请求并把服务端的回答**如实转述**给界面——列表本身
 * 跟着 /state 一起来(事务官浮窗渲染),取消走 postSilently 那条失败静默的老路。
 *
 * 纪律:服务端拒了就把它那句原话摆出来(比如「只有 file/http/process/port;command
 * 类不做」),不换成自己编的措辞,也不谎称加上了。
 */
import type { SensorKind } from '../protocol.ts'

/** 四类传感器的中文名。**没有 command**——那一类是拍板不做(见 protocol.ts SENSOR_KINDS)。 */
export const SENSOR_LABEL: Record<SensorKind, string> = {
  file: '文件',
  http: '接口',
  process: '进程',
  port: '端口',
}

/** 每一类该往「目标」里填什么。填错了服务端也拦得住,但先说清楚省一次来回。 */
export const SENSOR_TARGET_HINT: Record<SensorKind, string> = {
  file: '绝对路径,如 /Users/example/.dsh/logs/web.stderr.log',
  http: '完整 URL,如 http://127.0.0.1:3080/',
  process: 'pgrep -f 的匹配串,如 ffmpeg',
  port: 'host:port 或光一个端口,如 127.0.0.1:3080',
}

export interface AddWatchInput {
  kind: SensorKind
  target: string
  note: string
  interval_sec?: number
  cooldown_sec?: number
  max_fires?: number
  expires_at?: string
}

export type AddWatchResult = { ok: true } | { ok: false, error: string }

export async function addWatch(
  baseUrl: string,
  input: AddWatchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AddWatchResult> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/sentinel/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }
  catch {
    return { ok: false, error: '连不上工作台服务,没加上' }
  }
  if (res.ok) return { ok: true }
  // 服务端那句人话优先;它没给话才退回状态码。
  try {
    const body = await res.json() as { error?: unknown }
    if (typeof body?.error === 'string' && body.error !== '') return { ok: false, error: body.error }
  }
  catch {
    // 回包不是 JSON,退回状态码。
  }
  return { ok: false, error: `加不上(HTTP ${res.status})` }
}
