// 快速钉 pnpm store 问题:克隆 → 手动跑 dsh plugin add(多种 env/配置组合,秒级迭代)。
// 输出目录在 ~/.cache(仓库内的文件会被外部清扫动到)。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), '.cache', 'collab-a-acceptance', `dbg-${Date.now()}`)
const home = join(root, 'home')
const dsh = join(home, '.dsh')
const sh = (cmd: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv } = {}): string =>
  execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

mkdirSync(join(dsh, 'workbench'), { recursive: true })
console.log('克隆到', root)
cpSync(join(homedir(), '.dsh', 'node'), join(dsh, 'node'), { recursive: true, verbatimSymlinks: true })
cpSync(join(homedir(), '.dsh', 'runtime'), join(dsh, 'runtime'), { recursive: true, verbatimSymlinks: true })
writeFileSync(join(dsh, 'workbench', 'model.json'), JSON.stringify({ mode: 'relay', relay_url: 'http://127.0.0.1:19893' }))

const pnpmTgz = [join(homedir(), 'Documents', 'GitHub', 'desktop-workbench', 'dist', '.cache', 'pnpm-11.16.0.tgz')].find(existsSync)
if (pnpmTgz === undefined) throw new Error('pnpm tgz 找不到')
execFileSync('tar', ['-xzf', pnpmTgz, '-C', join(dsh, 'node'), '--strip-components=1'], { stdio: 'inherit' })

const store = join(homedir(), 'Library', 'pnpm', 'store')
mkdirSync(join(home, 'pnpm'), { recursive: true })
execFileSync('ln', ['-s', store, join(home, 'pnpm', 'store')])

mkdirSync(join(dsh, 'profiles', 'web'), { recursive: true })
writeFileSync(join(dsh, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))

const tgz = process.argv[2]
if (tgz === undefined) { console.log('用法: node dbg-install.mts <plugin.tgz>'); process.exit(1) }
mkdirSync(join(dsh, 'packages'), { recursive: true })
cpSync(tgz, join(dsh, 'packages', 'plugin.tgz'))

const baseEnv: NodeJS.ProcessEnv = {
  HOME: home, USER: process.env.USER ?? '', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8',
  DSH_HOME: dsh, PATH: `${join(dsh, 'node', 'bin')}:/opt/homebrew/bin:/usr/bin:/bin`,
}
const run = (label: string, extra: Record<string, string>): void => {
  try {
    const out = sh(join(dsh, 'node', 'bin', 'node'), [join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'plugin', '--profile', 'web', 'add', join(dsh, 'packages', 'plugin.tgz')], { cwd: join(dsh, 'profiles', 'web'), env: { ...baseEnv, ...extra } })
    console.log(`✅ ${label} 成功`, out.slice(0, 200))
    process.exit(0)
  } catch (e) {
    const err = e as { stderr?: Buffer, stdout?: Buffer }
    const msg = Buffer.concat([err.stdout ?? Buffer.alloc(0), err.stderr ?? Buffer.alloc(0)]).toString()
    console.log(`❌ ${label}`, msg.split('\n').filter(l => /store|ERR|error|failed/i.test(l)).slice(0, 5).join(' | ') || msg.slice(0, 200))
  }
}
run('A 裸 env', {})
writeFileSync(join(home, '.npmrc'), `store-dir=${store}\n`)
run('B .npmrc store-dir', {})
writeFileSync(join(dsh, 'profiles', 'web', '.npmrc'), `store-dir=${store}\n`)
run('C profile 内 .npmrc', {})
run('D PNPM_HOME', { PNPM_HOME: join(home, 'pnpm') })
run('E npm_config_store_dir', { npm_config_store_dir: store })
run('F pnpm_config_store_dir', { pnpm_config_store_dir: store })
console.log('全都失败 —— 看上面各组的 store 行')
process.exit(2)
