// @vitest-environment node
/**
 * 发版闸 + 每版顺手打源码包(2026-10-03,维护者拍板 ①②,见 `docs/决策记录.md`「2026-10-03 早」)。
 *
 * ## 为什么有这一份
 *
 * 0.4.87 用例全绿、回环上另起的实例端到端通,装到维护者那台却启动即崩;而发版顺序是
 * **先推公网再升本机**,崩了才知道。从此 rsync 之前先走一道本机闸:装上 → 等 8791 回这个版本号
 * → 隔一拍读 `/state`。这一份钉的就是「那一道闸真的在 rsync 之前,而且不过就不推」。
 *
 * ## 这里什么是真的、什么是假的
 *
 * - **闸脚本(`deploy/local-install-gate.sh`)是真跑的**:一个 mktemp 出来的沙箱当 `~/.dsh`
 *   (`--dsh-home` 与 `HOME` 两处都指过去),自带 node 与 launchctl 是两个只记一行的假脚本
 *   (`--launchctl` 指过去 —— 真 launchctl 会把这台机器上跑着的工作台重启),
 *   8791 是这个进程里起的一台本地 http 服务器;
 * - **`deploy/publish-update.sh` 一次都没真跑过**。它会往公网 rsync 产物 —— 这一份只按正文与
 *   **行号**断言它的形状。唯一两条真跑的是「`--skip-local-check` 没给理由」那两条:
 *   它们在参数解析那一行就退出,一件产物都不构建、一个字节都不推。
 * - **真的 `~/.dsh` 一个字节不碰,真 launchctl 一次不发,一次都不打包发版。**
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DSH_LAUNCHD_LABEL, setupPaths } from '../src/server/setup/paths.ts'
import { SELF_SHIP_SKIP_LOCAL_CHECK } from '../src/server/selfUpdate.ts'
import { parseInstalled, serializeInstalled } from '../src/server/update/installed.ts'
import { REPO_ROOT } from './helpers/shippedScripts.ts'

const PUBLISH = join(REPO_ROOT, 'deploy', 'publish-update.sh')
const GATE = join(REPO_ROOT, 'deploy', 'local-install-gate.sh')
const KIT = join(REPO_ROOT, 'deploy', 'make-source-kit.sh')

const 发版脚本 = readFileSync(PUBLISH, 'utf8')
const 闸脚本 = readFileSync(GATE, 'utf8')
const 源码包脚本 = readFileSync(KIT, 'utf8')

/**
 * 第一条**真代码**里出现这段文字的行号(0 起;没有就 -1)。顺序断言用它。
 *
 * 跳过注释行:发版脚本的文件头本来就在讲这几样东西,而顺序要钉的是**跑起来的那几行**。
 */
function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex(line => !line.trimStart().startsWith('#') && line.includes(needle))
}

/** 两段真代码之间的那一截正文(用来断言「闸那一段里没有别的产物」)。 */
function between(text: string, from: string, to: string): string {
  const lines = text.split('\n')
  return lines.slice(lineOf(text, from), lineOf(text, to)).join('\n')
}

/* ─────────────────────────── 形状:闸在 rsync 之前 ─────────────────────────── */

describe('发版闸:在 rsync 之前,不过就不推', () => {
  it('两个脚本的语法都过(bash -n)', () => {
    for (const file of [PUBLISH, GATE, KIT]) {
      const got = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
      expect(got.status, `${file}\n${got.stderr}`).toBe(0)
    }
  })

  it('★闸那一段在「算完 sha256、写完清单」之后、**rsync 之前**', () => {
    const 算sha = lineOf(发版脚本, 'say "算 sha256,写清单"')
    const 闸 = lineOf(发版脚本, 'deploy/local-install-gate.sh')
    const 第一条rsync = 发版脚本.split('\n').findIndex(line => line.trimStart().startsWith('rsync -av'))
    expect(算sha).toBeGreaterThan(0)
    expect(闸).toBeGreaterThan(算sha)
    expect(第一条rsync).toBeGreaterThan(闸)
  })

  it('`--no-upload` 那一趟不过闸(它本来就一个字节不推;真跑发版脚本的那条用例走的就是它)', () => {
    // 早退那一句在闸之前 —— 顺序反了,`--no-upload` 的验收跑一次就会去装这台机器。
    const 早退 = lineOf(发版脚本, 'if [ "$UPLOAD" = "0" ]; then')
    expect(早退).toBeGreaterThan(0)
    expect(lineOf(发版脚本, 'deploy/local-install-gate.sh')).toBeGreaterThan(早退)
  })

  it('闸没过就 die(一个字节都不推),而且 die 那句话里有「没推」', () => {
    const 闸段 = 发版脚本.split('\n').slice(
      lineOf(发版脚本, 'deploy/local-install-gate.sh'),
      lineOf(发版脚本, 'deploy/local-install-gate.sh') + 4,
    ).join('\n')
    expect(闸段).toContain('die')
    expect(闸段).toContain('没推')
  })

  it('★闸只管插件:递过去的只有 plugin.tgz,别的几样一个都没提', () => {
    expect(发版脚本).toContain('--tgz "$STAGE/plugin.tgz"')
    // 闸那一段 = 从调它那一行到第一条 rsync 之间(都按真代码算)。
    const 闸段 = between(发版脚本, 'deploy/local-install-gate.sh', 'rsync -av')
    for (const 别的 of ['shell-app.zip', 'butler-server.tgz', 'channel-worker.tgz', 'app.apk']) {
      expect(闸脚本, `闸脚本里不该提 ${别的}`).not.toContain(别的)
      expect(闸段, `闸那一段里不该把 ${别的} 也装上`).not.toContain(别的)
    }
  })

  it('闸的三下按卡的口径:等 /update/check 的 current、再隔一拍读 /state', () => {
    expect(闸脚本).toContain('/update/check')
    expect(闸脚本).toContain('/state')
    // 最多 90 秒、再等 10 秒 —— 两个缺省值写在这儿(演练时拿参数改短)。
    expect(闸脚本).toContain('WAIT=90')
    expect(闸脚本).toContain('SETTLE=10')
    expect(闸脚本).toContain('BASE="http://127.0.0.1:${WORKBENCH_PORT:-8791}"')
    // 缺省就是真 launchctl;只有演练才指到假的那一份。
    expect(闸脚本).toContain('LAUNCHCTL="launchctl"')
  })
})

