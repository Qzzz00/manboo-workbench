/**
 * 回归:这一页上她看见的只有人话(2026-10-02,卡「提示词页改成她的偏好页」)。
 *
 * 维护者 10-02:「提示词现在看似有一个汇总的地方,但是运营人员反馈太杂了」,
 * 「不要拿着打补丁的心态,要有机制上的调整」。统筹量过维护者那台:9 段、约 2.7 万字、
 * 接口 / 地址 149 处。所以这个文件**两套模板各一套夹具**(运营 / 做产品),
 * 用**真技能正文**(包内那份,里面就是接口与路径)摆出 AGENTS.md,再把
 * **真的设置页服务**接到**真的面板**上,断言:
 *
 * 1. 默认看得见的只有人话那几项 + 各环节的名字 —— **一个接口、一条路径都没有**;
 * 2. 她在「标题与封面」写一条「标题不要用感叹号」→ 写进 AGENTS.md 对应技能段的偏好位置;
 * 3. **发版重写那一段技能正文之后那一条还在**(这是整张卡的机制所在)。
 *
 * 全在 `mkdtemp` 的临时目录里 —— 真实的 `~/.dsh/AGENTS.md` 一个字节都不碰。
 */
import '@testing-library/jest-dom/vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptsPanel } from '../src/client/PromptsPanel.tsx'
import { createPromptOverrideStore, installPromptOverrides, resetInstalledPromptOverrides } from '../src/server/promptOverrides.ts'
import { createPromptsService } from '../src/server/promptsPage.ts'
import { opsSkillBody, opsSkillDoc, opsSkillsForTemplate } from '../src/server/opsSkills.ts'
import { bundledSkillDoc } from '../src/server/bundledSkills.ts'
import { wbOpsSkillsApply } from '../src/server/hooksApply.ts'
import { readMarkedBlock } from '../src/server/memoryMd.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'

configure({ asyncUtilTimeout: 5_000 })

const dirs: string[] = []
afterEach(() => {
  cleanup()
  resetInstalledPromptOverrides()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 人话那几项的夹具:一句人话都不带路径(真机上这几段也是引导问出来的人话)。 */
const HEAD = [
  '我叫 小九。',
  '',
  '# 事务官',
  '',
  '顺手写在文件里的一句:看 ~/.dsh/workbench/layout.json 里那一格。',
  '',
  '<!-- 引导:说话方式:开始 -->',
  '## 说话方式',
  '- 人设:稳一点,别贴贴',
  '<!-- 引导:说话方式:结束 -->',
  '',
  '<!-- 引导:称呼:开始 -->',
  '- 老板',
  '<!-- 引导:称呼:结束 -->',
  '',
  '<!-- 引导:规矩:开始 -->',
  '- 界面不要用蓝色',
  '<!-- 引导:规矩:结束 -->',
  '',
].join('\n')

const deps = { io: nodeSetupIo(), now: () => new Date('2026-10-02T09:00:00Z') }

/** 包内那份真技能正文(里面就是接口、路径、步骤)。 */
async function realSkillBody(skill: { name: string }): Promise<string | undefined> {
  const text = bundledSkillDoc(opsSkillDoc(skill as never))
  return text === undefined ? undefined : opsSkillBody(text)
}

/** 摆一台真机:AGENTS.md 用真技能正文写满,设置页服务 + 覆盖层照 index.ts 那一处接线。 */
async function stand(templateId: 'ops' | 'product') {
  const dir = mkdtempSync(join(tmpdir(), `wb-her-page-${templateId}-`))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, HEAD, 'utf8')

  const store = createPromptOverrideStore({
    file: join(dir, 'prompt-overrides.json'),
    logFile: join(dir, 'prompt-overrides.log.jsonl'),
    now: deps.now,
  })
  await store.load()
  installPromptOverrides(store)

  /** 发版重写那一下(起服务 / 切模板 / 升级都走它)。 */
  const ship = async (): Promise<void> => {
    const done = await wbOpsSkillsApply(deps, { file: agentsFile, templateId, readDoc: realSkillBody })
    expect(done.ok).toBe(true)
  }
  await ship()

  const svc = createPromptsService({
    store,
    agentsFile,
    deps,
    skills: () => opsSkillsForTemplate(templateId).map(one => ({
      name: one.name,
      summary: one.summary,
      ...(one.stage === undefined ? {} : { stage: one.stage }),
    })),
  })

  /** 把面板接到真服务上(浏览器里那条 fetch 在这儿换成直调)。 */
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://wb', '')
    if (init?.method !== 'POST') return new Response(JSON.stringify(await svc.view()), { status: 200 })
    const body = JSON.parse(String(init.body)) as { name: string, body?: string, lines?: string[] }
    const done = path === '/butler/prompts/pref'
      ? await svc.setPrefs({ name: body.name, lines: body.lines ?? [] })
      : await svc.save({ name: body.name, body: body.body ?? '' })
    return new Response(JSON.stringify(done.ok ? { ok: true, note: done.note } : { error: done.error }), {
      status: done.ok ? 200 : 400,
    })
  }) as typeof fetch

  return { dir, agentsFile, svc, fetchImpl, ship }
}

/** 她默认看得见的那些字里不许出现的东西(这一页是给不会写代码的人看的)。 */
const FORBIDDEN = [
  '/butler/', '/dispatch', '/config/', '/state', 'http://', 'https://', '8791',
  '~/.dsh', '.md', '.json', '{{', 'curl', 'POST ', '接口',
]

