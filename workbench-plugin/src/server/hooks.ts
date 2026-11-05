/**
 * 各 agent 客户端的 hook 上报 → 工作台事件（PRD §8.1，M2）。
 *
 * 为什么映射写在服务端而不是 shell 脚本里：脚本要跑在 Claude / Codex 的关键路径上，
 * 越薄越好——它只负责把 hook 的 stdin 原样转发过来。判断哪种 hook 算哪种状态，
 * 是有分支、会变、必须能测的逻辑，放这里。
 *
 * 两家的能力并不对等，这不是缺陷而是事实，界面必须如实反映：
 * - Claude Code：Notification + Stop 都有，四种状态齐全。
 * - Codex：只有 SessionStart/SessionEnd/PreToolUse/PostToolUse/UserPromptSubmit/Stop，
 *   **没有 Notification**，因此拿不到"等你确认"。这里绝不为它假造一条——
 *   假装能点、点了没反应，比不做更糟（PRD §7.4 同理）。
 * - Kimi：没有 hook 机制，整家都进不来，由界面标"未接入"。
 *
 * 等待原因分类(2026-09-09 拍板第 4 条)也照这条能力差走:**只有 Claude 的 Notification
 * 能分出「等审批」与「等你输入」**(新版看 notification_type,老版按关键词);Codex 走这条路的
 * 三个 hook 一律不填。判不出就不填,不猜(D13)。
 */
import type { AgentId, EventReason, SessionStatus, WaitReason, WorkbenchEvent } from '../protocol.ts'

/** 支持 hook 上报的来源。Kimi 不在其中。 */
const HOOK_AGENTS: readonly AgentId[] = ['claude', 'codex']

/**
 * 从 cwd 推项目名。
 *
 * worktree 的路径尾巴是随机词（`.claude/worktrees/unruffled-shamir-9be5be`），
 * 直接取 basename 会在界面上显示成一串没人认得的后缀，所以先把 worktree 段砍掉。
 */
export function projectFromCwd(cwd: string): string | undefined {
  if (typeof cwd !== 'string' || cwd === '') return undefined

  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  const cut = normalized.replace(/\/\.?(claude\/)?worktrees\/[^/]+$/, '')
  const name = cut.split('/').filter(Boolean).at(-1)
  return name === undefined || name === '' ? undefined : name
}

/**
 * Claude 的 Notification 是哪一种。
 *
 * 两条证据,按可靠性排:
 * 1. `notification_type`——新版 Claude Code 直接给的枚举,认得的那两个值一锤定音;
 * 2. 一句人话 `message`,按关键词判(老版只有这个)。
 *
 * 返回值分两半(2026-09-09 拍板第 4 条):
 * - `reason` 决定**响不响铃**,认不出时保守地按"等你下一句"算(不会误触响铃),这一档从来不缺;
 * - `wait_reason` 是**给 Ben 看的分类**,认不出就**整个缺席**——写「等你输入」等于替它编一句话(D13)。
 *   两者不合并正因为这个:一个必须有默认值,另一个必须能没有。
 */
function claudeWaitingReason(payload: Record<string, unknown>): { reason: EventReason, wait?: WaitReason } {
  const kind = payload.notification_type
  if (kind === 'permission_prompt') return { reason: 'permission_prompt', wait: 'approval' }
  if (kind === 'idle_prompt') return { reason: 'idle_prompt', wait: 'input' }
  // 认得出字段但不是这两个值(auth_success 之类):它根本不是"在等你",分类留空。
  if (typeof kind === 'string' && kind !== '') return { reason: 'idle_prompt' }

  const text = typeof payload.message === 'string' ? payload.message.toLowerCase() : ''
  if (text.includes('permission') || text.includes('approve') || text.includes('approval')) {
    return { reason: 'permission_prompt', wait: 'approval' }
  }
  if (text.includes('waiting for your input')) return { reason: 'idle_prompt', wait: 'input' }
  // 别的文案:照旧按"等你下一句"处理,但分类不填。
  return { reason: 'idle_prompt' }
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && HOOK_AGENTS.includes(value as AgentId)
}

/**
 * 把一条 hook 上报翻成工作台事件。认不出的返回 undefined，调用方直接忽略——
 * 状态里宁可少一条，也不能多一条假的。
 */
