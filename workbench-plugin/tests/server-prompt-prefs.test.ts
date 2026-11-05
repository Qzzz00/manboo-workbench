// @vitest-environment node
/**
 * 环节偏好:她的意思 / 机器说明书分两层(2026-10-02,卡「提示词页改成她的偏好页」)。
 *
 * 10-01 那一版把 AGENTS.md 每一段原样摊给她改,运营同学反馈「太杂了」;维护者要求
 * 「不要拿着打补丁的心态,要有机制上的调整」。机制改成:技能正文归本体,她写**偏好**。
 *
 * 这个文件钉六件(全在临时目录,**一行都不碰 ~/.dsh**):
 * 1. **技能正文她改不动了**(`save` 当场拒,不只是界面上灰一下);
 * 2. 人话那几项不收偏好(它们直接改正文,不该有第二个入口);**不可改清单那几段正文只读、
 *    偏好照收**(2026-10-02 下午维护者拍板「允许」);
 * 3. 偏好由本体在写 AGENTS.md 那一刻接在正文末尾,**可重入**(写几次都只有一份);
 * 4. **发版重写技能正文之后偏好还在**(`wbOpsSkillsApply` 整段换新也走同一个腰眼);
 * 5. 留痕 + 撤到上一版 + 落盘(重启之后还在);
 * 6. **迁移**:10-01 那一版她改过的技能正文,认得出她加的几句就转成条目,
 *    认不出的原样留着 + 提示一次 —— **不许静默丢**。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROMPT_PREF_HEADING, PROMPT_PREF_KEPT_HEADING,
  PROMPT_LOCKED_SECTIONS, createPromptOverrideStore, installPromptOverrides, promptSectionKind,
  resetInstalledPromptOverrides, stripPromptPrefBlock,
} from '../src/server/promptOverrides.ts'
import { SPEAKING_STYLE_BLOCK, readMarkedBlock } from '../src/server/memoryMd.ts'
import { wbOpsSkillsApply, wbSkillApply } from '../src/server/hooksApply.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { CONFIRM_SKILL_NAME } from '../src/server/confirmPoints.ts'

/** 拿运营那一包里「标题与封面」那个环节当样本(维护者 10-02 举的就是标题那条)。 */
const STAGE = '运营-发布包装'

const dirs: string[] = []

