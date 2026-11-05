// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractClaudeDetails } from '../src/server/transcript.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fixture(lines: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'))
  dirs.push(dir)
  const file = join(dir, 'ses.jsonl')
  writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return file
}

/** 真实结构样例（内容已换成占位文本，字段名/嵌套形状照抄本机 2026-08-21 实测的 transcript）。 */
const firstUserLine = {
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: '目标：把展示台上 Claude 额度那一栏的延迟压到 10 秒级。第一步先读交接文档。' },
  sessionId: 'ses-1',
}

const toolResultUserLine = {
  parentUuid: 'a',
  isSidechain: false,
  type: 'user',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ls 结果……' }],
  },
}

/** 真实结构：贴图消息，图片块排在文本块前面（2026-08-21 用 Ben 自己的会话验证过这个顺序）。 */
const imageThenTextContent = '关于工作台的呈现方式我有一个很疯狂的点子，我先说个大概'
const imageThenTextUserLine = {
  parentUuid: null,
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K...' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K...' } },
      { type: 'text', text: imageThenTextContent },
    ],
  },
}

/** 真实结构：技能注入的说明文本，不是人打的（2026-08-21 实测样例：superpowers:brainstorming 的注入）。 */
const skillInjectionUserLine = {
  parentUuid: 'c',
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Base directory for this skill: /Users/example/.claude/plugins/cache/...\n\n# Brainstorming Ideas' }],
  },
}

function assistantLine(text: string, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: 'b',
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先想一下……' },
        { type: 'text', text },
      ],
      ...extra,
    },
  }
}

