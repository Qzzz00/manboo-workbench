/**
 * `?demo=1` 用的固件数据。
 *
 * 为什么要有：展示台的 Live2D 与音乐依赖 Aiboo 账号与云端后端，会话与额度依赖工作台服务。
 * 三者都立起来才能看一眼版式，代价太高。demo 模式让版式可以单独验收，
 * 也方便在没有那台 1200×800 硬件时对着布局稿比对。
 *
 * ★ 只在 URL 显式带 ?demo=1 时启用。数据全是假的，不会伪装成真实状态——
 * 界面右上角会标明这是演示数据。
 */
import type { WorkbenchState } from './workbenchProtocol';

/**
 * demo 模式三态：
 * - 关：正常走登录 + Live2D + 音乐 + 真实 WS
 * - `?demo=1`：跳过登录门，用固件数据看版式（Live2D 不加载）
 * - `?demo=live`：跳过登录门，但用**真实 WS 数据** —— 用来端到端验
 *   「工作台服务 → WS → 展示台」这条链路，不必先把 Aiboo 账号态立起来。
 */
export type DemoMode = 'off' | 'fixture' | 'live';

export function demoMode(search: string): DemoMode {
  const value = new URLSearchParams(search).get('demo');
  if (value === '1') return 'fixture';
  if (value === 'live') return 'live';
  return 'off';
}

export function isDemoMode(search: string): boolean {
  return demoMode(search) !== 'off';
}

/** 一份覆盖四种状态、三种额度形态的演示快照，对齐 v4 布局稿的示例内容。 */
export function demoState(): WorkbenchState {
  const now = new Date();
  return {
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 1, running: 1 },
      { id: 'claude', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'codex', online: true, connected: true, waiting: 0, running: 2 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [
      {
        agent: 'dsh',
        session_id: 'a7c1e0',
        project: '扣扣直聘',
        status: 'waiting',
        reason: 'permission_prompt',
        title: '要改 config/schema.ts',
        summary: '改动会影响 3 处引用，需要你确认是否继续',
        elapsed_sec: 252,
        unread: false,
        updated_at: now.toISOString(),
      },
      {
        agent: 'dsh',
        session_id: 'd41a9c',
        project: '扣扣直聘',
        status: 'running',
        title: 'Worker 链路回归',
        elapsed_sec: 720,
        last_output_sec: 40,
        unread: false,
        updated_at: now.toISOString(),
      },
      {
        agent: 'claude',
        session_id: '3f9e77',
        project: '工作台',
        status: 'done',
        reason: 'stop',
        title: '展示台协议草稿',
        summary: '写了 state / event 两个 schema，附了一版示例 JSON',
        elapsed_sec: 120,
        unread: true,
        updated_at: now.toISOString(),
      },
      {
        agent: 'codex',
        session_id: 'b204ab',
        project: 'Aiboo',
        status: 'running',
        title: 'Aiboo 主 App 性能回归',
        elapsed_sec: 480,
        unread: false,
        updated_at: now.toISOString(),
      },
      {
        agent: 'codex',
        session_id: 'c88a12',
        project: 'Echo',
        status: 'running',
        title: 'Echo ASR 链路诊断',
        elapsed_sec: 180,
        unread: false,
        updated_at: now.toISOString(),
      },
    ],
    quota: {
      // 余额型：只给数字，不画条
      dsh: { kind: 'balance', currency: 'CNY', total: '218.40', today_spent: '12.60', available: true },
      // 窗口型：按剩余画条
      claude: {
        kind: 'quota',
        windows: [{ label: '5h', left_pct: 31, reset_at: '14:20' }, { label: '周', left_pct: 74 }],
      },
      // 见底：变红
      kimi: {
        kind: 'quota',
        windows: [{ label: '5h', left_pct: 9, reset_at: '12:45' }, { label: '周', left_pct: 52 }],
      },
      // 未接入：显式标出，不用 0 冒充
      codex: { kind: 'unknown', note: '取数方式待实测' },
    },
    now: now.toISOString(),
    stale: false,
  };
}
