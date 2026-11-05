// @vitest-environment node
/**
 * 守门:给用户的源码包那几个脚本,要和本体的「装插件」那条路对得上(2026-10-02,卡「给用户的源码包」)。
 *
 * ## 为什么要这一份
 *
 * `deploy/source-kit/构建并装上.sh` 在运营同学那台机器上跑,它**照着** `install.ts` 的
 * `plugin` 那一步装:把 .tgz 放到 `~/.dsh/packages/plugin.tgz`,再用自带的 node 跑
 * `<runtime>/…/dsh/lib/bin.js plugin --profile web add`。这几条路径与名字的出处只有一处 ——
 * `src/server/setup/paths.ts` 与 `src/server/update/apply.ts`。
 *
 * 问题是:那边改一行,这个脚本**不会报错,只会装到别处去**(或者装不上,而她分不清是自己改坏了
 * 还是包坏了)。shell 脚本没有类型,所以这道门只能在这儿:**拿源头的常量去比脚本的正文**。
 *
 * 不写「逐字相同」的注释代替测试(AGENTS.md 接缝那一节),所以这里逐条断言。
 *
 * 红了怎么办:看红的是哪一条 —— 本体那边有意改了路径,就把 `deploy/source-kit/构建并装上.sh`
 * 跟着改;只是包里那几个脚本改名了,就把 `deploy/make-source-kit.sh` 的清单跟着改。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NPM_MIRROR_REGISTRY, setupPaths } from '../src/server/setup/paths.ts'

const repoFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

const 包脚本 = repoFile('deploy/source-kit/构建并装上.sh')
const 打包脚本 = repoFile('deploy/make-source-kit.sh')
const 回滚脚本 = repoFile('deploy/source-kit/回滚.sh')
const 公共 = repoFile('deploy/source-kit/_公共.sh')
const 导出 = repoFile('deploy/source-kit/导出我的改动.sh')
const 收口 = repoFile('deploy/apply-user-changes.sh')
// `ASSET_FILENAMES` 在 apply.ts 里没导出(这张卡不动插件源码),所以按正文比。
const 热更新 = repoFile('workbench-plugin/src/server/update/apply.ts')

// 把 paths.ts 的算法跑一遍,拿到「相对 ~/.dsh 的那一段」—— 脚本里写的就是这几段。
const paths = setupPaths({ home: '/H', dshHome: '/H/.dsh' })
const 去掉前缀 = (full: string) => full.replace('/H/.dsh/', '')

describe('源码包:装插件那条路与本体对得上', () => {
  it('自带 node 与 npm 的位置', () => {
    expect(去掉前缀(paths.nodeBin)).toBe('node/bin/node')
    expect(公共).toContain('NODE="$DSH/node/bin/node"')
    expect(公共).toContain('NPM="$DSH/node/bin/npm"')
  })

  it('PATH 第一段是自带 node 的 bin(自带 pnpm 那个小脚本也在那儿)', () => {
    expect(去掉前缀(paths.pnpmBin)).toBe('node/bin/pnpm')
    expect(公共).toContain('$DSH/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
  })

  it('跑 dsh 的那个入口', () => {
    expect(去掉前缀(paths.runtimeBinJs)).toBe('runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(包脚本).toContain('DSH_CLI="$DSH/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"')
  })

  it('.tgz 放在哪、叫什么 —— 与热更新那一趟同一个文件名', () => {
    expect(去掉前缀(paths.packagesDir)).toBe('packages')
    // 热更新把插件包落成 `plugin.tgz`(apply.ts 的 ASSET_FILENAMES),包里照这个名字,
    // 于是 profile 里那条 `file:…/plugin.tgz` 依赖两条路共用一个,不会各装一份。
    expect(热更新).toContain("plugin_tgz: 'plugin.tgz'")
    expect(包脚本).toContain('cp "$TGZ" "$DSH/packages/plugin.tgz"')
    expect(包脚本).toContain('plugin --profile web add "$DSH/packages/plugin.tgz"')
  })

  it('profile 与插件在 profile 里的位置', () => {
    expect(去掉前缀(paths.profileDir)).toBe('profiles/web')
    expect(去掉前缀(paths.profilePluginPackageJson)).toBe('profiles/web/node_modules/@ben/dsh-workbench/package.json')
    expect(公共).toContain('$DSH/profiles/web/node_modules/@ben/dsh-workbench')
  })

  it('官方源不成换的那条镜像,与本体同一个', () => {
    expect(包脚本).toContain(`NPM_MIRROR='${NPM_MIRROR_REGISTRY}'`)
  })

  it('环境变量照 dshEnv:DSH_HOME 要指对', () => {
    expect(包脚本).toContain('DSH_HOME="$DSH"')
  })
})

describe('源码包:打包脚本与包里真有的文件对得上', () => {
  it('拷进包的那份清单 = deploy/source-kit/ 里真实存在的文件', () => {
    const 真有的 = readdirSync(new URL('../../deploy/source-kit/', import.meta.url)).sort()
    const 清单行 = /\nfor f in ([^;]+); do\n  src="\$REPO_ROOT\/deploy\/source-kit\/\$f"/.exec(打包脚本)
    expect(清单行).not.toBeNull()
    const 要拷的 = (清单行?.[1] ?? '').trim().split(/\s+/).sort()
    expect(要拷的).toEqual(真有的)
  })
})

describe('源码包:导出与落地两边说的是同一份 包信息.json', () => {
  it('写进去的字段名 = 读出来的字段名', () => {
    // 打包那边写的是这四个键(加 源码根),收口那边按名字读 —— 中文键名写错一个字就对不上。
    for (const 键 of ['版本', '提交', '分支', '打包时间', '源码根']) {
      expect(打包脚本).toContain(键)
    }
    expect(收口).toContain("['提交']")
    expect(收口).toContain("['版本']")
    expect(收口).toContain("['源码根']")
  })

  it('导出的包里那几样,收口那边都在找', () => {
    for (const 名 of ['基线.json', '改动清单.txt', '改动.diff', '改动的文件', '删掉的文件.txt']) {
      expect(导出).toContain(名)
    }
    for (const 名 of ['基线.json', '改动的文件', '删掉的文件.txt']) {
      expect(收口).toContain(名)
    }
  })
})

describe('源码包:纪律', () => {
  it('包里的脚本不重启 DSH、不碰 launchd(她那边只提示她自己重启)', () => {
    for (const [名, 正文] of [['构建并装上', 包脚本], ['回滚', 回滚脚本], ['_公共', 公共], ['导出', 导出]] as const) {
      expect(正文, `${名}.sh 里不该出现 launchctl`).not.toContain('launchctl')
    }
  })

  it('收口脚本不 push、不合并到 main(统筹自己决定怎么合)', () => {
    expect(收口).not.toContain('git_ push')
    // 试合是 `--no-commit --no-ff` 加紧随其后的 abort —— 不许留下一个真的合并提交。
    expect(收口).toContain('merge --no-commit --no-ff')
    expect(收口).toContain('merge --abort')
  })
})
