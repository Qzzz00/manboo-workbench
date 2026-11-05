/**
 * **新首次引导:最多 5 问**(2026-09-27,卡 OB;统筹按维护者 19:55 授权定)。
 *
 * 现场(全新 MacBook Air,macOS 15.7.3,0.4.50,机器上只有豆包办公与 Codex,**没有 Claude、没有 Kimi**):
 * 电脑文字引导走了 15 问、11 分钟,其中
 *   ① 「读文件」那一步照样问「Claude、Codex、Kimi 里它们自己记的东西」—— 前后两家这台机器上根本没装;
 *      他说「我电脑上没有 Claude 和 kimi」,她回「那我就先按不可以来」,把**纠正名单**当成了拒绝;
 *   ② 他在分岔选的是「从一个新点子开始」,她却说「照你在 Codex 和豆包里跟这件事有关的对话来写」,
 *      他回「?是从零开始啊喂」;
 *   ③ 他连说「你好啰嗦啊」「快点让开」「我怎么还没进页面」,她仍依次问了音乐、性格、取名。
 *
 * 这一份钉的是三件事,**都由代码算好、模型只念**:
 *   A 名单只列本机真装了且真有记录可读的那几家(一家都没有就整问不问);
 *   B 新点子那一支不出现「已有事项」的话术,⑤ 那一问根本不排进计划;
 *   C 他喊停(词表判)→ 剩下的按默认落盘,阶段直接到「完成」。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { FIRSTRUN_CLOSING_LINE, factLines, firstMessage, requiredKeys, stageDef } from '../src/server/onboardingStages.ts'
import { wantsToSkipRest } from '../src/server/onboardingConsent.ts'
import { PRODUCT_TEMPLATE, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const ops = await loadStarterLayoutTemplate()
beforeAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ops],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === ops.id ? ops : undefined),
  })
})
afterAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
  })
})

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

/** 这台机器上探到的那几家:`probe` 是各家记录的份数,`installed` 是应用探测。 */
interface Machine {
  probe?: readonly { family: string, label: string, count: number, left: readonly string[], skip?: string }[]
  installed?: readonly string[]
}

/** 只有豆包办公 + Codex 的那台新 Air:Claude / Kimi 一份记录都没有,应用也没装。 */
const AIR: Machine = {
  probe: [
    { family: 'claude', label: 'Claude', count: 0, left: [] },
    { family: 'codex', label: 'Codex', count: 2, left: [] },
    { family: 'kimi', label: 'Kimi', count: 0, left: [] },
    { family: 'dsh', label: '工作台', count: 1, left: [], skip: '这一份本来就是事务官自己的' },
  ],
  installed: ['codex', 'doubao', 'wechat', 'term', 'calendar'],
}

/** 一家可读的都没有(全新机器,连 Codex 的 AGENTS.md 都还没有)。 */
const BARE: Machine = { probe: (AIR.probe ?? []).map(one => ({ ...one, count: one.family === 'dsh' ? 1 : 0 })), installed: ['doubao'] }

