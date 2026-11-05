import { describe, expect, it } from 'vitest'
import { attachTranscriptDetails, parseHookEvent } from '../src/server/hooks.ts'

const base = {
  session_id: 'ses-a7c1',
  cwd: '/Users/example/Documents/GitHub/DouDou',
  transcript_path: '/Users/example/.claude/projects/x/ses-a7c1.jsonl',
}

describe('parseHookEvent · Claude', () => {
  it('权限询问＝等你确认，且必须带 permission_prompt——只有它到时才允许响铃', () => {
    const event = parseHookEvent('claude', {
      ...base,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    })

    expect(event).toMatchObject({
      agent: 'claude',
      session_id: 'ses-a7c1',
      type: 'waiting',
      reason: 'permission_prompt',
    })
  })

  /**
   * ★卡 V(2026-09-25):**「停下来等他下一句」是空闲,不是「待确认」**。
   * 维护者原话:「待确认也是错的,那个黄色的,哪有要确认的」—— 那条 `ben-cc` 在桌面 App 里
   * 说完一轮等他打字,却被记成 waiting + idle_prompt,窗口槽 Claude 标签上出了一颗琥珀色的「1」。
   * 现在这一档报 `done`(空闲);`reason` 仍留 `idle_prompt`(会话行照旧写「等你下一句」)。
   */
  it('★闲置提醒＝空闲(done + idle_prompt),不是等审批、也不是「待确认」', () => {
    const event = parseHookEvent('claude', {
      ...base,
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
    })

    expect(event).toMatchObject({ type: 'done', reason: 'idle_prompt' })
    // 不进 waiting 档 —— 琥珀色气泡只给真的要他批 / 要他答。
    expect(event?.type).not.toBe('waiting')
  })

  it('Stop＝这一轮跑完了', () => {
    const event = parseHookEvent('claude', { ...base, hook_event_name: 'Stop' })

    expect(event).toMatchObject({ type: 'done', reason: 'stop' })
  })

  it('用户提交＝开始跑', () => {
    const event = parseHookEvent('claude', { ...base, hook_event_name: 'UserPromptSubmit' })

    expect(event).toMatchObject({ type: 'running' })
  })

  it('从 cwd 推出项目名，界面才能说清是哪个项目在等你', () => {
    const event = parseHookEvent('claude', { ...base, hook_event_name: 'Stop' })

    expect(event?.project).toBe('DouDou')
  })

  it('worktree 路径要归到主项目上，不能显示成一串随机后缀', () => {
    const event = parseHookEvent('claude', {
      ...base,
      cwd: '/Users/example/Documents/GitHub/Aiboo/.claude/worktrees/unruffled-shamir-9be5be',
      hook_event_name: 'Stop',
    })

    expect(event?.project).toBe('Aiboo')
  })

  it('不认识的 hook 事件一律忽略，不往状态里写垃圾', () => {
    expect(parseHookEvent('claude', { ...base, hook_event_name: 'PreCompact' })).toBeUndefined()
  })

  it('没有 session_id 就没法定位，直接丢弃', () => {
    expect(parseHookEvent('claude', { hook_event_name: 'Stop' })).toBeUndefined()
  })

  it('不把 transcript_path 写进事件——那是本机路径，会一路推到展示台', () => {
    const event = parseHookEvent('claude', { ...base, hook_event_name: 'Stop' })

    expect(JSON.stringify(event)).not.toContain('transcript')
  })
})

describe('parseHookEvent · Codex', () => {
  it('Stop＝跑完了', () => {
    const event = parseHookEvent('codex', {
      ...base,
      hook_event_name: 'Stop',
      cwd: '/Users/example/Documents/GitHub/Echo',
    })

    expect(event).toMatchObject({ agent: 'codex', type: 'done', reason: 'stop' })
  })

  it('SessionEnd＝这个会话没了，报离线而不是留一条永远在跑的僵尸', () => {
    const event = parseHookEvent('codex', { ...base, hook_event_name: 'SessionEnd' })

    expect(event).toMatchObject({ type: 'offline', reason: 'offline' })
  })

  it('Codex 没有 Notification hook，拿不到"等你确认"——不能假造一条', () => {
    const event = parseHookEvent('codex', { ...base, hook_event_name: 'Notification', message: 'permission' })

    expect(event).toBeUndefined()
  })
})