describe('--skip-local-check / --skip-apk-check:理由必填', () => {
  /** 真跑发版脚本,但只跑到参数解析那一行就退出(下面几条都不构建、不推)。 */
  function run(args: readonly string[]): { status: number | null, out: string } {
    const got = spawnSync('bash', [PUBLISH, ...args], { encoding: 'utf8', timeout: 20_000 })
    return { status: got.status, out: `${got.stdout ?? ''}${got.stderr ?? ''}` }
  }

  it('★`--skip-apk-check` 不给理由 / 理由那一格被下一个参数占了 —— 都拒,退出码非 0', () => {
    for (const args of [['--skip-apk-check'], ['--skip-apk-check', '--notes', '随便']]) {
      const got = run(args)
      expect(got.status, args.join(' ')).not.toBe(0)
      expect(got.out).toContain('理由')
    }
  })

  it('★`--skip-local-check` 不给理由 —— 拒绝,退出码非 0', () => {
    const got = run(['--skip-local-check'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('理由')
  })

  it('★理由那一格被下一个参数占了也算没给', () => {
    const got = run(['--skip-local-check', '--notes', '随便'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('理由')
  })

  it('给了理由:醒目地打一行,并在清单里 notes 旁边记一格 local_check_skipped', () => {
    expect(发版脚本).toContain('local_check_skipped')
    // notes 那一行与这一格紧挨着(「写进 latest.json 的 notes 旁边一格」)。
    expect(lineOf(发版脚本, '"local_check_skipped"')).toBe(lineOf(发版脚本, "printf '  \"notes\": %s,\\n'") + 1)
    expect(发版脚本).toContain('没在本机验过')
  })
})

/* ──────────── 形状:发完之后本机也走一遍真正的更新路(2026-10-03) ──────────── */

describe('发完之后本机按一次「立即更新」:在 rsync 之后,失败不算发版失败', () => {
  /** 本机更新路那一段 = 从那个函数定义到源码包那一行之间(都按真代码算)。 */
  const 本机更新段 = between(发版脚本, 'local_apply() {', 'deploy/make-source-kit.sh')

  it('★这一段在**公网推完之后**:闸只装插件,事务官后端 / 通话组件靠的是这一趟', () => {
    const 第一条rsync = 发版脚本.split('\n').findIndex(line => line.trimStart().startsWith('rsync -av'))
    const 本机更新 = lineOf(发版脚本, 'POST')
    expect(第一条rsync).toBeGreaterThan(0)
    expect(lineOf(发版脚本, 'local_apply() {')).toBeGreaterThan(第一条rsync)
    expect(本机更新).toBeGreaterThan(第一条rsync)
    // 闸(rsync 之前那一道)与这一趟(rsync 之后)是两件事,顺序不许反。
    expect(lineOf(发版脚本, 'local_apply() {')).toBeGreaterThan(lineOf(发版脚本, 'deploy/local-install-gate.sh'))
  })

  it('★默认带,`--no-local-apply` 可关', () => {
    expect(发版脚本).toContain('LOCAL_APPLY=1')
    expect(发版脚本).toContain('--no-local-apply) LOCAL_APPLY=0')
    expect(发版脚本).toContain('if [ "$LOCAL_APPLY" = "0" ]; then')
  })

  it('★按的就是 8791 那三条口:apply 起作业、job 盯进度、check 核「一样都不差了」', () => {
    expect(本机更新段).toContain('-X POST "$LOCAL_BASE/update/apply"')
    expect(本机更新段).toContain('"$LOCAL_BASE/update/job/$id"')
    expect(本机更新段).toContain('"$LOCAL_BASE/update/check"')
    expect(发版脚本).toContain('LOCAL_BASE="http://127.0.0.1:${WORKBENCH_PORT:-8791}"')
    // 作业忽然问不到 = 装完重启了,不是失败(更新最后一步就是重启)。
    expect(本机更新段).toContain('多半是装完重启了')
  })

  it('★它得真看见刚推上去的那一版才按 —— 取不到公网清单时手上那份是旧的,按下去装的是旧东西', () => {
    expect(本机更新段).toContain('if [ "$latest" != "$VERSION" ]; then')
    expect(本机更新段).toContain('这一趟不按更新')
  })

  it('★这一趟失败**只打印**:公网已经推完了,不许 die', () => {
    expect(本机更新段).not.toContain('die ')
    expect(本机更新段).not.toContain('die "')
    expect(发版脚本).toContain('不算发版失败')
  })

  it('★`--skip-local-check` 那一趟连这一段一起跳 —— 自改闭环的记录就靠这一条', () => {
    // 不跳的话:/feature/ship 第 ⑥ 步跑在工作台自己的进程里,这里按下去那一下重启
    // 会把它杀在第 ⑦ 步决策记录落盘之前(它自己的第 ⑧ 步在记录之后才按)。
    expect(发版脚本).toContain('elif [ -n "$SKIP_WHY" ]; then')
    expect(lineOf(发版脚本, 'elif [ -n "$SKIP_WHY" ]; then')).toBeGreaterThan(lineOf(发版脚本, 'local_apply() {'))
    expect(发版脚本).toContain('决策记录就写不成了')
  })

  it('`--no-upload` 那一趟压根走不到这一段(早退在它前面)', () => {
    expect(lineOf(发版脚本, 'local_apply() {')).toBeGreaterThan(lineOf(发版脚本, 'if [ "$UPLOAD" = "0" ]; then'))
    expect(发版脚本).toContain('也没在本机按更新')
  })
})

/* ───────── 形状:手机包必须是这会儿这份源码打的(2026-10-03,审计 C 条) ───────── */

describe('手机包指纹:不是这份源码打的就不发', () => {
  /** apk 那一段 = 从 `if want apk` 到下一节「算 sha256」之间(都按真代码算)。 */
  const apk段 = between(发版脚本, 'if want apk; then', 'say "算 sha256,写清单"')

  it('★从包里读它自己记的那行指纹,跟仓库里 butler-app 那棵树比', () => {
    // 0928 连发四版旧手机包:这里原来只看"文件在不在"。
    expect(apk段).toContain('unzip -p "$APK_SRC" assets/public/build.json')
    expect(apk段).toContain('butler_app_tree')
    expect(apk段).toContain('git rev-parse HEAD:butler-app')
  })

  it('★对不上就 die(一个字节都不推),话里把两个 id 都摆出来', () => {
    expect(apk段).toContain('if [ "$APK_TREE" != "$WANT_TREE" ]; then')
    expect(apk段).toContain('die "手机包不是这会儿这份源码打出来的')
    expect(apk段).toContain('$APK_TREE')
    expect(apk段).toContain('$WANT_TREE')
    // 核在 `cp` 之前:对不上的包连暂存目录都进不去。
    expect(lineOf(发版脚本, 'cp "$APK_SRC" "$STAGE/app.apk"'))
      .toBeGreaterThan(lineOf(发版脚本, 'git rev-parse HEAD:butler-app'))
  })

  it('★老包里压根没有那一份 build.json → 按「对不上」处理(不是"算了就这样吧")', () => {
    expect(apk段).toContain('if [ -z "$APK_TREE" ]; then')
    expect(apk段).toContain('没有构建指纹')
  })

  it('★`dirty: true` 也拒(统筹 10-03 午定):tree 与 HEAD 一致,可包里的字节不是那个 tree 的', () => {
    expect(apk段).toContain('if [ "$APK_DIRTY" = "dirty" ]; then')
    expect(apk段).toContain('有没提交改动')
    // 形状按 `butler-app/scripts/write-build-stamp.mjs` 那一处:三格,`dirty` 是布尔。
    expect(apk段).toContain('body.dirty === true')
  })

  it('`--skip-apk-check "<理由>"` 可跳过,理由记进清单紧挨着那两格', () => {
    expect(发版脚本).toContain('--skip-apk-check)')
    expect(发版脚本).toContain('apk_check_skipped')
    expect(lineOf(发版脚本, '"apk_check_skipped"')).toBe(lineOf(发版脚本, '"local_check_skipped"') + 1)
  })
})

/* ─────────────────────────── 形状:每版顺手打源码包 ─────────────────────────── */

describe('每版顺手打源码包', () => {
  it('★默认带,`--no-kit` 可关', () => {
    expect(发版脚本).toContain('KIT=1')
    expect(发版脚本).toContain('--no-kit) KIT=0')
    expect(发版脚本).toContain('deploy/make-source-kit.sh')
  })

  it('打在 rsync 之后(发版是正事,源码包不许挡着它)', () => {
    const 第一条rsync = 发版脚本.split('\n').findIndex(line => line.trimStart().startsWith('rsync -av'))
    expect(lineOf(发版脚本, 'deploy/make-source-kit.sh')).toBeGreaterThan(第一条rsync)
  })

  it('包名两边对得上,而且不上传(不是 `--with` 的一格,也不进 $STAGE)', () => {
    expect(源码包脚本).toContain('KIT_NAME="工作台源码包-$VERSION"')
    expect(发版脚本).toContain('工作台源码包-$VERSION.zip')
    // 产物进 dist/,不进 rsync 推的那个暂存目录,也不是清单里的一格。
    expect(发版脚本).not.toContain('$STAGE/工作台源码包')
    const pairs = /ASSET_PAIRS="([\s\S]*?)"/.exec(发版脚本)?.[1]
    expect(pairs).toBeDefined()
    // 「kit」按单词认:本机通话服务那一格叫 livekit_tgz(2026-10-21,卡 M1),不是源码包。
    expect(pairs).not.toMatch(/\bkit\b|source[-_]?kit/)
    expect(pairs).not.toContain('源码包')
  })

  it('源码包脚本自己最后就打印路径与 sha256(不用发版脚本再算一遍)', () => {
    expect(源码包脚本).toContain("printf '\\n✓  打好了:%s(%s)\\n'")
    expect(源码包脚本).toContain("info \"sha256:$(shasum -a 256 \"$ZIP\" | awk '{print $1}')\"")
  })
})

/* ─────────────────────── 兄弟路:自改闭环那一下发版 ─────────────────────── */

describe('兄弟路:「改工作台自己」那条闭环的第 ⑥ 步', () => {
  const 接线 = readFileSync(join(REPO_ROOT, 'workbench-plugin', 'src', 'index.ts'), 'utf8')

  it('★它带 --skip-local-check:那一下跑在工作台自己的进程里,闸里的重启会把它杀在记录之前', () => {
    // 不带的话:第 ⑥ 步装上新插件 + kickstart → 这条 /feature/ship 请求当场死 →
    // 第 ⑦ 步的决策记录与进化日志永远写不成(server-self-ship 那一份钉的就是这个顺序)。
    expect(接线).toContain("'--skip-local-check', SELF_SHIP_SKIP_LOCAL_CHECK")
    // 理由不是一句敷衍,而且**真能过发版脚本那道「理由必填」**(不以 - 开头、不为空)。
    expect(SELF_SHIP_SKIP_LOCAL_CHECK.length).toBeGreaterThan(10)
    expect(SELF_SHIP_SKIP_LOCAL_CHECK.startsWith('-')).toBe(false)
    expect(SELF_SHIP_SKIP_LOCAL_CHECK).toContain('第⑧步')
  })
})

/* ─────────────────────── 闸脚本:路径与本体同一处出处 ─────────────────────── */

describe('闸脚本:装法与本体那条路对得上', () => {
  // 与 source-kit-guard 同一个做法:把 paths.ts 的算法跑一遍,拿「相对 ~/.dsh 的那一段」比脚本正文。
  const paths = setupPaths({ home: '/H', dshHome: '/H/.dsh' })
  const 去掉前缀 = (full: string): string => full.replace('/H/.dsh/', '')

  it('★自带 node 是 `node/bin/node`(`~/.dsh/node` 是目录,不是二进制)', () => {
    expect(去掉前缀(paths.nodeBin)).toBe('node/bin/node')
    expect(闸脚本).toContain('NODE="$DSH/node/bin/node"')
  })

  it('跑 dsh 的入口、插件包的位置,与本体同一条', () => {
    expect(去掉前缀(paths.runtimeBinJs)).toBe('runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(闸脚本).toContain('DSH_CLI="$DSH/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"')
    expect(去掉前缀(paths.packagesDir)).toBe('packages')
    expect(闸脚本).toContain('PKG="$DSH/packages/plugin.tgz"')
    expect(闸脚本).toContain('plugin --profile web add')
  })

  it('launchd 那一项的 Label 从装着的 plist 读,读不到才用缺省那一个', () => {
    expect(闸脚本).toContain(`${DSH_LAUNCHD_LABEL}.plist`)
    expect(闸脚本).toContain(`LABEL="${DSH_LAUNCHD_LABEL}"`)
    expect(闸脚本).toContain('kickstart -k')
  })

  it('★那张备忘的位置与本体同一条(审计 B 条:闸装完要记一行)', () => {
    expect(去掉前缀(paths.installedJson)).toBe('updates/installed.json')
    expect(闸脚本).toContain('INSTALLED_JSON="$DSH/updates/installed.json"')
    // 形状与 writeInstalled 一致:assets.<种类> = { sha256, version, at }。
    expect(闸脚本).toContain('assets.plugin_tgz = { sha256:')
    // 写不进去不算闸没过 —— 它是一张备忘,不是状态机。
    expect(闸脚本).toContain('闸照样算过')
  })

  it('备份目录按卡的名字:~/.dsh/工作台回退备份-<YYYYMMDD-HHMM>/plugin.tgz', () => {
    expect(闸脚本).toContain('BK="$DSH/工作台回退备份-$(date +%Y%m%d-%H%M)"')
    expect(闸脚本).toContain('"$BK/plugin.tgz"')
  })

  it('这个脚本一个文件都不删、也不自动回退(那一下该由人看着)', () => {
    expect(闸脚本).not.toContain('rm -rf')
    expect(闸脚本).toContain('不自动回退')
  })
})

/* ─────────────────────────── 干跑:沙箱里真走一遍 ─────────────────────────── */

const PREFIX = join(tmpdir(), 'wb-release-gate-')
const boxes: string[] = []
const servers: Server[] = []
afterAll(async () => {
  while (servers.length) await new Promise<void>((resolve) => { servers.pop()?.close(() => resolve()) })
  while (boxes.length) {
    const box = boxes.pop() as string
    // 只删自己 mkdtemp 出来的那一棵(0904 家目录事故铁律)。
    if (!box.startsWith(PREFIX) || box.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${box}`)
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const 旧包 = '这是装着的那一版(假的)'
const 新包 = '这是要发的那一版(假的)'
const 新包SHA = createHash('sha256').update(新包).digest('hex')
/** 沙箱里那份 installed.json 里原有的另一行(闸只许改 plugin_tgz 那一行)。 */
const 工人旧SHA = '7'.repeat(64)

interface Box {
  /** 沙箱 HOME:`$HOME/.dsh` 与 `$HOME/Library/LaunchAgents` 都在里面。 */
  home: string
  dsh: string
  /** 要装的那一份(假 tgz)。 */
  tgz: string
  /** 假 launchctl 记下来的每一行。 */
  launchctl: () => string[]
  /** 假的自带 node 记下来的每一行(`plugin --profile web add` 那一步)。 */
  dshNode: () => string[]
  /** 客户端那张备忘(`~/.dsh/updates/installed.json`)。闸装完要记一行(2026-10-03,审计 B 条)。 */
  installedJson: string
}

function newBox(opts: { withOld?: boolean, withRecord?: boolean } = {}): Box {
  const home = mkdtempSync(PREFIX)
  boxes.push(home)
  const dsh = join(home, '.dsh')
  const put = (path: string, text: string, mode?: number): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    if (mode !== undefined) chmodSync(path, mode)
  }
  mkdirSync(join(dsh, 'packages'), { recursive: true })
  if (opts.withOld !== false) put(join(dsh, 'packages', 'plugin.tgz'), 旧包)
  // 自带 node:只把自己的参数记一行,**不真装插件**(真那一下要联网、要动 profile)。
  const nodeLog = join(home, 'node.log')
  put(join(dsh, 'node', 'bin', 'node'), `#!/bin/sh\necho "$@" >> "${nodeLog}"\nexit 0\n`, 0o755)
  put(join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {}\n')
  put(join(home, 'Library', 'LaunchAgents', `${DSH_LAUNCHD_LABEL}.plist`), '<plist/>\n')
  const kickLog = join(home, 'launchctl.log')
  put(join(home, '假launchctl'), `#!/bin/sh\necho "$@" >> "${kickLog}"\nexit 0\n`, 0o755)
  const tgz = join(home, 'plugin-新的.tgz')
  put(tgz, 新包)
  // 这台机器上原有的那张备忘:插件那一行记着上一版,工人那一行是别人的 ——
  // 闸只许改前者(10-03 本机那份记的就是 0.4.87 / 0.4.61 这种形状)。
  const installedJson = join(dsh, 'updates', 'installed.json')
  if (opts.withRecord === true) {
    put(installedJson, serializeInstalled({
      version: '0.4.88',
      updated_at: '2026-10-02T00:00:00.000Z',
      assets: {
        plugin_tgz: { sha256: '1'.repeat(64), version: '0.4.88', at: '2026-10-02T00:00:00.000Z' },
        channel_worker_tgz: { sha256: 工人旧SHA, version: '0.4.61', at: '2026-09-20T00:00:00.000Z' },
      },
    }))
  }
  const lines = (file: string) => (): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(one => one.trim() !== '') : []
  return { home, dsh, tgz, launchctl: lines(kickLog), dshNode: lines(nodeLog), installedJson }
}

/**
 * 一台假的 8791:`/update/check` 按 `versions` 逐次回(用完之后一直回最后那一个),
 * `/state` 回 `stateCode`。回 origin 与「被问过几次」。
 */
async function fake8791(opts: { versions: readonly string[], stateCode?: number, stateDelayMs?: number }): Promise<{ base: string, checks: () => number }> {
  let asked = 0
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/update/check') {
      const version = opts.versions[Math.min(asked, opts.versions.length - 1)] ?? ''
      asked += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ current: version, available: false, checked_at: '2026-10-03T00:00:00Z' }))
      return
    }
    if (path === '/state') {
      const code = opts.stateCode ?? 200
      const answer = (): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(code === 200 ? '{"ok":true}' : '{"error":"起来了但这一拍崩了"}')
      }
      if (opts.stateDelayMs === undefined) answer()
      else setTimeout(answer, opts.stateDelayMs)
      return
    }
    res.writeHead(404)
    res.end('no')
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  return { base: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, checks: () => asked }
}

/** 真跑一遍闸脚本(沙箱里)。**真 ~/.dsh 与真 launchctl 都碰不到。** */
async function runGate(box: Box, base: string, extra: readonly string[] = []): Promise<{ status: number | null, out: string }> {
  const child = spawn('bash', [
    GATE,
    '--tgz', box.tgz,
    '--version', '9.9.9',
    '--dsh-home', box.dsh,
    '--base', base,
    '--launchctl', join(box.home, '假launchctl'),
    '--settle', '0',
    '--poll', '0',
    '--wait', '10',
    // 第 0 下(网页端能加载)与第 4½ 下(再盯两分钟)各有自己那几条用例(文件末尾);
    // 这里的包是假的(一段文字,不是 tgz)、也不想每条用例都盯两分钟。后面的同名参数会盖掉这两个。
    '--watch', '0',
    '--no-web-check',
    ...extra,
  ], { cwd: box.home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: box.home, TMPDIR: box.home } })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  return { status, out }
}

/** 沙箱里那个备份目录(闸每跑一次建一个,名字带时刻)。 */
function backupTgz(box: Box): string | undefined {
  const dir = readdirSync(box.dsh).find(one => one.startsWith('工作台回退备份-'))
  return dir === undefined ? join(box.dsh, '(没有备份目录)') : join(box.dsh, dir, 'plugin.tgz')
}

describe('闸脚本:沙箱里真走一遍', () => {
  it('★起来了:先备份、再装、再 kickstart,等到 current 变成这一版才回 0', async () => {
    const box = newBox()
    // 前两拍还是旧版本(launchd 正在拉起来),第三拍才是新的 —— 真机上就是这个形状。
    const fake = await fake8791({ versions: ['0.4.88', '0.4.88', '9.9.9'] })
    const got = await runGate(box, fake.base)

    expect(got.out).not.toContain('×')
    expect(got.status).toBe(0)
    // ① 备份是**装之前**那一份(不是刚装上去的新包)
    expect(readFileSync(backupTgz(box) as string, 'utf8')).toBe(旧包)
    // ② 装上去的是新那一份
    expect(readFileSync(join(box.dsh, 'packages', 'plugin.tgz'), 'utf8')).toBe(新包)
    // ③ 装法:自带 node 跑 dsh 的 plugin add,指着 packages/plugin.tgz
    expect(box.dshNode().join('\n')).toContain('plugin --profile web add')
    expect(box.dshNode().join('\n')).toContain(join(box.dsh, 'packages', 'plugin.tgz'))
    // ④ 重启:kickstart -k gui/<uid>/<label>
    expect(box.launchctl().join('\n')).toContain(`kickstart -k gui/${process.getuid?.() ?? 0}/${DSH_LAUNCHD_LABEL}`)
    // ⑤ 真的等到了那一版(问了三次,不是问一次就算过)
    expect(fake.checks()).toBeGreaterThanOrEqual(3)
    expect(got.out).toContain('9.9.9')
  }, 90_000)

  it('★一直起不来:非 0 退出,并把**回退命令**原样打出来(node 路径是 node/bin/node)', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['0.4.88'] })
    const got = await runGate(box, fake.base, ['--wait', '2', '--poll', '1'])

    expect(got.status).not.toBe(0)
    expect(got.status).not.toBe(null)
    expect(got.out).toContain('没推')
    // 回退命令三下齐全,而且 node 指的是 `node/bin/node`(0.4.88 那天就栽在这一条上)。
    expect(got.out).toContain(`cp "${backupTgz(box) as string}" "${join(box.dsh, 'packages', 'plugin.tgz')}"`)
    expect(got.out).toContain(`"${join(box.dsh, 'node', 'bin', 'node')}"`)
    expect(got.out).toContain('plugin --profile web add')
    expect(got.out).toContain(`launchctl kickstart -k gui/$(id -u)/${DSH_LAUNCHD_LABEL}`)
  }, 90_000)

  it('★起来了但那一拍 /state 不回 200:照样非 0、照样打回退命令(真机崩的就是这一拍)', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'], stateCode: 503 })
    const got = await runGate(box, fake.base)

    expect(got.status).not.toBe(0)
    expect(got.out).toContain('/state')
    expect(got.out).toContain('503')
    expect(got.out).toContain('没推')
    expect(got.out).toContain('plugin --profile web add')
  }, 90_000)

  it('这台机器上没装过工作台(自带 node 不在):当场停,并指去 --skip-local-check', async () => {
    const box = newBox()
    rmSync(join(box.dsh, 'node'), { recursive: true, force: true })
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base)

    expect(got.status).not.toBe(0)
    expect(got.out).toContain('--skip-local-check')
    // 一下都没装、一下都没重启。
    expect(readFileSync(join(box.dsh, 'packages', 'plugin.tgz'), 'utf8')).toBe(旧包)
    expect(box.launchctl()).toEqual([])
  }, 90_000)

  it('★过了之后记一行账:installed.json 里 plugin_tgz = 新包的 sha(审计 B 条)', async () => {
    const box = newBox({ withRecord: true })
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base)
    expect(got.status).toBe(0)

    // **拿客户端自己的解析器读**:形状对不上的话它会把这一条整条丢掉(sha 形状、字段名)。
    const record = parseInstalled(readFileSync(box.installedJson, 'utf8'))
    expect(record.assets.plugin_tgz?.sha256).toBe(新包SHA)
    expect(record.assets.plugin_tgz?.version).toBe('9.9.9')
    expect(record.assets.plugin_tgz?.at).not.toBe('')
    // **只改这一行**:工人那一行原样留着(闸压根没装它)。
    expect(record.assets.channel_worker_tgz?.sha256).toBe(工人旧SHA)
    expect(record.assets.channel_worker_tgz?.version).toBe('0.4.61')
    expect(record.version).toBe('9.9.9')
  }, 90_000)

  it('★原来没有那张备忘(第一次)也记得上,而且只有 plugin_tgz 那一行', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    expect(await (await runGate(box, fake.base)).status).toBe(0)
    const record = parseInstalled(readFileSync(box.installedJson, 'utf8'))
    expect(Object.keys(record.assets)).toEqual(['plugin_tgz'])
    expect(record.assets.plugin_tgz?.sha256).toBe(新包SHA)
  }, 90_000)

  it('★没过的那一趟**一行都不记** —— 记早了等于把一台没起来的机器说成装好了', async () => {
    const box = newBox({ withRecord: true })
    const fake = await fake8791({ versions: ['0.4.88'] })
    const got = await runGate(box, fake.base, ['--wait', '2', '--poll', '1'])
    expect(got.status).not.toBe(0)
    const record = parseInstalled(readFileSync(box.installedJson, 'utf8'))
    // 插件那一行还是原来那一份(没被改成新包的 sha)。
    expect(record.assets.plugin_tgz?.sha256).toBe('1'.repeat(64))
    expect(record.assets.plugin_tgz?.version).toBe('0.4.88')
  }, 90_000)

  it('本机原来没有 plugin.tgz:照样往下走,但如实说一句「没有可回退的那一份」', async () => {
    const box = newBox({ withOld: false })
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base)

    expect(got.status).toBe(0)
    expect(got.out).toContain('没有可回退的那一份')
    expect(readFileSync(join(box.dsh, 'packages', 'plugin.tgz'), 'utf8')).toBe(新包)
  }, 90_000)
})

