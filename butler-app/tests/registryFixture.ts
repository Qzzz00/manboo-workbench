/**
 * 用例里的 Agent 登记表(卡 Q)。手机里不再有名字表:「哪几家、各叫什么」只从 `/state.agent_registry` 来 ——
 * 用例照服务端的样子给一份。名字是**用例数据**,不是产品代码里的表。
 */
import type { AgentRegistryView, SessionView } from '../src/api/protocol';

export const TEST_NAMES: Readonly<Record<string, string>> = { dsh: '事务官', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };

/** 按会话流拼出登记表(每家一条,会话挂在各自条目上)。 */
export function registryOf(sessions: readonly SessionView[], extraIds: readonly string[] = []): AgentRegistryView {
  const ids = [...new Set([...sessions.map((one) => one.agent), ...extraIds])];
  return {
    entries: ids.map((id) => ({
      id,
      name: TEST_NAMES[id] ?? id,
      ...(id === 'dsh' ? { self: true } : {}),
      status: 'running' as const,
      gaps: {},
      sessions: sessions.filter((one) => one.agent === id).map((one) => ({ ...one, via: 'sessions' as const })),
      counts: { running: 0, waiting: 0, unread: 0 },
    })),
    asking: [],
    notices: [],
  };
}
