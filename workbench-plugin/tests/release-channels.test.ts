// @vitest-environment node
/**
 * 发版脚本的两条通道与稳定版前的新机器演练(2026-10-21,内测发版底座)。
 *
 * 同 `release-gate.test.ts` 的口径:`deploy/publish-update.sh` 在这里**一次都不真发** ——
 * 只按正文与行号断言形状;真跑的只有参数解析那几条(在解析那一行就退出,一件产物都不构建)。
 * 两条通道真干跑一遍(`--dry-run`,不 rsync)的结果写在交接里。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './helpers/shippedScripts.ts'
import { isNewerVersion } from '../src/server/update/manifest.ts'

const PUBLISH = join(REPO_ROOT, 'deploy', 'publish-update.sh')
const 发版脚本 = readFileSync(PUBLISH, 'utf8')

function lineOf(needle: string): number {
  return 发版脚本.split('\n').findIndex(line => !line.trimStart().startsWith('#') && line.includes(needle))
}

function run(args: readonly string[]): { status: number | null, out: string } {
  const got = spawnSync('bash', [PUBLISH, ...args], { encoding: 'utf8', timeout: 20_000 })
  return { status: got.status, out: `${got.stdout ?? ''}${got.stderr ?? ''}` }
}

describe('--channel', () => {
  it('缺省是热修;只认 stable / hotfix,别的当场拒', () => {
    expect(发版脚本).toContain('CHANNEL="hotfix"')
    for (const bad of [['--channel'], ['--channel', 'beta'], ['--channel', 'latest']]) {
      const got = run(bad)
      expect(got.status, bad.join(' ')).not.toBe(0)
      expect(got.out).toContain('stable 或 hotfix')
    }
  })

  it('热修只写、只推 beta.json;稳定版写 latest.json 并复制成 beta.json,两份都推', () => {
    expect(发版脚本).toContain('if [ "$CHANNEL" = "stable" ]; then MANIFEST_NAME="$STABLE_MANIFEST_NAME"; else MANIFEST_NAME="$HOTFIX_MANIFEST_NAME"; fi')
    expect(发版脚本).toContain('cp "$MANIFEST" "$OUT/$HOTFIX_MANIFEST_NAME"')
    expect(发版脚本).toContain('PUSH_MANIFESTS="$HOTFIX_MANIFEST_NAME $STABLE_MANIFEST_NAME"')
    expect(发版脚本).toContain('PUSH_MANIFESTS="$HOTFIX_MANIFEST_NAME"\n')
    // 推清单那一步只按 PUSH_MANIFESTS 走,不再写死 latest.json。
    expect(发版脚本).not.toMatch(/rsync -av "\$MANIFEST" "\$SSH_HOST:\$REMOTE_DIR\/latest\.json"/)
    expect(发版脚本).toContain('rsync -av "$OUT/$name" "$SSH_HOST:$REMOTE_DIR/$name"')
  })

  it('★稳定版两份清单先推 beta.json、后推 latest.json(中间那一下不会出现稳定版比热修新)', () => {
    const pushes = 'PUSH_MANIFESTS="$HOTFIX_MANIFEST_NAME $STABLE_MANIFEST_NAME"'
    expect(发版脚本.indexOf(pushes)).toBeGreaterThan(0)
  })

  it('版本号要比服务器上两份清单里较新的那一版还新;照较新的那一份抄没重打的几样', () => {
    expect(发版脚本).toContain('remote_manifest_version "$STABLE_MANIFEST_NAME" "$PREV_STABLE"')
    expect(发版脚本).toContain('remote_manifest_version "$HOTFIX_MANIFEST_NAME" "$PREV_HOTFIX"')
    expect(发版脚本).toContain('version_newer "$VERSION" "$REMOTE_VERSION"')
    expect(发版脚本).toContain('PREV_MANIFEST="$PREV_HOTFIX"')
  })

  it('★脚本里那把版本尺与客户端 compareVersions 逐对一致(脚本不 import 源码,一张表对着跑)', () => {
    const fn = 发版脚本.slice(发版脚本.indexOf('version_newer() {'), 发版脚本.indexOf('\n}\n', 发版脚本.indexOf('version_newer() {')) + 3)
    const pairs: [string, string][] = [
      ['9.9.10', '9.9.9'], ['9.9.9', '9.9.10'], ['0.4.143', '0.4.143'], ['0.4.144', '0.4.143'], ['1.0', '1.0.0'],
      ['0.3.0', '0.3.0-rc.1'], ['0.3.0-rc.1', '0.3.0'], ['0.1.7-rc.2', '0.1.7-rc.10'], ['0.4.200', '0.5.0'], ['1.2.3-beta', '1.2.3-alpha'],
    ]
    for (const [a, b] of pairs) {
      const got = spawnSync('bash', ['-c', `${fn}\nversion_newer "$1" "$2"`, 'x', a, b], { encoding: 'utf8' })
      expect(got.status === 0, `${a} vs ${b}:${got.stderr}`).toBe(isNewerVersion(a, b))
    }
  })

  it('清单里记一格 channel', () => {
    expect(发版脚本).toContain(`printf '  "channel": "%s",\\n' "$CHANNEL"`)
  })
})

describe('稳定版先演练,红了不发', () => {
  it('★演练在写完清单之后、本机闸与 --no-upload 早退之前(干跑与 --no-upload 也照跑:它只碰隔离 home)', () => {
    const 写清单 = lineOf('say "算 sha256,写清单"')
    const 演练 = lineOf('pnpm --silent rehearse')
    const 早退 = lineOf('if [ "$UPLOAD" = "0" ]; then')
    const 闸 = lineOf('deploy/local-install-gate.sh')
    expect(演练).toBeGreaterThan(写清单)
    expect(早退).toBeGreaterThan(演练)
    expect(闸).toBeGreaterThan(演练)
  })

  it('只有稳定版演练;没过就 die,话里有「没推」', () => {
    const lines = 发版脚本.split('\n')
    const at = lineOf('pnpm --silent rehearse')
    expect(lines.slice(at - 12, at).join('\n')).toContain('if [ "$CHANNEL" = "stable" ]; then')
    expect(lines.slice(at, at + 4).join('\n')).toContain('die')
    expect(lines.slice(at, at + 4).join('\n')).toContain('没推')
  })

  it('--skip-rehearse 不给理由 / 理由被下一个参数占了 —— 都拒;给了就记进清单 rehearse_skipped', () => {
    for (const args of [['--skip-rehearse'], ['--skip-rehearse', '--notes', '随便']]) {
      const got = run(args)
      expect(got.status, args.join(' ')).not.toBe(0)
      expect(got.out).toContain('理由')
    }
    expect(发版脚本).toContain('"rehearse_skipped"')
  })

  it('演练的入口与 workbench-plugin 的 pnpm 脚本同名', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'workbench-plugin', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.rehearse).toBeDefined()
  })
})

describe('--dry-run', () => {
  it('★干跑不 rsync、不过闸:它把 UPLOAD 一起关掉,早退在闸与第一条 rsync 之前', () => {
    expect(发版脚本).toContain('--dry-run) DRY_RUN=1; UPLOAD=0 ;;')
    const 早退 = lineOf('if [ "$UPLOAD" = "0" ]; then')
    const 第一条rsync = 发版脚本.split('\n').findIndex(line => line.trimStart().startsWith('rsync -av'))
    expect(第一条rsync).toBeGreaterThan(早退)
    expect(lineOf('deploy/local-install-gate.sh')).toBeGreaterThan(早退)
  })

  it('干跑把要推的清单文件名逐个说出来,热修还要说稳定版那份不动', () => {
    expect(发版脚本).toContain('info "清单:$OUT/$name → $SSH_HOST:$REMOTE_DIR/$name"')
    expect(发版脚本).toContain('热修不碰稳定版那一份')
  })
})