/* ──────────── 第 0 下与第 4½ 下:网页端能加载、再盯一会儿(2026-10-22) ──────────── */

/** 一份真的 tgz,里面只有 `package/lib/client.js`(DSH 页面装载口的形状)。 */
function realTgz(box: Box, name: string, top = ''): string {
  const dir = join(box.home, `${name}-src`)
  mkdirSync(join(dir, 'package', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package', 'lib', 'client.js'), [
    'window.__ModuleLoader__.load({ id: "@ben/dsh-workbench", factory: (require) => {',
    'var module = { exports: {} }; var exports = module.exports;',
    top,
    'exports.apply = function (ctx) { ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "x" }, null)); };',
    'return module.exports; } });',
  ].join('\n'))
  const tgz = join(box.home, `${name}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package'])
  return tgz
}

/**
 * 一台真在空转的 8791:另起一个 node 进程一直忙(每 50 毫秒让一下,好让请求答得上),什么请求都回这一版。
 * 机器负载高时(几张卡并行跑用例,负载 50 时实测一个一直忙的进程只分到 8%–30%)它分到的 CPU 没个准,
 * 所以这条用例把线压到 0%:它验的是「量的是 8791 那个进程、过线就不过」,线本身是参数。
 */
async function spinning8791(): Promise<{ base: string, stop: () => void }> {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"current":"9.9.9","ok":true}') });
    server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port) + '\\n') });
    const spin = () => { const t = Date.now(); while (Date.now() - t < 50) {} setImmediate(spin) }; spin();
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((resolve) => { child.stdout.once('data', chunk => resolve(String(chunk).trim())) })
  return { base: `http://127.0.0.1:${port}`, stop: () => { child.kill('SIGKILL') } }
}

describe('第 0 下:网页端能加载(装之前就验)', () => {
  it('★包里的 client.js 在页面里注册得上 → 往下走、装上', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate({ ...box, tgz: realTgz(box, '好的') }, fake.base, ['--web-check'])
    expect(got.out).toContain('网页端能加载')
    expect(got.status).toBe(0)
  }, 90_000)

  it('★包里的 client.js 读 process.env(0.4.143 第一次的样子)→ 当场停,一下都没装、没重启', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate({ ...box, tgz: realTgz(box, '坏的', 'var mode = process.env.NODE_ENV;') }, fake.base, ['--web-check'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('process is not defined')
    expect(got.out).toContain('没推')
    expect(readFileSync(join(box.dsh, 'packages', 'plugin.tgz'), 'utf8')).toBe(旧包)
    expect(box.dshNode()).toEqual([])
    expect(box.launchctl()).toEqual([])
  }, 90_000)

  it('第 0 下在第 1 下(备份 / 装)之前', () => {
    expect(lineOf(闸脚本, 'scripts/client-load-check.ts')).toBeGreaterThan(0)
    expect(lineOf(闸脚本, 'scripts/client-load-check.ts')).toBeLessThan(lineOf(闸脚本, 'say "1. 先把这台机器上现装的那一份备份下来"'))
  })
})

describe('第 4½ 下:装上之后再盯一会儿 CPU 与 /state', () => {
  it('★都在线内 → 过,并把读了几次、最慢多少、CPU 多少打出来', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base, ['--watch', '2', '--watch-poll', '1', '--max-cpu', '1000'])
    expect(got.out).not.toContain('×')
    expect(got.status).toBe(0)
    expect(got.out).toMatch(/\/state:读了 \d+ 次/)
    expect(got.out).toContain('CPU:')
  }, 90_000)

  it('★/state 一直慢(空转那天 15 秒超时)→ 不过,打回退命令', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'], stateDelayMs: 1200 })
    const got = await runGate(box, fake.base, ['--watch', '3', '--watch-poll', '1', '--max-state-ms', '500', '--max-cpu', '1000'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('慢过 500 毫秒')
    expect(got.out).toContain('没推')
    expect(got.out).toContain('plugin --profile web add')
  }, 90_000)

  it('★进程真在空转(平均 CPU 超线)→ 不过', async () => {
    const box = newBox()
    const spin = await spinning8791()
    try {
      const got = await runGate(box, spin.base, ['--watch', '4', '--watch-poll', '1', '--max-cpu', '0'])
      expect(got.status, got.out).not.toBe(0)
      expect(got.out).toMatch(/平均 CPU \d+%,超过 0%/)
      expect(got.out).toContain('没推')
    }
    finally { spin.stop() }
  }, 90_000)

  it('缺省盯 120 秒、每 5 秒一次、CPU 线 50%、/state 线 3 秒', () => {
    expect(闸脚本).toContain('WATCH=120')
    expect(闸脚本).toContain('WATCH_POLL=5')
    expect(闸脚本).toContain('MAX_CPU=50')
    expect(闸脚本).toContain('MAX_STATE_MS=3000')
  })
})

