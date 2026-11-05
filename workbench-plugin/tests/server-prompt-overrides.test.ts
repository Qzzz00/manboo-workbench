// @vitest-environment node
/**
 * 覆盖层:她在设置里改过的提示词段(2026-10-01,卡「设置里集中改提示词」)。
 *
 * 钉这几件(全在临时目录,**一行都不碰 ~/.dsh**):
 * 1. 没有覆盖 → 每条写入路径写的还是默认正文,**一字不变**;
 * 2. 有覆盖 → `wbSkillApply` / `wbOpsSkillsApply` / 引导重跑写的都是她那一份;
 * 3. 默认变了(发版更新了那一段)而她改过 → **不冲掉**,并且记下新默认,设置页标「默认版本有更新」;
 * 4. 「换成新默认」= 清掉覆盖,下一次写入路径写新默认;
 * 5. 追加式的那两段(称呼)不被覆盖层顶替,但覆盖层跟着刷新 —— 不会攒出一份过期的覆盖;
 * 6. 每次保存 / 恢复在用户层里追一行留痕,`undo` 撤到上一版;
 * 7. 不可改清单对应的段(澄清环节 = 《需求确认点》)**存不进去**。
 *
 * 2026-10-02(卡「提示词页改成她的偏好页」)起这一页分两层:人话那几项仍走这里的
 * `save/reset/undo`(下面那一批用例原样兜着),**技能正文改不动了** ——
 * 环节偏好、迁移、偏好怎么接进 AGENTS.md 全在 `server-prompt-prefs.test.ts`。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROMPT_EXTRA_SECTION, PROMPT_NAME_SECTION, createPromptOverrideStore, installPromptOverrides,
  promptFingerprint, promptSectionMeta, resetInstalledPromptOverrides, resolvePromptBody,
} from '../src/server/promptOverrides.ts'
import { createPromptsService } from '../src/server/promptsPage.ts'
import { CALL_ADDRESS_BLOCK, SPEAKING_STYLE_BLOCK, readMarkedBlock } from '../src/server/memoryMd.ts'
import { wbOpsSkillsApply, wbSkillApply } from '../src/server/hooksApply.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { CONFIRM_SKILL_NAME } from '../src/server/confirmPoints.ts'

const dirs: string[] = []

afterEach(() => {
  resetInstalledPromptOverrides()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-prompts-'))
  dirs.push(dir)
  return dir
}

function deps() {
  return { io: nodeSetupIo(), now: () => new Date('2026-10-01T09:00:00Z') }
}

async function freshStore(dir: string) {
  const store = createPromptOverrideStore({
    file: join(dir, 'prompt-overrides.json'),
    logFile: join(dir, 'prompt-overrides.log.jsonl'),
    now: () => new Date('2026-10-01T09:00:00Z'),
  })
  await store.load()
  return store
}

describe('覆盖层本身', () => {
  it('没有覆盖时 resolve 原样回默认', async () => {
    const store = await freshStore(tempDir())
    expect(store.resolve(SPEAKING_STYLE_BLOCK, '## 说话方式\n- 人设:沉稳')).toBe('## 说话方式\n- 人设:沉稳')
    expect(store.get(SPEAKING_STYLE_BLOCK)).toBeUndefined()
  })

  it('没装覆盖层时 resolvePromptBody 原样回默认', () => {
    expect(resolvePromptBody(SPEAKING_STYLE_BLOCK, '默认')).toBe('默认')
  })

  it('保存过就回她那一份,并记下当时那份默认的指纹', async () => {
    const store = await freshStore(tempDir())
    const def = '## 说话方式\n- 人设:沉稳'
    const saved = await store.save(SPEAKING_STYLE_BLOCK, '## 说话方式\n- 说话像朋友', { defaultBody: def })
    expect(saved.ok).toBe(true)
    expect(store.resolve(SPEAKING_STYLE_BLOCK, def)).toBe('## 说话方式\n- 说话像朋友')
    expect(store.get(SPEAKING_STYLE_BLOCK)?.default_fingerprint).toBe(promptFingerprint(def))
  })

  it('默认变了也不冲掉她那一份,但记下新默认', async () => {
    const dir = tempDir()
    const store = await freshStore(dir)
    await store.save(SPEAKING_STYLE_BLOCK, '我的写法', { defaultBody: '老默认' })
    expect(store.resolve(SPEAKING_STYLE_BLOCK, '新默认(发版更新了)')).toBe('我的写法')
    const row = store.rows().find(one => one.name === SPEAKING_STYLE_BLOCK)
    expect(row?.default_changed).toBe(true)
    expect(row?.latest_default_body).toBe('新默认(发版更新了)')
    // 落盘了:重开一份读得到(发版重启之后那条「默认版本有更新」还在)。
    await store.flush()
    const again = await freshStore(dir)
    expect(again.rows().find(one => one.name === SPEAKING_STYLE_BLOCK)?.default_changed).toBe(true)
  })

  it('恢复默认 = 清掉覆盖,下一次写默认', async () => {
    const store = await freshStore(tempDir())
    await store.save(SPEAKING_STYLE_BLOCK, '我的写法', { defaultBody: '老默认' })
    const back = await store.reset(SPEAKING_STYLE_BLOCK)
    expect(back.ok).toBe(true)
    expect(store.resolve(SPEAKING_STYLE_BLOCK, '新默认')).toBe('新默认')
  })

  it('追加式的那一段不被顶替,但覆盖层跟着刷新', async () => {
    const store = await freshStore(tempDir())
    expect(promptSectionMeta(CALL_ADDRESS_BLOCK).mode).toBe('append')
    await store.save(CALL_ADDRESS_BLOCK, '- 老板', { defaultBody: '- 老板' })
    // 电话里又追了一条:写进去的是文件算出来的那一份,不是覆盖层里的老的。
    expect(store.resolve(CALL_ADDRESS_BLOCK, '- 老板\n- 姚总')).toBe('- 老板\n- 姚总')
    expect(store.get(CALL_ADDRESS_BLOCK)?.body).toBe('- 老板\n- 姚总')
  })

  it('留痕一行一条,undo 撤到上一版', async () => {
    const dir = tempDir()
    const store = await freshStore(dir)
    await store.save(SPEAKING_STYLE_BLOCK, '第一版', { defaultBody: '默认' })
    await store.save(SPEAKING_STYLE_BLOCK, '第二版', { defaultBody: '默认' })
    const log = readFileSync(join(dir, 'prompt-overrides.log.jsonl'), 'utf8').trim().split('\n')
    expect(log).toHaveLength(2)
    expect(JSON.parse(log[1] as string)).toMatchObject({ action: 'save', name: SPEAKING_STYLE_BLOCK })
    const undone = await store.undo(SPEAKING_STYLE_BLOCK)
    expect(undone.ok).toBe(true)
    expect(store.resolve(SPEAKING_STYLE_BLOCK, '默认')).toBe('第一版')
    // 再撤一次回到「没改过」。
    expect((await store.undo(SPEAKING_STYLE_BLOCK)).ok).toBe(true)
    expect(store.resolve(SPEAKING_STYLE_BLOCK, '默认')).toBe('默认')
  })

  it('没有上一版时 undo 如实说,不乱改', async () => {
    const store = await freshStore(tempDir())
    const undone = await store.undo(SPEAKING_STYLE_BLOCK)
    expect(undone.ok).toBe(false)
    expect(undone.ok ? '' : undone.error).toContain('没有上一版')
  })

  it('不可改清单那几段存不进去', async () => {
    const store = await freshStore(tempDir())
    expect(promptSectionMeta(CONFIRM_SKILL_NAME).locked).toBeDefined()
    const saved = await store.save(CONFIRM_SKILL_NAME, '随便改一句', { defaultBody: '默认' })
    expect(saved.ok).toBe(false)
    expect(store.resolve(CONFIRM_SKILL_NAME, '默认')).toBe('默认')
  })

  it('表坏了当一条覆盖都没有,不抛', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'prompt-overrides.json'), '{ 这不是 json', 'utf8')
    const store = await freshStore(dir)
    expect(store.rows()).toHaveLength(0)
  })
})

describe('写入路径都先查覆盖层', () => {
  it('wbSkillApply:有覆盖就写覆盖', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '我叫 小助。\n\n# 事务官\n', 'utf8')
    const store = await freshStore(dir)
    await store.save(SPEAKING_STYLE_BLOCK, '## 说话方式\n- 说话像朋友', { defaultBody: '## 说话方式\n- 人设:沉稳' })
    installPromptOverrides(store)
    const done = await wbSkillApply(deps(), { file, name: SPEAKING_STYLE_BLOCK, body: '## 说话方式\n- 人设:沉稳' })
    expect(done.ok).toBe(true)
    expect(readMarkedBlock(readFileSync(file, 'utf8'), SPEAKING_STYLE_BLOCK)).toBe('## 说话方式\n- 说话像朋友')
  })

  it('规矩那一段在别处改,覆盖层不收这一段(同一张表不该有两处入口)', async () => {
    const store = await freshStore(tempDir())
    const denied = await store.save('规矩', '- 界面不要蓝', { defaultBody: '- 默认' })
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error).toContain('记住的规矩')
  })

  it('wbSkillApply:没有覆盖时一字不变', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '# 事务官\n', 'utf8')
    installPromptOverrides(await freshStore(dir))
    await wbSkillApply(deps(), { file, name: '规矩', body: '- 默认那一条' })
    expect(readMarkedBlock(readFileSync(file, 'utf8'), '规矩')).toBe('- 默认那一条')
  })

  /**
   * 2026-10-02 起**技能正文没有覆盖这回事**了(她改不动正文,改的是环节偏好)——
   * 所以切模板 / 发版重写那一下,技能段一律照新正文写。她那几条偏好照样跟着
   * (那一条在 `server-prompt-prefs.test.ts` 里钉)。
   */
  it('wbOpsSkillsApply(切模板 / 发版升级):技能正文照新默认写', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '# 事务官\n', 'utf8')
    const store = await freshStore(dir)
    expect((await store.save('用说话改布局', '# 用说话改布局\n\n我自己写的版本')).ok).toBe(false)
    installPromptOverrides(store)
    const done = await wbOpsSkillsApply(deps(), {
      file,
      templateId: 'ops',
      readDoc: async skill => `# ${skill.name}\n\n> 说明\n\n默认正文`,
    })
    expect(done.ok).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(readMarkedBlock(text, '用说话改布局')).toContain('默认正文')
    expect(readMarkedBlock(text, CONFIRM_SKILL_NAME)).toContain('默认正文')
  })
})