describe('extractClaudeDetails · title', () => {
  it('没有 summary 行时，标题取第一条 user 消息文本，截 40 字', () => {
    const file = fixture([firstUserLine, assistantLine('好的，我先读文档。')])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
    expect(details.title!.length).toBeLessThanOrEqual(41) // 40 字 + 省略号
  })

  it('第一条 user 消息是纯 tool_result（无文字块）时跳到下一条 user 消息，不是直接留空', () => {
    const file = fixture([toolResultUserLine, firstUserLine])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
  })

  it('贴图消息（图片块排在文本块前面）也能取到文本——不能只看数组第一个块', () => {
    const file = fixture([imageThenTextUserLine, assistantLine('收到')])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated(imageThenTextContent, 40))
  })

  it('第一条 user 消息是技能注入的说明文本（"Base directory for this skill" 开头）时跳过，不当标题', () => {
    const file = fixture([skillInjectionUserLine, firstUserLine])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
    expect(details.title).not.toContain('Base directory')
  })

  it('连续几条都用不了（tool_result、技能注入）才轮到真正有文字的那条', () => {
    const file = fixture([toolResultUserLine, skillInjectionUserLine, firstUserLine])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
  })

  it('存在 type=="summary" 时优先于第一条 user 消息，且取最后一条', () => {
    const file = fixture([
      { type: 'summary', summary: '旧摘要——已经过期', leafUuid: 'x' },
      firstUserLine,
      { type: 'summary', summary: '压缩 Claude 额度延迟到 10 秒级', leafUuid: 'y' },
      assistantLine('好的'),
    ])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe('压缩 Claude 额度延迟到 10 秒级')
  })

  describe('type=="custom-title"（2026-08-21 Ben 抓出来的硬伤：漏了这个字段）', () => {
    /** 真实结构：Claude Code 每次会话标题一确定就重复写一遍，字段名照抄本机实测样例。 */
    function customTitleLine(customTitle: string) {
      return { type: 'custom-title', customTitle, sessionId: 'ses-1' }
    }

    it('custom-title 优先于第一条 user 消息', () => {
      const file = fixture([customTitleLine('工作台自定义布局方案'), firstUserLine])

      const details = extractClaudeDetails(file, false)

      expect(details.title).toBe('工作台自定义布局方案')
    })

    it('custom-title 优先于 type=="summary"', () => {
      const file = fixture([
        { type: 'summary', summary: '压缩摘要', leafUuid: 'y' },
        customTitleLine('工作台自定义布局方案'),
        firstUserLine,
      ])

      const details = extractClaudeDetails(file, false)

      expect(details.title).toBe('工作台自定义布局方案')
    })

    it('取窗口内最后一条 customTitle——Claude Code 会重复写同一条，也可能中途改过标题', () => {
      const file = fixture([
        customTitleLine('旧标题'),
        firstUserLine,
        customTitleLine('新标题'),
      ])

      const details = extractClaudeDetails(file, false)

      expect(details.title).toBe('新标题')
    })

    it('customTitle 是空串时视为无，退回下一优先级', () => {
      const file = fixture([customTitleLine(''), firstUserLine])

      const details = extractClaudeDetails(file, false)

      expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
    })

    it('customTitle 超过 40 字同样截断', () => {
      const long = '关于工作台的呈现方式我有一个很疯狂的点子，我先说个大概，你看有没有可能实现UI表现上分区域的策略'
      const file = fixture([customTitleLine(long)])

      const details = extractClaudeDetails(file, false)

      expect(details.title).toBe(truncated(long, 40))
    })
  })

  it('文件不存在时安静返回空对象，不抛错——hook 路径不能被这个拖垮', () => {
    const details = extractClaudeDetails('/nowhere/at/all.jsonl', false)

    expect(details).toEqual({})
  })

  it('只看头尾 chunk：中间才出现的 summary 行看不见（截断法本身的代价，接受它换更硬的性能约束）', () => {
    const middle = { type: 'summary', summary: '只在中间出现，读不到', leafUuid: 'mid' }
    // 用一堆填充行把 middle 挤到 chunkBytes=200 的头尾之外。
    const filler = Array.from({ length: 40 }, (_, i) => assistantLine(`填充第 ${i} 行 ${'x'.repeat(20)}`))
    const file = fixture([firstUserLine, ...filler.slice(0, 20), middle, ...filler.slice(20)])

    const details = extractClaudeDetails(file, false, { chunkBytes: 1000 })

    // 读不到中间那条 summary，退回第一条 user 消息。
    expect(details.title).toBe(truncated(firstUserLine.message.content, 40))
  })

  it('第一条 user 消息单行超过初始 chunkBytes（贴大图撑大的）时，头部会往上长直到读全整行', () => {
    // 复现 2026-08-21 真实案例：一条贴图消息单行 441KB，200KB 的头装不下、JSON.parse 直接失败。
    // 这里用 300KB 的假图片数据 + 默认 200KB 的 chunkBytes 复现"第一轮读不全"这一步。
    const bigImageUserLine = {
      parentUuid: null,
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300_000) } },
          { type: 'text', text: '关于工作台的呈现方式我有一个很疯狂的点子，我先说个大概' },
        ],
      },
    }
    const file = fixture([bigImageUserLine, assistantLine('收到')])

    const details = extractClaudeDetails(file, false)

    expect(details.title).toBe(truncated('关于工作台的呈现方式我有一个很疯狂的点子，我先说个大概', 40))
  })

  it('头部长到 maxHeadBytes 封顶还是读不全那一行时，安静放弃——不会为了这个把整份文件读穿', () => {
    const bigImageUserLine = {
      parentUuid: null,
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300_000) } },
          { type: 'text', text: '这句话读不到' },
        ],
      },
    }
    const file = fixture([bigImageUserLine])

    const details = extractClaudeDetails(file, false, { chunkBytes: 1000, maxHeadBytes: 2000 })

    expect(details.title).toBeUndefined()
  })
})

describe('extractClaudeDetails · summary（Stop 事件用）', () => {
  it('wantSummary=true 时，摘要取最后一条 assistant 文本，跳过 thinking 块，截 80 字', () => {
    const longText = '闭环了：核实了四个提交都在 main 上，实时链路已经在跑，Claude 额度用响应头而不是文件源，两个窗口都带 reset 时间。'
    const file = fixture([
      firstUserLine,
      assistantLine('中间这轮先跳过'),
      assistantLine(longText),
    ])

    const details = extractClaudeDetails(file, true)

    expect(details.summary).toBe(truncated(longText, 80))
    expect(details.summary).not.toContain('先想一下') // thinking 块不该混进来
  })

  it('wantSummary=false 时不返回 summary 字段，即使能提取到', () => {
    const file = fixture([firstUserLine, assistantLine('回答')])

    const details = extractClaudeDetails(file, false)

    expect(details.summary).toBeUndefined()
  })

  it('对话很短、内容全落在 head 里时（head/tail 重叠）依然能取到摘要', () => {
    const file = fixture([firstUserLine, assistantLine('简短回答')])

    const details = extractClaudeDetails(file, true, { chunkBytes: 200 * 1024 })

    expect(details.summary).toBe('简短回答')
  })

  it('没有任何 assistant 消息时摘要留空，不编造', () => {
    const file = fixture([firstUserLine])

    const details = extractClaudeDetails(file, true)

    expect(details.summary).toBeUndefined()
  })
})

function truncated(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