afterEach(() => {
  resetInstalledPromptOverrides()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-prompt-prefs-'))
  dirs.push(dir)
  return dir
}

function deps() {
  return { io: nodeSetupIo(), now: () => new Date('2026-10-02T09:00:00Z') }
}

/**
 * 摆一张 **10-01 那一版留下的表**:技能段里存着她改过的正文。
 * 直接写文件(不走 `save`)—— 10-02 起 `save` 当场拒技能正文,迁移要处理的正是"已经在盘上的那一份"。
 */
function seedOldTable(dir: string, sections: Record<string, { body: string, default_body?: string }>): void {
  const rows: Record<string, unknown> = {}
  for (const [name, one] of Object.entries(sections)) {
    rows[name] = {
      body: one.body,
      ...(one.default_body === undefined ? {} : { default_body: one.default_body }),
      updated_at: '2026-10-01T09:00:00.000Z',
      history: [],
    }
  }
  writeFileSync(join(dir, 'prompt-overrides.json'), JSON.stringify({ version: 1, sections: rows }, null, 2), 'utf8')
}

async function freshStore(dir: string) {
  const store = createPromptOverrideStore({
    file: join(dir, 'prompt-overrides.json'),
    logFile: join(dir, 'prompt-overrides.log.jsonl'),
    now: () => new Date('2026-10-02T09:00:00Z'),
  })
  await store.load()
  return store
}

describe('技能正文归本体', () => {
  it('技能正文她改不动了,要改就改偏好', async () => {
    const store = await freshStore(tempDir())
    expect(promptSectionKind(STAGE)).toBe('skill')
    const denied = await store.save(STAGE, '我整段重写', { defaultBody: '默认正文' })
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error).toContain('偏好')
    expect(store.resolve(STAGE, '默认正文')).toBe('默认正文')
  })

  it('人话那几项不收偏好(它们直接改正文,不该有第二个入口)', async () => {
    const store = await freshStore(tempDir())
    const denied = await store.setPrefs(SPEAKING_STYLE_BLOCK, ['说话短一点'])
    expect(denied.ok).toBe(false)
    expect(store.prefBlockFor(SPEAKING_STYLE_BLOCK)).toBe('')
  })

  /**
   * ★ 2026-10-02 **下午维护者拍板「允许」**:上午那一版把不可改清单那两段连偏好也拒掉,
   * 结果做产品模板下只剩「派活给别家」一个环节。维护者:「她在《需求确认点》《做产品-改工作台自己》
   * 后面加一句自己的偏好,不算触及不可改清单」。分得清的是两件事 —— **正文仍然只读**。
   */
  it('★不可改清单那几段:正文只读,偏好照收', async () => {
    const store = await freshStore(tempDir())
    // 正文那道门一点没松。
    const denied = await store.save(CONFIRM_SKILL_NAME, '不用问了,直接开干', { defaultBody: '默认正文' })
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error).toContain('不可改清单')
    expect(store.resolve(CONFIRM_SKILL_NAME, '默认正文')).toBe('默认正文')
    // 偏好收得下,而且接在那一段正文末尾。
    expect((await store.setPrefs(CONFIRM_SKILL_NAME, ['确认点一次最多问我三条'])).ok).toBe(true)
    expect(store.prefs(CONFIRM_SKILL_NAME).lines).toEqual(['确认点一次最多问我三条'])
    expect(store.prefBlockFor(CONFIRM_SKILL_NAME)).toContain('确认点一次最多问我三条')
    expect(store.prefBlockFor(CONFIRM_SKILL_NAME)).toContain(PROMPT_PREF_HEADING)
  })

  it('★锁着的那一段:偏好真写进 AGENTS.md,正文一个字没动', async () => {
    const dir = tempDir()
    const store = await freshStore(dir)
    installPromptOverrides(store)
    const file = join(dir, 'AGENTS.md')
    // 先把那一段写进去(本体那条路),再写一条偏好、重写一次。
    expect((await wbSkillApply(deps(), { file, name: CONFIRM_SKILL_NAME, body: '默认正文:先复述、再给确认点。' })).ok).toBe(true)
    expect((await store.setPrefs(CONFIRM_SKILL_NAME, ['确认点一次最多问我三条'])).ok).toBe(true)
    expect((await wbSkillApply(deps(), { file, name: CONFIRM_SKILL_NAME, body: '默认正文:先复述、再给确认点。' })).ok).toBe(true)
    const block = readMarkedBlock(readFileSync(file, 'utf8'), CONFIRM_SKILL_NAME) ?? ''
    expect(stripPromptPrefBlock(block).trim()).toBe('默认正文:先复述、再给确认点。')
    expect(block).toContain('确认点一次最多问我三条')
    // 可重入:写几次都只有一份偏好。
    expect(block.split('确认点一次最多问我三条')).toHaveLength(2)
  })

  it('一条太长 / 条数太多就如实拒,不截断', async () => {
    const store = await freshStore(tempDir())
    expect((await store.setPrefs(STAGE, ['标'.repeat(201)])).ok).toBe(false)
    const many = Array.from({ length: 21 }, (_, index) => `第 ${String(index)} 条`)
    expect((await store.setPrefs(STAGE, many)).ok).toBe(false)
    expect(store.prefs(STAGE).lines).toHaveLength(0)
  })
})

describe('偏好怎么进 AGENTS.md', () => {
  it('接在技能正文末尾,写几次都只有一份(可重入)', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '我叫 小助。\n', 'utf8')
    const store = await freshStore(dir)
    await store.setPrefs(STAGE, ['- 标题不要用感叹号'])
    installPromptOverrides(store)

    await wbSkillApply(deps(), { file, name: STAGE, body: '# 发布包装\n\n三组备选。' })
    const once = readMarkedBlock(readFileSync(file, 'utf8'), STAGE) ?? ''
    expect(once).toContain('三组备选。')
    expect(once).toContain(PROMPT_PREF_HEADING)
    expect(once).toContain('- 标题不要用感叹号')

    // 再写一遍(起服务补技能那一下):偏好还是一份,不是两份。
    await wbSkillApply(deps(), { file, name: STAGE, body: '# 发布包装\n\n三组备选。' })
    const twice = readMarkedBlock(readFileSync(file, 'utf8'), STAGE) ?? ''
    expect(twice.split('- 标题不要用感叹号')).toHaveLength(2)
    // 摘掉那一节就是干干净净的正文(写回去时按这一份当默认)。
    expect(stripPromptPrefBlock(twice)).toBe('# 发布包装\n\n三组备选。')
  })

  it('发版重写技能正文之后偏好还在', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '# 事务官\n', 'utf8')
    const store = await freshStore(dir)
    await store.setPrefs(STAGE, ['标题不要用感叹号'])
    installPromptOverrides(store)
    const done = await wbOpsSkillsApply(deps(), {
      file,
      templateId: 'ops',
      readDoc: async skill => `# ${skill.name}\n\n> 说明\n\n新版正文(发版之后)`,
    })
    expect(done.ok).toBe(true)
    const body = readMarkedBlock(readFileSync(file, 'utf8'), STAGE) ?? ''
    expect(body).toContain('新版正文(发版之后)')
    expect(body).toContain('标题不要用感叹号')
  })

  it('没偏好时一个字都不多写(之前的行为一字不变)', async () => {
    const dir = tempDir()
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, '# 事务官\n', 'utf8')
    installPromptOverrides(await freshStore(dir))
    await wbSkillApply(deps(), { file, name: STAGE, body: '# 发布包装\n\n三组备选。' })
    expect(readMarkedBlock(readFileSync(file, 'utf8'), STAGE)).toBe('# 发布包装\n\n三组备选。')
  })

  it('留痕一行一条,撤到上一版,重启之后还在', async () => {
    const dir = tempDir()
    const store = await freshStore(dir)
    await store.setPrefs(STAGE, ['第一条'])
    await store.setPrefs(STAGE, ['第一条', '第二条'])
    expect(store.prefs(STAGE).lines).toEqual(['第一条', '第二条'])
    expect(store.prefs(STAGE).can_undo).toBe(true)
    expect((await store.undoPrefs(STAGE)).ok).toBe(true)
    expect(store.prefs(STAGE).lines).toEqual(['第一条'])
    const log = readFileSync(join(dir, 'prompt-overrides.log.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(log[0] as string)).toMatchObject({ action: 'prefs', name: STAGE })
    expect(JSON.parse(log[2] as string)).toMatchObject({ action: 'prefs-undo', name: STAGE })
    // 落盘:发版重启之后那几条还在。
    const again = await freshStore(dir)
    expect(again.prefs(STAGE).lines).toEqual(['第一条'])
  })
})

