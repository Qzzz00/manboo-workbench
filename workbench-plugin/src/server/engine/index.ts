/**
 * 送话引擎的门面(2026-10-02,卡「引擎核心」)。三份:
 *
 * - {@link ./adapter.ts} 契约(`Job` / `JobResult` / `Adapter`;**改它 = 改契约**,四张卡一起改);
 * - {@link ./registry.ts} 哪几家 · 几条通道 · 这次走哪条(家族目录 + `capabilities()` 现查);
 * - {@link ./engine.ts} 一条引擎(过闸、重试、换路、落账、三种结局)。
 *
 * 消费方(8791 路由、电话工人、手机卡片)只认这一个入口:`createEngine({ registry, gate, log }).run(job)`。
 * 每条旧路由怎么改成调它,对照表在 `docs/交接-1002-引擎核心.md`。
 */
export type { Adapter, AdapterCapabilities, Job, JobKind, JobResult, JobTarget } from './adapter.ts'
export { ENGINE_MAX_RETRIES, RetryableError } from './adapter.ts'
export type { Engine, EngineDeps } from './engine.ts'
export {
  EVIDENCE_WHY,
  JOB_GATE_ACTION,
  JOB_LOG_STEP,
  UNCONFIRMED_WHY,
  VIA_WHEN_NONE,
  createEngine,
  engineGaveUpSay,
  engineJobKey,
  engineNoChannelSay,
  engineUnsupportedSay,
  jobActionText,
} from './engine.ts'
export type { AdapterPick, AdapterRegistry, EngineTarget, PickCandidate, RegistryDeps, WriteMode, WriteModeAdapter } from './registry.ts'
export {
  CAPS_TTL_MS,
  JOB_NEEDS,
  NO_CAPABILITIES,
  VIA_ORDER,
  WRITE_MODE_TEXT,
  channelRank,
  comparePicks,
  createRegistry,
  writeModeOf,
} from './registry.ts'
