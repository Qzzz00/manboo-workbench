// @vitest-environment node
/**
 * 不在他正在用的那份仓库里切分支、改文件(2026-09-25,统筹给卡 O 补的一条)。
 *
 * 那天事务官在维护者的主 checkout 上 `git checkout -b fix/avatar-headroom`、改文件、发布,
 * 统筹紧接着往 main 提交的设计文档就落到了她那条分支上。这道门挂在 DSH `tools/pre-execute` 的最前面。
 * 全是纯函数:一条真命令都不跑。
 */
import { describe, expect, it } from 'vitest'
import type { GuardContext } from '../src/server/checkoutGuard.ts'
import { absolutePath, checkoutViolation, protectedRootOf } from '../src/server/checkoutGuard.ts'

const MAIN = '/Users/example/Documents/GitHub/desktop-workbench'
const OWN = '/Users/example/Documents/工作台'
const ctx: GuardContext = { protectedRoots: [MAIN, '/Users/example/Code/Echo'], ownRoots: [OWN], home: '/Users/example' }

describe('哪些路径算「他正在用的那份仓库」', () => {
  it('仓库根底下算;独立工作区(.worktrees / .claude/worktrees)不算;她自己的工作目录不算', () => {
    expect(protectedRootOf(`${MAIN}/workbench-plugin/src/a.ts`, ctx)).toBe(MAIN)
    expect(protectedRootOf(MAIN, ctx)).toBe(MAIN)
    expect(protectedRootOf(`${MAIN}/.claude/worktrees/fix-x/a.ts`, ctx)).toBeUndefined()
    expect(protectedRootOf(`${MAIN}/.worktrees/dispatch-eyes/a.ts`, ctx)).toBeUndefined()
    expect(protectedRootOf(`${OWN}/docs/记忆/a.md`, ctx)).toBeUndefined()
    expect(protectedRootOf('/Users/example/Documents/GitHub/desktop-workbench-2/a', ctx)).toBeUndefined()
    expect(absolutePath('~/x', undefined, '/Users/example')).toBe('/Users/example/x')
    expect(absolutePath('a/b', '/r', '/h')).toBe('/r/a/b')
  })
})

describe('git:动分支 / 动历史的拦,只读的放', () => {
  it('★那天那一下:cd 进他的仓库再 git checkout -b → 拦,话里说去哪做', () => {
    const reason = checkoutViolation('bash', { command: `cd ${MAIN} && git checkout -b fix/avatar-headroom` }, OWN, ctx)
    // 读的可能是事务官,也可能是他本人在 DSH 网页里直接用(统筹 ④):说清为什么、去哪做,不写「他」。
    expect(reason).toContain('为什么:这是你平时用的那份仓库')
    expect(reason).toContain('你直接在 DSH 网页里用时也一样拦')
    expect(reason).toContain('/feature/branch')
    expect(reason).toContain('/dispatch/run')
    expect(reason).toContain('请你自己在终端(不是 DSH)里做')
  })

  it('git -C、bash 的 workdir、会话 cwd 就在仓库里 —— 三种说法都认', () => {
    expect(checkoutViolation('bash', { command: `git -C ${MAIN} switch main` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: 'git commit -am wip', workdir: MAIN }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: 'git reset --hard HEAD~1' }, MAIN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: 'git branch -D old' }, MAIN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: `cd /Users/example/Code/Echo; git pull` }, OWN, ctx)).toBeDefined()
  })

  it('只读的、开独立工作区的放行;在独立工作区里切分支放行(`repoRootOf` 缺席时的老行为,卡 BS2 那道门见下)', () => {
    expect(checkoutViolation('bash', { command: `cd ${MAIN} && git status && git log -3 && git diff --stat` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `git -C ${MAIN} worktree add ${MAIN}/.claude/worktrees/x -b feat/x` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `git -C ${MAIN} branch --list` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `cd ${MAIN}/.claude/worktrees/x && git checkout -b feat/y && git commit -am y` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: 'git checkout -b mine' }, OWN, ctx)).toBeUndefined()
  })
})

