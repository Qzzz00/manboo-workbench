export const DEFAULT_QA_PORTS = {
  dsh: 3193,
  workbench: 8993,
  module: 8994,
  butler: 8992,
  connector: 8996,
  textTurn: 8997,
  model: 19893,
  livekit: 19994,
  rtcTcp: 19995,
  rtcUdp: 19996,
} as const

export type QaPorts = { [Key in keyof typeof DEFAULT_QA_PORTS]: number }
export type InstanceServicePorts = Pick<QaPorts, 'dsh' | 'workbench' | 'module' | 'butler' | 'connector' | 'textTurn'>

export function instanceServicePorts(ports: QaPorts): InstanceServicePorts {
  return {
    dsh: ports.dsh,
    workbench: ports.workbench,
    module: ports.module,
    butler: ports.butler,
    connector: ports.connector,
    textTurn: ports.textTurn,
  }
}

/** One complete, isolated port group keeps every local URL and cleanup probe in sync. */
export function resolveQaPorts(raw: string | undefined): QaPorts {
  if (raw === undefined || raw.trim() === '') return { ...DEFAULT_QA_PORTS }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('COLLAB_A_ACCEPTANCE_PORTS must be valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('COLLAB_A_ACCEPTANCE_PORTS must be an object')
  }
  const config = value as Record<string, unknown>
  const expected = Object.keys(DEFAULT_QA_PORTS)
  const keys = Object.keys(config)
  const missing = expected.filter(key => !Object.hasOwn(config, key))
  const unknown = keys.filter(key => !Object.hasOwn(DEFAULT_QA_PORTS, key))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`COLLAB_A_ACCEPTANCE_PORTS must contain exactly the complete port group (missing: ${missing.join(',')}; unknown: ${unknown.join(',')})`)
  }
  const ports = Object.fromEntries(expected.map(key => {
    const port = config[key]
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`COLLAB_A_ACCEPTANCE_PORTS.${key} must be an integer from 1024 to 65535`)
    }
    return [key, port]
  })) as QaPorts
  if (new Set(Object.values(ports)).size !== expected.length) {
    throw new Error('COLLAB_A_ACCEPTANCE_PORTS must not reuse a port')
  }
  return ports
}