async function service(machine: Machine = AIR) {
  const root = mkdtempSync(join(tmpdir(), 'wb-firstrun-0927-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const enabled: string[] = []
  let tick = 0
  const svc = createOnboardingService({
    // plan 不传 = 新骨架(这一份钉的就是它)。
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date(Date.UTC(2026, 8, 27, 11, 0, tick++)),
    ...(machine.probe === undefined ? {} : { memories: { importAll: async () => ({ written: [], index: [], line: '拷过来了:Codex 2 份。' }), probeAll: async () => machine.probe ?? [] } }),
    ...(machine.installed === undefined
      ? {}
      : {
          apps: {
            installed: () => [...(machine.installed ?? [])],
            known: async () => [
              { key: 'codex', label: 'Codex' },
              { key: 'doubao', label: '豆包办公' },
              { key: 'claude', label: 'Claude' },
            ],
            enable: async (keys: readonly string[]) => { enabled.push(...keys); return { enabled: [...keys], already: [], unknown: [] } },
          },
        }),
  })
  await svc.load()
  return { svc, repo, enabled }
}

async function ok(svc: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await svc.answer({ stage, key, value })
  if (!result.ok) throw new Error(`${stage}.${key}:${result.error}`)
  return result
}

describe('骨架:最多 5 问(2026-09-27)', () => {
  it('已有 + 做产品 + 本机有 Codex 的记录 → 称呼 / 分岔 / 布局 / 一句话 / 读记录,第五问答完就完事', async () => {
    const { svc } = await service()
    expect(svc.view().steps).toBe(5)
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    await ok(svc, 'template', 'template', 'product')
    // ④ 一句话:**只这一项**,不再要 done、不再问截止日
    expect(requiredKeys('projects', 'existing', 'product', undefined, { firstrun: true, memoryFamilies: ['Codex'] })).toEqual(['project'])
    const four = await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官' })
    expect(four.stage).toBe('authorization')
    const last = await ok(svc, 'authorization', 'read_client_files', false)
    expect(last.done).toBe(true)
    expect(last.closing).toBe(FIRSTRUN_CLOSING_LINE)
    // 旧的授权补全 / 习惯 / 人设 / 取名 / 收尾一问都没问过
    expect(svc.view().stage).toBe('done')
  })

  it('新点子那一支:⑤ 读记录整个不排进计划(共 4 问),一句话就立项', async () => {
    const { svc, repo } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'fresh')
    expect(svc.view().steps).toBe(4)
    await ok(svc, 'template', 'template', 'product')
    // 一句话就收:problem / assets / first_step / stage 都还没聊到也照收(以前缺一项就 400)
    const four = await ok(svc, 'projects', 'idea', { name: '晨读机', one_liner: '每天早上给我读十分钟' })
    expect(four.done).toBe(true)
    expect(four.closing).toBe(FIRSTRUN_CLOSING_LINE)
    const file = await readFile(join(repo, 'docs', '记忆', '项目', '晨读机.md'), 'utf8')
    // 没聊到的那几项**整行不写**,不编一句
    expect(file).toContain('每天早上给我读十分钟')
    expect(file).not.toContain('目标:undefined')
  })

  it('运营模板 + 新点子:一句话问「你想做个什么号」,再追一句平台;⑤ 照样不问', async () => {
    const { svc } = await service()
    await ok(svc, 'opening', 'nickname', '小鱼')
    await ok(svc, 'branch', 'mode', 'fresh')
    const def = stageDef('projects', 'fresh', 'ops', undefined, { firstrun: true, memoryFamilies: ['Codex'] })
    expect(def.seed).toBe('你想做个什么号?一句话就行。')
    expect(def.goals.join('\n')).toContain('发在哪个平台')
    expect(Object.keys(def.keys)).toEqual(['account'])
  })

  it('已有 + 本机一家可读的 AI 都没有 → ⑤ 也不问(共 4 问),一个家名都不出现', async () => {
    const { svc } = await service(BARE)
    await ok(svc, 'opening', 'nickname', 'Ben')
    const after = await ok(svc, 'branch', 'mode', 'existing')
    expect(svc.view().steps).toBe(4)
    expect(JSON.stringify(after.next)).not.toContain('Claude')
    expect(JSON.stringify(after.next)).not.toContain('Kimi')
    await ok(svc, 'template', 'template', 'product')
    const four = await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官' })
    expect(four.done).toBe(true)
  })
})

describe('A 读记录那一问:名单只认本机探测(卡 OB 现场第 1 条)', () => {
  it('⑤ 那一段的种子句与要弄清的东西里只有 Codex —— 没装的 Claude、Kimi 一个字都不出现', async () => {
    const { svc } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    await ok(svc, 'template', 'template', 'product')
    await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官' })
    const brief = await svc.brief()
    expect(brief.memory_families).toEqual(['Codex'])
    const said = [brief.seed ?? '', ...brief.goals].join('\n')
    expect(said).toContain('Codex')
    expect(said).not.toContain('Claude')
    expect(said).not.toContain('Kimi')
    // 「看板上每件事做到哪了」那一问不在引导里(用到时另问,progress.ts 的 ACCESS_QUESTION)
    expect(brief.keys.map(key => key.name)).toEqual(['read_client_files', 'import_memories'])
  })

  it('塞给模型的第一条消息里,「本机有哪几家」「他选了哪一支」都是代码算好的事实', async () => {
    const existing = firstMessage({
      stage: 'authorization', mode: 'existing', baseUrl: 'http://127.0.0.1:8791', answered: {}, resumed: false,
      facts: { firstrun: true, memoryFamilies: ['Codex'] },
    })
    expect(existing).toContain('这台电脑上装了、而且真有记录可读的 AI 只有:Codex')
    expect(existing).not.toContain('Kimi')
    const fresh = firstMessage({
      stage: 'projects', mode: 'fresh', baseUrl: 'http://127.0.0.1:8791', answered: {}, resumed: false,
      facts: { firstrun: true, memoryFamilies: [] },
    })
    expect(fresh).toContain('他在分岔选的是「从一个新点子开始」')
    expect(fresh).toContain('不提')
    expect(fresh).not.toContain('Claude')
  })

  it('factLines:探过了一家都没有 → 明说一个家名都别提;没探过 → 整行不出现(不冒充「一家都没装」)', () => {
    expect(factLines({ facts: { memoryFamilies: [] } }).join('\n')).toContain('一个家名都别提')
    expect(factLines({ facts: {} })).toEqual([])
    expect(factLines({ mode: 'existing' }).join('\n')).toContain('已经有在做的事')
  })

  it('探不到(这台工作台没接探测这一档)→ 名单缺席,话术退回老字面量,不假装探过', async () => {
    const { svc } = await service({ installed: ['codex'] })
    await ok(svc, 'opening', 'nickname', 'Ben')
    const brief = await svc.brief()
    expect(brief.memory_families).toBeUndefined()
  })
})

describe('C 他喊停就收(卡 OB 现场第 3 条:「快点让开」「我怎么还没进页面」)', () => {
  it('词表:现场那几句都判得出来;正常回答判不出来', () => {
    for (const said of ['你好啰嗦啊', '都行,快点让开', '我让你走开啊', '半天了我怎么还没进页面啊', '跳过', '别问了']) {
      expect(wantsToSkipRest(said)).toBe(true)
    }
    for (const said of ['产品研发', '我叫 Ben', '没有了', '都行']) expect(wantsToSkipRest(said)).toBe(false)
  })

  it('喊停:剩下的按默认落盘 → 阶段到「完成」,回那一句;他的内容一个字都不编', async () => {
    const { svc, repo, enabled } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    const skipped = await svc.skipRest('快点让开')
    expect(skipped.done).toBe(true)
    expect(skipped.line).toBe(FIRSTRUN_CLOSING_LINE)
    expect(svc.view().stage).toBe('done')
    const detail = svc.detail()
    // 默认落盘的那几项(授权三项、人设、名字)
    expect(detail.answered.authorization).toContain('write_docs')
    expect(detail.answered.persona).toContain('persona')
    expect(detail.answered.naming).toContain('butler_name')
    // 他没说过的内容一项都没编出来
    expect(detail.answered.projects ?? []).not.toContain('project')
    const auth = await readFile(join(repo, 'docs', '记忆', '授权.md'), 'utf8')
    expect(auth).toContain('write_docs')
    // 窗位槽:本机探到的那几家 AI 自动放进去(豆包办公认得出)
    expect(enabled).toContain('codex')
    expect(enabled).toContain('doubao')
  })

  it('电话 / 手机那一路:他那句话带在 heard 里,同一份词表判,同样立刻收', async () => {
    const { svc } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    const result = await svc.answer({
      stage: 'branch', key: 'mode', value: 'existing',
      heard: { asked: '你现在是已经有在做的事,还是想从一个新点子开始?', reply: '别问了,快点让我进去' },
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.done).toBe(true)
    expect(svc.view().stage).toBe('done')
  })
})

describe('重新做一遍引导(2026-09-27,维护者:「桌面端估计得给我一个初始化的按钮」)', () => {
  it('restart all:回到第一段、段数按新骨架算;项目文件、记忆文件夹一个都没删', async () => {
    const { svc, repo } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    await ok(svc, 'template', 'template', 'product')
    await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官' })
    await ok(svc, 'authorization', 'read_client_files', false)
    expect(svc.view().done).toBe(true)
    const projectFile = join(repo, 'docs', '记忆', '项目', '工作台.md')
    const before = await readFile(projectFile, 'utf8')

    const back = await svc.restart('all')
    expect(back.stage).toBe('opening')
    const view = svc.view()
    expect(view.stage).toBe('opening')
    expect(view.done).toBe(false)
    expect(view.step).toBe(1)
    // 新骨架的段数(称呼 / 分岔 / 布局 / 一句话 / 读记录),不是老骨架那九段
    expect(view.steps).toBe(5)
    expect(svc.detail().answered.opening ?? []).toEqual([])
    // 数据一个都不删
    expect(await readFile(projectFile, 'utf8')).toBe(before)
    expect(await readFile(join(repo, 'docs', '记忆', '授权.md'), 'utf8')).toContain('write_docs')
  })
})