export function parseHookEvent(agent: string, payload: unknown): WorkbenchEvent | undefined {
  if (!isAgentId(agent)) return undefined
  if (typeof payload !== 'object' || payload === null) return undefined

  const raw = payload as Record<string, unknown>
  const sessionId = raw.session_id
  // 没有会话 id 就没法定位到某一条，写进去只会变成永远清不掉的孤儿。
  if (typeof sessionId !== 'string' || sessionId === '') return undefined

  const hook = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : ''

  let type: SessionStatus | undefined
  let reason: EventReason | undefined
  let waitReason: WaitReason | undefined

  if (hook === 'Notification' && agent === 'claude') {
    const waiting = claudeWaitingReason(raw)
    reason = waiting.reason
    /**
     * **「停下来等他下一句」不是「待确认」**(2026-09-25,卡 V;维护者原话:
     * 「待确认也是错的,那个黄色的,哪有要确认的」)。
     *
     * 一条 Notification 原来一律报 `waiting`,于是那条 `ben-cc`(桌面 App 里说完一轮在等他打字)
     * 被记成 waiting + `idle_prompt`,窗口槽 Claude 标签上就出了一颗**琥珀色的「1」**
     * (`DockTabBar` 的 waiting 档 = 「等确认」)。哪有要确认的 —— 它只是空闲。
     *
     * 现在分两种:
     * - `permission_prompt`(**形式上的**等待:权限弹窗、等批准)→ 照旧 `waiting` + `approval`,该响铃的还响;
     * - 别的(`idle_prompt`,含认不出 `notification_type` 的)→ **`done`,空闲**。
     *   `reason` 仍留 `idle_prompt`(会话区那一行照旧写「等你下一句」;响铃判定本来就只认 permission_prompt),
     *   但它不再进 waiting 档、不出琥珀气泡、不进「等你」那一堆。
     *   这与**文件那条路**本来的判法一致(claudeSessionRecover:`~/.claude/sessions/<pid>.json`
     *   说 `idle` → `done`),两条路从此不再一个说空闲、一个说待确认。
     *
     * 「内容上的等待」(最后一轮在问他 / 让他选 / 让他去做)归卡 T:这里只如实报形式信号,不判内容。
     */
    if (waiting.reason === 'permission_prompt') {
      type = 'waiting'
      waitReason = waiting.wait
    }
    else {
      type = 'done'
    }
  }
  else if (hook === 'Stop') {
    type = 'done'
    reason = 'stop'
  }
  else if (hook === 'UserPromptSubmit') {
    type = 'running'
  }
  else if (hook === 'SessionEnd') {
    // 会话没了要显式报离线，否则界面会留一条永远"在跑"的僵尸。
    type = 'offline'
    reason = 'offline'
  }

  if (type === undefined) return undefined

  const project = projectFromCwd(typeof raw.cwd === 'string' ? raw.cwd : '')

  // 只取定位所需的字段。transcript_path 等本机路径一概不带——
  // 这份事件会一路推到展示台，展示台不该拿到本机路径和会话内容。
  //
  // 注意：title 不取 raw.message。那是 Notification 的提示文案（比如"需要你的权限"），
  // 不是会话标题——早前这么塞过，效果是"等你确认"那几条显示成提示语、其余全是
  // "（无标题）"。真正的标题来自 transcript（见 attachTranscriptDetails），不在这里猜。
  return {
    agent,
    session_id: sessionId,
    type,
    ...(reason === undefined ? {} : { reason }),
    // Codex 这条路上永远是 undefined:它没有 Notification,四种等待原因一种都判不出。
    ...(waitReason === undefined ? {} : { wait_reason: waitReason }),
    ...(project === undefined ? {} : { project }),
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
  }
}

/**
 * 给已经解析出的 Claude 事件补上 title/summary（PRD §5.3）。
 *
 * 为什么不直接塞进 parseHookEvent：那是个纯函数，现有测试全程同步、不碰文件系统；
 * 读 transcript 需要 I/O，拆成单独一步，纯逻辑与文件读取的测试边界不混在一起。
 *
 * 只对 claude 生效——Codex 的"标题"走 codexSessionFeed 那条完全不同的路
 * （session_index.jsonl 查 thread_name），不复用这里。
 */
export function attachTranscriptDetails(
  agent: string,
  raw: Record<string, unknown>,
  event: WorkbenchEvent,
  extractDetails: (filePath: string, wantSummary: boolean) => { title?: string, summary?: string },
): WorkbenchEvent {
  if (agent !== 'claude') return event
  const transcriptPath = raw.transcript_path
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return event

  const details = extractDetails(transcriptPath, event.type === 'done')
  if (details.title === undefined && details.summary === undefined) return event

  return {
    ...event,
    ...(details.title === undefined ? {} : { title: details.title }),
    ...(details.summary === undefined ? {} : { summary: details.summary }),
  }
}