/* ─────────────────────── 第 4¾ 下:回归门(理解中枢回归集通过率) ───────────────────────
 *
 * 2026-10-28 维护者拍板:事务官理解中枢改「模型出命令」,`docs/回归集-事务官真实交代-*.md` 整表通过率进本机闸、
 * 开源前公示。报告由 `workbench-plugin/dev/intent-regression/run.mjs` 写(`report.json`:total / passed / rate / at);
 * 线(`--intent-min`)由维护者定,没定就只公示不挡;定了线却没有报告 = 没跑回归集,不过。
 */

describe('第 4¾ 下:回归门', () => {
  it('★发版脚本:--intent-min 可定线,清单里带 intent_regression 一格(紧跟在两格 skipped 之后),闸那一行把报告路径传过去', () => {
    expect(发版脚本).toContain('--intent-min)')
    // 线缺省 100(维护者 2026-10-28 16:5x 定:一行不对就不推公网);环境 INTENT_GATE_MIN 与 --intent-min 可临时盖,
    // 设成空串 = 不定线只公示(所以是 `-` 不是 `:-`)。
    expect(发版脚本).toContain('INTENT_MIN="${INTENT_GATE_MIN-100}"')
    expect(发版脚本).toContain('"intent_regression"')
    expect(lineOf(发版脚本, '"intent_regression"')).toBeGreaterThan(lineOf(发版脚本, '"apk_check_skipped"'))
    // 两格 skipped 的相邻关系不变(上面那条用例钉着):新的一格排在它们后面。
    expect(lineOf(发版脚本, '"apk_check_skipped"')).toBe(lineOf(发版脚本, '"local_check_skipped"') + 1)
    const 闸行 = 发版脚本.split('\n')[lineOf(发版脚本, 'deploy/local-install-gate.sh')] ?? ''
    expect(闸行).toContain('--intent-report "$INTENT_REPORT"')
    expect(闸行).toContain('${INTENT_MIN:+--intent-min "$INTENT_MIN"}')
  })

  it('★闸脚本:4¾ 在 4½ 之后、5 之前;定了线低于线就 die、一个字节不推;定了线没报告也不过', () => {
    expect(闸脚本).toContain('--intent-report)')
    expect(闸脚本).toContain('--intent-min)')
    expect(lineOf(闸脚本, 'say "4¾. 回归门')).toBeGreaterThan(lineOf(闸脚本, 'say "4½. 再盯'))
    expect(lineOf(闸脚本, 'say "4¾. 回归门')).toBeLessThan(lineOf(闸脚本, 'say "5. 本机房间'))
    expect(闸脚本).toContain('低于线')
    expect(闸脚本).toContain('没有回归集报告')
  })

  const 报告 = (box: Box, passed: number, total: number): string => {
    const file = join(box.home, 'report.json')
    writeFileSync(file, JSON.stringify({ at: '2026-10-28T06:00:00.000Z', entrances: ['desktop'], total, passed, rate: passed / total, rows: [] }))
    return file
  }

  it('★通过率低于线 → 不过,话里有通过率与线,并打回退命令', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base, ['--intent-report', 报告(box, 6, 10), '--intent-min', '80'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('60%')
    expect(got.out).toContain('低于线 80%')
    expect(got.out).toContain('没推')
  })

  it('★通过率在线上 → 过,并把通过率打出来', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base, ['--intent-report', 报告(box, 6, 10), '--intent-min', '50'])
    expect(got.status).toBe(0)
    expect(got.out).toContain('60%')
  })

  it('★定了线却没有报告 → 不过(等于没跑回归集)', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base, ['--intent-report', join(box.home, '没有这份.json'), '--intent-min', '50'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('没有回归集报告')
  })

  it('没定线、没报告 → 照过,如实说这一版不带通过率', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base)
    expect(got.status).toBe(0)
    expect(got.out).toContain('不带通过率')
  })

  it('线要是 0–100 的整数,别的当场退', async () => {
    const box = newBox()
    const fake = await fake8791({ versions: ['9.9.9'] })
    const got = await runGate(box, fake.base, ['--intent-min', 'abc'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('--intent-min')
  })
})
