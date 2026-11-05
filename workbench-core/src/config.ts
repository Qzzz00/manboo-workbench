/** 环境变量 → 启动参数。坏值直接抛,launchd 日志里看得见原因,不悄悄退回缺省。 */
export interface CoreConfig {
  port: number
  host: string
  upstream: string
  upstreamRemote?: string
  keepEvents?: number
}

type Env = Record<string, string | undefined>

function portOf(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 不是合法端口号:${raw}`)
  const port = Number(raw)
  if (port < 1 || port > 65535) throw new Error(`${name} 不是合法端口号:${raw}`)
  return port
}

function httpUrlOf(name: string, raw: string): string {
  let url: URL
  try { url = new URL(raw) }
  catch { throw new Error(`${name} 不是合法地址:${raw}`) }
  if (url.protocol !== 'http:') throw new Error(`${name} 只支持 http://(插件只在本机 / 局域网明文监听):${raw}`)
  return `${url.protocol}//${url.host}`
}

export function readConfig(env: Env): CoreConfig {
  const port = portOf('CORE_PORT', env.CORE_PORT ?? '8791')
  const host = env.CORE_HOST === undefined || env.CORE_HOST === '' ? '127.0.0.1' : env.CORE_HOST
  const upstream = httpUrlOf('CORE_UPSTREAM', env.CORE_UPSTREAM ?? 'http://127.0.0.1:8790')
  const config: CoreConfig = { port, host, upstream }
  const upstreamUrl = new URL(upstream)
  if (Number(upstreamUrl.port || 80) === port && ['127.0.0.1', 'localhost', '[::1]'].includes(upstreamUrl.hostname)) {
    throw new Error(`CORE_PORT 与 CORE_UPSTREAM 是同一个端口(${port}):座机服务会把请求转给自己。插件该挪到别的端口(如 WORKBENCH_PORT=8790)`)
  }
  if (env.CORE_UPSTREAM_REMOTE !== undefined && env.CORE_UPSTREAM_REMOTE !== '') {
    if (env.CORE_UPSTREAM_REMOTE === 'interface') config.upstreamRemote = 'interface'
    else {
      const remote = httpUrlOf('CORE_UPSTREAM_REMOTE', env.CORE_UPSTREAM_REMOTE)
      const hostname = new URL(remote).hostname
      if (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')) {
        throw new Error(`CORE_UPSTREAM_REMOTE 不能是回环地址(${remote}):插件会把转过去的远端请求当本机、不再认设备令牌。用 interface`)
      }
      config.upstreamRemote = remote
    }
  }
  if (env.CORE_KEEP_EVENTS !== undefined && env.CORE_KEEP_EVENTS !== '') {
    const raw = env.CORE_KEEP_EVENTS
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`CORE_KEEP_EVENTS 要是正整数:${raw}`)
    config.keepEvents = Number(raw)
  }
  return config
}