describe('设置页那一条接口', () => {
  async function service(dir: string, agents: string) {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, agents, 'utf8')
    const store = await freshStore(dir)
    installPromptOverrides(store)
    return {
      file,
      store,
      svc: createPromptsService({
        store,
        agentsFile: file,
        deps: deps(),
        skills: () => [{ name: '用说话改布局', summary: '说一句就改' }],
      }),
    }
  }

  it('列出每一段:名字、说话方式、称呼、规矩、技能段、段外「我的补充」', async () => {
    const dir = tempDir()
    const { svc } = await service(dir, [
      '我叫 小助。',
      '',
      '# 事务官',
      '',
      '随手写的几句(段外)。',
      '',
      '<!-- 引导:说话方式:开始 -->',
      '## 说话方式',
      '- 人设:沉稳',
      '<!-- 引导:说话方式:结束 -->',
      '',
      '<!-- 引导:规矩:开始 -->',
      '- 界面不要蓝',
      '<!-- 引导:规矩:结束 -->',
      '',
    ].join('\n'))
    const view = await svc.view()
    const names = view.basics.map(one => one.name)
    expect(names).toContain(PROMPT_NAME_SECTION)
    expect(names).toContain(SPEAKING_STYLE_BLOCK)
    expect(names).toContain('规矩')
    expect(names).toContain(PROMPT_EXTRA_SECTION)
    // 人话那几项每项都带一个例子(2026-10-02)。
    expect(view.basics.find(one => one.name === SPEAKING_STYLE_BLOCK)?.example).toBeDefined()
    expect(view.basics.find(one => one.name === PROMPT_NAME_SECTION)?.body).toBe('小助')
    expect(view.basics.find(one => one.name === SPEAKING_STYLE_BLOCK)?.body).toContain('人设:沉稳')
    // 规矩有唯一的编辑入口(设置里「记住的规矩」),这一页只读 + 指过去。
    const rules = view.basics.find(one => one.name === '规矩')
    expect(rules?.editable).toBe(false)
    expect(rules?.elsewhere).toBeDefined()
    // 技能段不在人话那一栏里,它在页底那一摊只读地摆着。
    expect(names).not.toContain('用说话改布局')
    const manual = view.manual.find(one => one.name === '用说话改布局')
    expect(manual?.editable).toBe(false)
    expect(manual?.manual).toBeDefined()
    // 段外那几句看得见(只读),改不动。
    expect(view.outside).toContain('随手写的几句(段外)')
  })

  it('保存即重写那一段,并说明电话下一通生效', async () => {
    const dir = tempDir()
    const { svc, file } = await service(dir, '我叫 小助。\n\n# 事务官\n\n<!-- 引导:说话方式:开始 -->\n## 说话方式\n- 人设:沉稳\n<!-- 引导:说话方式:结束 -->\n')
    const done = await svc.save({ name: SPEAKING_STYLE_BLOCK, body: '## 说话方式\n- 说话像朋友' })
    expect(done.ok).toBe(true)
    expect(done.ok ? done.note : '').toContain('下一通')
    expect(readMarkedBlock(readFileSync(file, 'utf8'), SPEAKING_STYLE_BLOCK)).toBe('## 说话方式\n- 说话像朋友')
    const view = await svc.view()
    expect(view.basics.find(one => one.name === SPEAKING_STYLE_BLOCK)?.overridden).toBe(true)
  })

  it('改名字改的是首行,段外一个字不动', async () => {
    const dir = tempDir()
    const { svc, file } = await service(dir, '我叫 小助。\n\n# 事务官\n\n段外的话。\n')
    expect((await svc.save({ name: PROMPT_NAME_SECTION, body: '阿九' })).ok).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.split('\n')[0]).toBe('我叫 阿九。')
    expect(text).toContain('段外的话。')
  })

  it('恢复默认把那一段写回默认', async () => {
    const dir = tempDir()
    const { svc, file } = await service(dir, '我叫 小助。\n\n<!-- 引导:说话方式:开始 -->\n默认那一份\n<!-- 引导:说话方式:结束 -->\n')
    await svc.save({ name: SPEAKING_STYLE_BLOCK, body: '我的那一份' })
    expect((await svc.reset(SPEAKING_STYLE_BLOCK)).ok).toBe(true)
    expect(readMarkedBlock(readFileSync(file, 'utf8'), SPEAKING_STYLE_BLOCK)).toBe('默认那一份')
  })

  it('不可改清单那一段:只读,说明为什么', async () => {
    const dir = tempDir()
    const { svc } = await service(dir, `我叫 小助。\n\n<!-- 引导:${CONFIRM_SKILL_NAME}:开始 -->\n默认\n<!-- 引导:${CONFIRM_SKILL_NAME}:结束 -->\n`)
    const view = await svc.view()
    const row = view.manual.find(one => one.name === CONFIRM_SKILL_NAME)
    expect(row?.editable).toBe(false)
    expect(row?.locked).toContain('不可改清单')
    const denied = await svc.save({ name: CONFIRM_SKILL_NAME, body: '改一句' })
    expect(denied.ok).toBe(false)
  })

  it('撤到上一版也把文件写回去', async () => {
    const dir = tempDir()
    const { svc, file } = await service(dir, '我叫 小助。\n\n<!-- 引导:说话方式:开始 -->\n默认\n<!-- 引导:说话方式:结束 -->\n')
    await svc.save({ name: SPEAKING_STYLE_BLOCK, body: '第一版' })
    await svc.save({ name: SPEAKING_STYLE_BLOCK, body: '第二版' })
    expect((await svc.undo(SPEAKING_STYLE_BLOCK)).ok).toBe(true)
    expect(readMarkedBlock(readFileSync(file, 'utf8'), SPEAKING_STYLE_BLOCK)).toBe('第一版')
  })
})