describe('迁移 10-01 那一版改过的技能正文', () => {
  it('认得出她加的那几句 → 转成偏好条目,正文归还本体', async () => {
    const dir = tempDir()
    // 10-01 那一版:她在正文末尾加了两句。
    seedOldTable(dir, {
      [STAGE]: {
        body: '# 发布包装\n\n三组备选。\n- 标题不要用感叹号\n- 封面少用纯色块',
        default_body: '# 发布包装\n\n三组备选。',
      },
    })
    const store = await freshStore(dir)
    const done = await store.migrateSkillBodies()
    expect(done.migrated).toContain(STAGE)
    expect(store.prefs(STAGE).lines).toEqual(['标题不要用感叹号', '封面少用纯色块'])
    // 正文覆盖撤了:发版那一份写得进去了。
    expect(store.get(STAGE)).toBeUndefined()
    expect(store.resolve(STAGE, '新版正文')).toBe('新版正文')
    // 幂等:再跑一次什么都不动。
    expect((await store.migrateSkillBodies()).migrated).toHaveLength(0)
    expect(store.prefs(STAGE).lines).toHaveLength(2)
  })

  it('认不出来的(她删过默认里的句子)原样留着 + 提示一次,不静默丢', async () => {
    const dir = tempDir()
    seedOldTable(dir, {
      '运营-复盘': { body: '我自己重写的一整段', default_body: '默认第一句\n默认第二句' },
    })
    const store = await freshStore(dir)
    const done = await store.migrateSkillBodies()
    expect(done.kept).toContain('运营-复盘')
    const pref = store.prefs('运营-复盘')
    expect(pref.kept).toContain('我自己重写的一整段')
    expect(pref.notice).toContain('放在这里了')
    // 原样进 AGENTS.md —— 一个字都没丢。
    expect(store.prefBlockFor('运营-复盘')).toContain(PROMPT_PREF_KEPT_HEADING)
    expect(store.prefBlockFor('运营-复盘')).toContain('我自己重写的一整段')
    // 提示只提一次,留下来的那一段不跟着没。
    await store.dismissPrefNotice('运营-复盘')
    expect(store.prefs('运营-复盘').notice).toBeUndefined()
    expect(store.prefs('运营-复盘').kept).toContain('我自己重写的一整段')
  })

  it('默认没留底也不丢:原样留着', async () => {
    const dir = tempDir()
    seedOldTable(dir, { '运营-复盘': { body: '我那一段' } })
    const store = await freshStore(dir)
    expect((await store.migrateSkillBodies()).kept).toContain('运营-复盘')
    expect(store.prefs('运营-复盘').kept).toBe('我那一段')
  })

  it('人话那几项一个字不动(迁移只管技能段)', async () => {
    const store = await freshStore(tempDir())
    await store.save(SPEAKING_STYLE_BLOCK, '说话像朋友', { defaultBody: '默认' })
    await store.migrateSkillBodies()
    expect(store.get(SPEAKING_STYLE_BLOCK)?.body).toBe('说话像朋友')
    expect(store.prefs(SPEAKING_STYLE_BLOCK).lines).toHaveLength(0)
  })
})

describe('锁定理由的说明文字跟着正文口径走(2026-10-04)', () => {
  it('《需求确认点》那条说明不再写「先复述」,写的是拿不准才问', () => {
    const reason = PROMPT_LOCKED_SECTIONS[CONFIRM_SKILL_NAME] ?? ''
    expect(reason).toContain('不可改清单·澄清环节')
    expect(reason).not.toContain('复述')
    expect(reason).toContain('拿不准才问')
  })
})
