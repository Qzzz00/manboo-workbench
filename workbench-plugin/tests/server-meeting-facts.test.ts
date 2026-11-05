// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMeetingFacts } from '../src/server/meetingFacts.ts'
import type { TaskView } from '../src/protocol.ts'

describe('预案卡的事实表:只读她工作目录与看板里已有的', () => {
  it('账号笔记篇数、复盘自评分、看板;读不到的不补', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'wb-meeting-facts-'))
    mkdirSync(join(workdir, '账号', '小鱼日记', '笔记'), { recursive: true })
    writeFileSync(join(workdir, '账号', '小鱼日记', '笔记', 'a.md'), 'x')
    writeFileSync(join(workdir, '账号', '小鱼日记', '笔记', 'b.md'), 'y')
    mkdirSync(join(workdir, '选题', '秋日穿搭'), { recursive: true })
    writeFileSync(join(workdir, '选题', '秋日穿搭', '复盘.md'), '# 复盘\n\n## 自评(2026-10-05)\n- **自评分**:4/5\n- **谁填的**:她\n')
    const tasks = [{ id: 't1', title: 'B客户报价单', status: 'doing' }] as unknown as TaskView[]
    const facts = await createMeetingFacts({
      workdir: () => workdir,
      topicsDir: () => join(workdir, '选题'),
      tasks: async () => tasks,
      now: () => Date.parse('2026-10-10T02:00:00Z'),
    })(['B客户'])
    const text = facts.map(f => `${f.text} | ${f.source}`).join('\n')
    expect(text).toContain('账号「小鱼日记」已发笔记 2 篇 | 账号/小鱼日记/笔记/')
    expect(text).toContain('选题「秋日穿搭」复盘:自评分 4/5 | 选题/秋日穿搭/复盘.md(2026-10-05)')
    expect(text).toContain('看板事项「B客户报价单」:进行中')
    expect(text).not.toContain('目标')
  })
  it('没配工作目录、没有小红书数据 → 只剩看板(一个数都不编)', async () => {
    const facts = await createMeetingFacts({ workdir: () => undefined, topicsDir: () => undefined })([])
    expect(facts).toEqual([])
  })
})
