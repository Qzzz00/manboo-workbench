// @vitest-environment node
/**
 * 发版脚本里 `$VAR` 后面紧跟中文要写成 `${VAR}`(2026-10-03,发 0.4.89 时撞到的)。
 *
 * 现场:维护者在自己的终端跑 `publish-update.sh`,推完公网之后 `make-source-kit.sh:93` 与
 * `publish-update.sh:563` 报 `COMMIT�: unbound variable` —— 他那个 shell 的 locale 不是 UTF-8,
 * bash 把 `$COMMIT」` 里「」的头一个字节也当成了变量名的一部分,`set -u` 当场炸。统筹自己的
 * UTF-8 终端里从来没复现过,所以这一类错只有拿字节扫源码才守得住。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DEPLOY_DIR = join(import.meta.dirname, '..', '..', 'deploy')

describe('deploy/*.sh:变量后面紧跟非 ASCII 字符的地方必须带花括号', () => {
  const scripts = readdirSync(DEPLOY_DIR).filter(name => name.endsWith('.sh'))

  it('deploy/ 下确实有脚本可查', () => {
    expect(scripts.length).toBeGreaterThan(3)
  })

  it.each(scripts)('%s', (name) => {
    const text = readFileSync(join(DEPLOY_DIR, name), 'utf8')
    const bad: string[] = []
    text.split('\n').forEach((line, i) => {
      // `$NAME` 直接贴着一个非 ASCII 字符(中文 / 全角标点 / 省略号)
      if (/\$[A-Z_][A-Z0-9_]*[^\x00-\x7F]/.test(line)) bad.push(`${name}:${i + 1}: ${line.trim().slice(0, 80)}`)
    })
    expect(bad).toEqual([])
  })
})