describe('写文件:往他那份仓库里写的拦', () => {
  it('write / edit / apply_patch 的目标路径', () => {
    expect(checkoutViolation('edit', { file_path: `${MAIN}/workbench-plugin/src/client/Orb.tsx`, old_string: 'a', new_string: 'b' }, OWN, ctx)).toContain('改文件')
    expect(checkoutViolation('write', { file_path: 'src/a.ts', content: 'x' }, MAIN, ctx)).toBeDefined()
    expect(checkoutViolation('apply_patch', { input: `*** Begin Patch\n*** Update File: ${MAIN}/README.md\n@@\n-a\n+b\n*** End Patch` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('write', { file_path: `${OWN}/docs/记忆/项目.md`, content: 'x' }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('write', { file_path: `${MAIN}/.claude/worktrees/x/a.ts`, content: 'x' }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('str_replace_editor', { command: 'view', path: `${MAIN}/README.md` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('read', { file_path: `${MAIN}/README.md` }, OWN, ctx)).toBeUndefined()
  })

  it('bash 里的重定向、tee、sed -i、cp / mv / rm 落在他那份仓库里的', () => {
    expect(checkoutViolation('bash', { command: `echo hi > ${MAIN}/x.txt` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: `cat a | tee ${MAIN}/b` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: `sed -i '' 's/a/b/' ${MAIN}/c.ts` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: `cp /tmp/a ${MAIN}/a` }, OWN, ctx)).toBeDefined()
    expect(checkoutViolation('bash', { command: `rm ${MAIN}/a` }, OWN, ctx)).toBeDefined()
    // 读他的仓库、往临时目录写:放行
    expect(checkoutViolation('bash', { command: `cat ${MAIN}/README.md > /tmp/readme.txt` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `cp ${MAIN}/a /tmp/a` }, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `ls ${MAIN} 2>/dev/null` }, OWN, ctx)).toBeUndefined()
  })

  it('没有受保护的仓库、参数读不懂:一律放行(第一道门仍是 DSH 的沙箱)', () => {
    expect(checkoutViolation('bash', { command: `cd ${MAIN} && git checkout x` }, OWN, { protectedRoots: [], home: '/Users/example' })).toBeUndefined()
    expect(checkoutViolation('bash', undefined, OWN, ctx)).toBeUndefined()
    expect(checkoutViolation('web_fetch', { url: 'https://x' }, OWN, ctx)).toBeUndefined()
  })
})

/**
 * ★ 2026-09-28,卡 BS2(设计第五节第 1 道门;决策记录同日 15:5x「按你建议的来」第 6 条):
 * **事务官会话里凡 git 仓库一律只读**(含独立工作区、含她自己的项目),外加**拦构建 / 测试 / 包管理命令**。
 * 卡片那件 37 万字思考就是她在一个 worktree 里自己改代码改出来的 —— 前一版明确放行了那里。
 */
describe('★凡 git 仓库一律只读(卡 BS2)', () => {
  const ECHO = '/Users/example/Code/Echo'
  const HERS = '/Users/example/Projects/她自己的小站'
  /** 往上找 `.git`:这几处是仓库根。 */
  const repos = [MAIN, `${MAIN}/.claude/worktrees/fix-x`, ECHO, HERS]
  const repoCtx: GuardContext = {
    ...ctx,
    repoRootOf: (path: string) => [...repos].sort((a, b) => b.length - a.length).find(root => path === root || path.startsWith(`${root}/`)),
  }

  it('独立工作区里改文件、切分支、提交 —— 现在一样拦,话里说「这是派出去的活」', () => {
    const write = checkoutViolation('write', { file_path: `${MAIN}/.claude/worktrees/fix-x/a.ts`, content: 'x' }, OWN, repoCtx)
    expect(write).toContain('凡 git 仓库一律只读')
    expect(write).toContain('这是派出去的活')
    expect(write).toContain('/dispatch/run')
    expect(write).toContain('/dispatch/choices')
    expect(checkoutViolation('bash', { command: 'git checkout -b feat/y && git commit -am y' }, `${MAIN}/.claude/worktrees/fix-x`, repoCtx)).toContain('凡 git 仓库一律只读')
  })

  it('她自己的项目(没登记进 protectedRoots 的那个仓库)也拦', () => {
    expect(checkoutViolation('edit', { file_path: `${HERS}/src/a.ts`, old_string: 'a', new_string: 'b' }, OWN, repoCtx)).toContain('凡 git 仓库一律只读')
    expect(checkoutViolation('bash', { command: `echo x > ${HERS}/b.txt` }, OWN, repoCtx)).toBeDefined()
  })

  it('他那份 checkout 照旧念原来那一句(更具体:去哪开独立工作区);她自己的工作目录照旧写得动', () => {
    expect(checkoutViolation('write', { file_path: `${MAIN}/a.ts`, content: 'x' }, OWN, repoCtx)).toContain('为什么:这是你平时用的那份仓库')
    expect(checkoutViolation('write', { file_path: `${OWN}/docs/记忆/项目.md`, content: 'x' }, OWN, repoCtx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: 'git commit -am 记一笔' }, OWN, repoCtx)).toBeUndefined()
  })

  it('不在任何仓库里的(临时目录)照旧放行;仓库里只读的命令照旧放行', () => {
    expect(checkoutViolation('write', { file_path: '/tmp/a.txt', content: 'x' }, OWN, repoCtx)).toBeUndefined()
    expect(checkoutViolation('bash', { command: `cd ${MAIN} && git status && git diff` }, OWN, repoCtx)).toBeUndefined()
    expect(checkoutViolation('read', { file_path: `${ECHO}/README.md` }, OWN, repoCtx)).toBeUndefined()
  })
})

describe('★构建 / 测试 / 包管理命令一律拦,不看在哪个目录(卡 BS2)', () => {
  const only: GuardContext = { protectedRoots: [], home: '/Users/example' }

  it('认得出这几类,话里说「这是派出去的活」并给派活口', () => {
    for (const command of [
      'pnpm install', 'pnpm -C workbench-plugin test', 'npm run build', 'yarn build', 'npx tsc --noEmit',
      'vitest run tests/a.test.ts', 'tsc --noEmit', 'vite build', 'make', 'cmake --build .',
      'cargo test', 'go build ./...', 'swift build', 'xcodebuild -scheme A', './gradlew assemble', 'mvn -q test',
      'pytest -q', 'python -m pytest', 'eslint .',
    ]) {
      const reason = checkoutViolation('bash', { command }, '/tmp', only)
      expect(reason, command).toContain('这是派出去的活')
      expect(reason, command).toContain('不归事务官做')
    }
  })

  it('前缀(env 赋值、sudo、time)与 `cd x &&` 后面那一段也认', () => {
    expect(checkoutViolation('bash', { command: 'CI=1 pnpm test' }, '/tmp', only)).toBeDefined()
    expect(checkoutViolation('bash', { command: 'cd /tmp/x && pnpm build' }, '/tmp', only)).toBeDefined()
    expect(checkoutViolation('bash', { command: 'time npm ci' }, '/tmp', only)).toBeDefined()
  })

  it('不是构建的放行:`go version`、只读命令、看文件', () => {
    expect(checkoutViolation('bash', { command: 'go version' }, '/tmp', only)).toBeUndefined()
    expect(checkoutViolation('bash', { command: 'node -e "console.log(1)"' }, '/tmp', only)).toBeUndefined()
    expect(checkoutViolation('bash', { command: 'ls -la && cat a.txt' }, '/tmp', only)).toBeUndefined()
  })
})
