import { isAbsolute, join, resolve, sep } from 'node:path'
/** Normal-provider phone QA ports. Overrides must describe one complete isolated instance. */
export const DEFAULT_PHONE_ACCEPTANCE_PORTS = Object.freeze({ dsh: 3093, workbench: 8893, module: 8894, butler: 8892, connector: 8896, textTurn: 8897 })
export type PhoneAcceptancePorts = Record<keyof typeof DEFAULT_PHONE_ACCEPTANCE_PORTS, number>
export function resolvePhoneAcceptancePorts(raw?: string): PhoneAcceptancePorts {
  if (raw === undefined || raw === '') return { ...DEFAULT_PHONE_ACCEPTANCE_PORTS }
  const value = JSON.parse(raw) as Record<string, unknown>
  const names = Object.keys(DEFAULT_PHONE_ACCEPTANCE_PORTS)
  if (value === null || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !(name in value))) throw new Error('验收端口必须是完整端口组')
  for (const name of names) if (!Number.isInteger(value[name]) || Number(value[name]) < 1024 || Number(value[name]) > 65535) throw new Error(`非法端口:${name}`)
  if (new Set(Object.values(value)).size !== names.length) throw new Error('验收端口重复')
  return value as PhoneAcceptancePorts
}

/** Attachment is opt-in and must match the saved QA instance, before any service starts. */
export function assertPhoneAcceptanceAttachment(raw: unknown, root: string, ports: PhoneAcceptancePorts): void {
  const saved = raw as { root?: unknown, base?: unknown, ports?: Partial<PhoneAcceptancePorts> } | null
  if (saved === null || saved.root !== root) throw new Error('attached QA profile root mismatch')
  if (saved.base !== `http://127.0.0.1:${ports.workbench}` || saved.ports === undefined || Object.entries(ports).some(([name, port]) => saved.ports?.[name as keyof PhoneAcceptancePorts] !== port)) throw new Error('attached QA port group mismatch')
}

/** A clean producer checkout may be referenced read-only for dependency QA; default stays local. */
export function resolvePhoneAcceptanceWorkerDir(repo: string, workerDir?: string): string {
  if (workerDir === undefined) return join(repo, 'channel-worker')
  if (!isAbsolute(workerDir)) throw new Error('worker source reference must be absolute')
  return workerDir
}

/** The producer's resend QA stays off unless this isolated text-turn run opts in. */
export function phoneRoomReplayEnvironment(root: string, textTurn: boolean, enabled?: string): Record<string, string> {
  if (enabled !== '1') return {}
  if (!textTurn) throw new Error('room replay QA requires text-turn')
  if (!isAbsolute(root)) throw new Error('room replay QA requires an absolute capture root')
  return { WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '1', WB_FIXTURE_CAPTURE_ROOT: root, NODE_OPTIONS: `--import=${new URL('./roomReplayQaEnvironment.mts', import.meta.url).href}` }
}

/** A second route must not overwrite the LAN QA listener token before its bind fails. */
export function isolateRoomReplayQaTextTurn(env: Record<string, string | undefined>): void {
  const root = env.WB_FIXTURE_CAPTURE_ROOT;
  const home = env.HOME;
  if (env.WORKBENCH_CHANNEL_ROOM_REPLAY_QA !== '1' || env.WORKBENCH_CHANNEL_WORKER_ROUTE !== 'relay' || !root || !home || !isAbsolute(root) || !resolve(home).startsWith(resolve(root) + sep)) return;
  env.WORKBENCH_CHANNEL_TEXT_TURN = '0';
}