describe('attachTranscriptDetails', () => {
  const event = parseHookEvent('claude', { ...base, hook_event_name: 'Stop' })!

  it('claude 事件带 transcript_path 时补上 title/summary', () => {
    const enriched = attachTranscriptDetails('claude', base, event, () => ({ title: '标题', summary: '摘要' }))

    expect(enriched).toMatchObject({ title: '标题', summary: '摘要' })
  })

  it('Stop 事件才要 summary——把这个信号原样透给 extractDetails，好让它决定要不要多扫一遍找 assistant 文本', () => {
    let seenWantSummary: boolean | undefined
    attachTranscriptDetails('claude', base, event, (_file, wantSummary) => {
      seenWantSummary = wantSummary
      return {}
    })

    expect(seenWantSummary).toBe(true)
  })

  it('非 Stop 事件时 wantSummary 传 false', () => {
    const running = parseHookEvent('claude', { ...base, hook_event_name: 'UserPromptSubmit' })!
    let seenWantSummary: boolean | undefined
    attachTranscriptDetails('claude', base, running, (_file, wantSummary) => {
      seenWantSummary = wantSummary
      return {}
    })

    expect(seenWantSummary).toBe(false)
  })

  it('没有 transcript_path 时原样返回事件，不调用 extractDetails', () => {
    let called = false
    const enriched = attachTranscriptDetails('claude', {}, event, () => {
      called = true
      return { title: 'x' }
    })

    expect(called).toBe(false)
    expect(enriched).toBe(event)
  })

  it('codex 事件不走这条路——它的标题来自 codexSessionFeed，不是 transcript', () => {
    let called = false
    const enriched = attachTranscriptDetails('codex', base, event, () => {
      called = true
      return { title: 'x' }
    })

    expect(called).toBe(false)
    expect(enriched).toBe(event)
  })

  it('extractDetails 两项都拿不到时原样返回事件（不产生空字段）', () => {
    const enriched = attachTranscriptDetails('claude', base, event, () => ({}))

    expect(enriched).toBe(event)
  })
})

/**
 * 等待原因分类(2026-09-09 傍晚拍板第 4 条)。Claude 一家能可靠分出**等审批**与**等你输入**:
 * 新版 Claude Code 的 Notification 带 `notification_type`,老版只有一句 message——
 * 两种形状都认;认不出的**不填**(D13),而不是猜一个。
 */
describe('parseHookEvent · Claude · wait_reason', () => {
  it('notification_type=permission_prompt → 等审批(哪怕 message 里没有 permission 字样)', () => {
    const event = parseHookEvent('claude', {
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: '要动 ~/.zshrc,可以吗',
    })
    expect(event).toMatchObject({ type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
  })

  /**
   * ★卡 V(2026-09-25):`idle_prompt` 这一档报 `done`(空闲)。`wait_reason` 也不填 ——
   * 它根本不在「等你」那一堆里(那一堆只有要他答 / 要他批 / 要他验收)。
   */
  it('★notification_type=idle_prompt → 空闲(done),不填 wait_reason', () => {
    const event = parseHookEvent('claude', {
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    })
    expect(event).toMatchObject({ type: 'done', reason: 'idle_prompt' })
    expect(event).not.toHaveProperty('wait_reason')
  })

  it('老版没有 notification_type:message 有 permission 字样 → 等审批(waiting);waiting for your input → 空闲(done)', () => {
    expect(parseHookEvent('claude', {
      ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash',
    })).toMatchObject({ type: 'waiting', wait_reason: 'approval' })
    // ★卡 V:这一句原来是 `wait_reason: 'input'` + waiting;现在是空闲。
    const idle = parseHookEvent('claude', {
      ...base, hook_event_name: 'Notification', message: 'Claude is waiting for your input',
    })
    expect(idle).toMatchObject({ type: 'done', reason: 'idle_prompt' })
    expect(idle).not.toHaveProperty('wait_reason')
  })

  it('★认不出的通知(auth_success、别的文案)也算空闲,wait_reason 不填——不猜', () => {
    const odd = parseHookEvent('claude', {
      ...base, hook_event_name: 'Notification', notification_type: 'auth_success', message: 'Logged in',
    })
    expect(odd).toMatchObject({ type: 'done', reason: 'idle_prompt' })
    expect(odd).not.toHaveProperty('wait_reason')

    const bare = parseHookEvent('claude', { ...base, hook_event_name: 'Notification', message: '完成了一半' })
    expect(bare).not.toHaveProperty('wait_reason')
  })

  it('Stop / UserPromptSubmit / SessionEnd 都不带 wait_reason', () => {
    for (const hook of ['Stop', 'UserPromptSubmit', 'SessionEnd']) {
      expect(parseHookEvent('claude', { ...base, hook_event_name: hook })).not.toHaveProperty('wait_reason')
    }
  })

  it('Codex 走 hook 的那几条一律没有 wait_reason——它没有 Notification,四种原因一种都判不出', () => {
    for (const hook of ['Stop', 'UserPromptSubmit', 'SessionEnd']) {
      expect(parseHookEvent('codex', { ...base, hook_event_name: hook })).not.toHaveProperty('wait_reason')
    }
  })
})
