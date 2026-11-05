// @vitest-environment node
/**
 * 全链驱动真实模式的配置解析(2026-10-27,卡 t-bd1c04ed):只读引用本机
 * `~/.dsh/workbench/model.json` / `credentials.json` —— 不复制、不打印、不进证据。
 * 这里钉的是解析的**不变量**:绝对路径、都在 `<home>/.dsh/workbench` 之下、
 * run.mjs 确实从这个模块取路径(不内联第二份解析)。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRealModelFilesShape, resolveRealModelFiles } from '../dev/delegation-chain-acceptance/real-config.mjs'

describe('真实模式配置解析(只读引用本机那两份)', () => {
  it('默认家目录 → <home>/.dsh/workbench 之下两份绝对路径', () => {
    const files = resolveRealModelFiles('/Users/someone')
    expect(files).toEqual({
      modelFile: '/Users/someone/.dsh/workbench/model.json',
      credentialFile: '/Users/someone/.dsh/workbench/credentials.json',
    })
    expect(isRealModelFilesShape(files, '/Users/someone')).toBe(true)
  })

  it('相对家目录也归一成绝对路径,不变量照过', () => {
    const files = resolveRealModelFiles('fixtures/home')
    expect(resolve(files.modelFile)).toBe(resolve('fixtures/home/.dsh/workbench/model.json'))
    expect(isRealModelFilesShape(files, 'fixtures/home')).toBe(true)
  })

  it('形状不对(路径溜出 .dsh/workbench)当场 false', () => {
    expect(isRealModelFilesShape({ modelFile: '/tmp/model.json', credentialFile: '/Users/x/.dsh/workbench/credentials.json' }, '/Users/x')).toBe(false)
  })

  it('run.mjs 从这个模块取路径(不内联第二份解析、不复制文件)', () => {
    const src = readFileSync(join(__dirname, '../dev/delegation-chain-acceptance/run.mjs'), 'utf8')
    expect(src).toContain("import('./real-config.mjs')")
    expect(src).toContain('resolveRealModelFiles')
    // 只读引用:不得出现任何拷贝写法;受控模式写隔离配置是 join(wb, …),不碰本机那两份。
    expect(src).not.toContain('copyFile')
    expect(src).not.toMatch(/writeFileSync\([^)]*realFiles/s)
  })
})