describe('她的偏好页:默认只有人话', () => {
  for (const templateId of ['ops', 'product'] as const) {
    it(`${templateId} 模板:默认看得见的只有人话那几项与环节名,没有接口路径`, async () => {
      const { fetchImpl } = await stand(templateId)
      const { container } = render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
      await waitFor(() => { expect(screen.getByText('它叫什么')).toBeInTheDocument() })

      // 人话那几项都在。
      for (const title of ['它叫什么', '怎么称呼你', '说话方式', '你的规矩(要 / 不要)', '还想交代的几句']) {
        expect(screen.getByText(title)).toBeInTheDocument()
      }
      // 各环节都在(环节名从模板那几条技能取,不是界面里写死的一份)。2026-10-22 起收在「各个环节的偏好」那一行,
      // 那一行副行就是各环节名;点「查看」一行一个。
      const stages = opsSkillsForTemplate(templateId).filter(one => one.stage !== undefined)
      expect(stages.length).toBeGreaterThan(0)
      await userEvent.click(screen.getByRole('button', { name: '查看' }))
      for (const one of stages) expect(screen.getByText(one.stage?.title ?? '', { selector: 'strong' })).toBeInTheDocument()

      // 这一屏上一个接口、一条路径都没有。
      const shown = container.textContent ?? ''
      for (const bad of FORBIDDEN) expect(shown).not.toContain(bad)
      // 技能段名也不露(它们在页底那一节里,默认收起)。
      for (const one of opsSkillsForTemplate(templateId)) expect(shown).not.toContain(one.name)
    })
  }

  it('运营模板:环节就是她干活那几段', async () => {
    const { svc } = await stand('ops')
    const titles = (await svc.view()).stages.map(one => one.title)
    expect(titles).toContain('选题立框架')
    expect(titles).toContain('写稿')
    expect(titles).toContain('标题与封面')
    expect(titles).toContain('复盘')
    // 口径类的「运营-总纲」不是一个环节,不出现。
    expect((await svc.view()).stages.map(one => one.name)).not.toContain('运营-总纲')
  })

  /**
   * ★ 2026-10-02 **下午维护者拍板「允许」**:上午那一版把不可改清单那两段连环节也滤掉,
   * 做产品模板下于是只剩「派活给别家」一个环节。维护者:「她在《需求确认点》
   * 《做产品-改工作台自己》后面加一句自己的偏好,不算触及不可改清单」——**正文仍然只读**。
   */
  it('★做产品模板:不出现运营那一包的环节;锁着的那两段也有环节(需求 / 验收)', async () => {
    const { svc } = await stand('product')
    const view = await svc.view()
    expect(view.stages.map(one => one.name).some(name => name.startsWith('运营-'))).toBe(false)
    expect(view.stages.map(one => one.name)).toContain('需求确认点')
    expect(view.stages.map(one => one.name)).toContain('做产品-改工作台自己')
    expect(view.stages.map(one => one.title)).toEqual(expect.arrayContaining(['需求', '验收', '派活给别家']))
    // 环节有了,**正文那一头照旧只读**:页底那一摊里它们还是 locked、还是改不动。
    for (const name of ['需求确认点', '做产品-改工作台自己']) {
      const row = view.manual.find(one => one.name === name)
      expect(row?.editable).toBe(false)
      expect(row?.locked).toContain('不可改清单')
      expect((await svc.save({ name, body: '改一句' })).ok).toBe(false)
    }
  })

  it('★锁着的那个环节也写得进一条偏好(接在正文末尾,正文一个字没动)', async () => {
    const { svc, agentsFile } = await stand('product')
    expect((await svc.setPrefs({ name: '需求确认点', lines: ['确认点一次最多问我三条'] })).ok).toBe(true)
    const block = readMarkedBlock(readFileSync(agentsFile, 'utf8'), '需求确认点') ?? ''
    expect(block).toContain('确认点一次最多问我三条')
    // 正文那一句还在(偏好是接上去的,不是替掉的)。
    expect(block).toContain('确认点')
    expect((await svc.view()).stages.find(one => one.name === '需求确认点')?.lines).toEqual(['确认点一次最多问我三条'])
  })
})

describe('一条偏好:写进去、发版之后还在', () => {
  it('在「标题与封面」写一条 → 进那一段技能的偏好位置 → 发版重写之后还在', async () => {
    const { fetchImpl, agentsFile, ship } = await stand('ops')
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText('各个环节的偏好')).toBeInTheDocument() })
    await userEvent.click(screen.getByRole('button', { name: '查看' }))

    const row = screen.getByText('标题与封面', { selector: 'strong' }).closest('[data-prompt-stage]') as HTMLElement
    await userEvent.click(row.querySelector('button') as HTMLElement)
    await userEvent.type(screen.getByRole('textbox', { name: '改「标题与封面」的偏好' }), '标题不要用感叹号')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText(/标题不要用感叹号/)).toBeInTheDocument() })

    // ① 真写进了那一段技能的偏好位置(正文一个字没动)。
    const before = readMarkedBlock(readFileSync(agentsFile, 'utf8'), '运营-发布包装') ?? ''
    expect(before).toContain('标题不要用感叹号')
    expect(before).toContain('三组备选')

    // ② 发版重写那一段技能正文 —— 她那一条还在。
    await ship()
    const after = readMarkedBlock(readFileSync(agentsFile, 'utf8'), '运营-发布包装') ?? ''
    expect(after).toContain('标题不要用感叹号')
    expect(after).toContain('三组备选')
    // 只有一份(重写几次都不堆)。
    expect(after.split('标题不要用感叹号')).toHaveLength(2)
  })
})
