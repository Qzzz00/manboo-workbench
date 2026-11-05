// @vitest-environment node
/**
 * 第三方技能入库的守卫(2026-10-21,卡 S;审计 `docs/审计-花叔五件技能-2026-10-21.md`)。
 *
 * `third_party/skills/<名>/` 是上游锁定提交的**原样子集**:带 MIT 原文、带 `UPSTREAM.json` 说清保留了什么、去掉了什么。
 * 这几条防的是「顺手把音频拷进来」「改了上游文件却没记」「升级忘了重审」。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', 'third_party', 'skills')
/** 审计第一节那五件(入库目录名)。 */
const EXPECTED = ['darwin-skill', 'huashu-design', 'huashu-mac-use', 'huashu-nuwa', 'huashu-report']

interface Upstream {
  name: string
  repo: string
  commit: string
  license: string
  kept: string[]
  dropped: { path: string, why: string }[]
  patches: unknown[]
  reviewed: { file: string }[]
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function upstreamOf(name: string): Upstream {
  return JSON.parse(readFileSync(join(ROOT, name, 'UPSTREAM.json'), 'utf8')) as Upstream
}

describe('third_party/skills 入库守卫', () => {
  it('正好是审计里那五件', () => {
    const dirs = readdirSync(ROOT).filter(one => statSync(join(ROOT, one)).isDirectory()).sort()
    expect(dirs).toEqual(EXPECTED)
  })

  it('仓库级 NOTICE 给五件都署了名', () => {
    const notice = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8')
    for (const name of EXPECTED) {
      const meta = upstreamOf(name)
      expect(notice).toContain(meta.repo)
      expect(notice).toContain(meta.commit)
    }
  })

  describe.each(EXPECTED)('%s', (name) => {
    const dir = join(ROOT, name)
    const meta = upstreamOf(name)

    it('LICENSE 原样在、首行是 MIT License', () => {
      const license = readFileSync(join(dir, 'LICENSE'), 'utf8')
      expect(license.split('\n')[0]?.trim()).toBe('MIT License')
      expect(meta.license).toBe('MIT')
      expect(meta.kept).toContain('LICENSE')
    })

    it('锁定提交是 40 位、仓库在 alchaincyf 下、名字对得上目录', () => {
      expect(meta.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(meta.repo).toMatch(/^https:\/\/github\.com\/alchaincyf\/[\w.-]+$/)
      expect(meta.name).toBe(name)
    })

    it('kept 与实际文件一一对应,没有清单外的文件', () => {
      const actual = walk(dir).map(file => relative(dir, file)).filter(one => one !== 'UPSTREAM.json').sort()
      expect(actual).toEqual([...meta.kept].sort())
    })

    it('不是 git 克隆(版本检查那一节按原文整节跳过)', () => {
      expect(walk(dir).some(file => relative(dir, file).split('/').includes('.git'))).toBe(false)
      expect(existsSync(join(dir, '.git'))).toBe(false)
    })

    it('dropped 的东西确实不在,每条都写了原因', () => {
      expect(meta.dropped.length).toBeGreaterThan(0)
      for (const one of meta.dropped) {
        expect(one.why.trim()).not.toBe('')
        expect(meta.kept.filter(path => path.startsWith(one.path))).toEqual([])
      }
    })

    it('上游原文不改:patches 为空', () => {
      expect(meta.patches).toEqual([])
    })

    it('保留下来的脚本都逐文件核对过', () => {
      const scripts = meta.kept.filter(path => /\.(py|sh|js|mjs|jsx|swift)$/.test(path))
      const reviewed = new Set(meta.reviewed.map(one => one.file))
      expect(scripts.filter(path => !reviewed.has(path))).toEqual([])
      expect([...reviewed].filter(path => !meta.kept.includes(path))).toEqual([])
    })
  })

  it('音视频一样都没进来', () => {
    const media = walk(ROOT).filter(file => /\.(mp3|wav|m4a|mp4|mov|gif)$/i.test(file))
    expect(media).toEqual([])
  })
})
