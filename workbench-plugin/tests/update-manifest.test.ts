// @vitest-environment node
/**
 * 更新清单的解析与比版本(2026-09-18 热更新)。**全是纯函数**,不起服务、不联网、不碰磁盘。
 *
 * 这一组用例里最值钱的是"清单坏了会怎样"那几条:这份清单决定这台机器**下载并执行什么代码**,
 * 所以每一道校验都得有人钉着 —— 尤其是「sha256 不合格式就当清单坏了」与「产物必须跟清单同源」
 * 这两条,松掉任何一条都是一个能换包的缝。
 */
import { describe, expect, it } from 'vitest'
import {
  compareVersions, downloadBytesOf, isAllowedAssetUrl, isNewerVersion, parseManifest, UpdateManifestError,
} from '../src/server/update/manifest.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const BASE = 'https://api.aibooo.cn/updates/latest.json'

function manifestText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.2.42',
    released_at: '2026-09-18T12:00:00Z',
    notes: '修了窗口落屏',
    assets: {
      plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.2.42/plugin.tgz', sha256: SHA_A, size: 1100 },
    },
    ...over,
  })
}

describe('compareVersions', () => {
  it('数字段按数值比,不按字符串比', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('段数不一样时短的按 0 补:1.2 与 1.2.0 是同一版', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBe(-1)
  })

  it('带预发布尾巴的小于同号正式版', () => {
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBe(-1)
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBe(1)
    expect(compareVersions('0.3.0-rc.2', '0.3.0-rc.10')).toBe(-1)
  })

  it('isNewerVersion 是严格大于:相等、或者服务器上比本机旧,都不算有新版', () => {
    expect(isNewerVersion('0.2.42', '0.2.41')).toBe(true)
    expect(isNewerVersion('0.2.41', '0.2.41')).toBe(false)
    expect(isNewerVersion('0.2.40', '0.2.41')).toBe(false)
  })
})

describe('isAllowedAssetUrl', () => {
  it('https 一律可以', () => {
    expect(isAllowedAssetUrl('https://api.aibooo.cn/updates/a.tgz')).toBe(true)
  })

  it('http 只在回环上可以(用例要在本地假服务器上真走一遍下载)', () => {
    expect(isAllowedAssetUrl('http://127.0.0.1:9/updates/a.tgz')).toBe(true)
    expect(isAllowedAssetUrl('http://localhost:9/updates/a.tgz')).toBe(true)
    expect(isAllowedAssetUrl('http://example.com/a.tgz')).toBe(false)
  })

  it('认不出来的地址一律不放行', () => {
    expect(isAllowedAssetUrl('not-a-url')).toBe(false)
    expect(isAllowedAssetUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('parseManifest', () => {
  it('好清单原样解出来', () => {
    const manifest = parseManifest(manifestText(), BASE)
    expect(manifest.version).toBe('0.2.42')
    expect(manifest.notes).toBe('修了窗口落屏')
    expect(manifest.assets.plugin_tgz?.sha256).toBe(SHA_A)
  })

  it('sha256 不是 64 位十六进制就当清单坏了 —— 这一条不放宽', () => {
    const text = manifestText({
      assets: { plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: 'abc', size: 10 } },
    })
    expect(() => parseManifest(text, BASE)).toThrow(UpdateManifestError)
    expect(() => parseManifest(text, BASE)).toThrow(/sha256/)
  })

  it('sha256 是空字符串也不行(不能留一个"校验通过"的缝)', () => {
    const text = manifestText({
      assets: { plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: '', size: 10 } },
    })
    expect(() => parseManifest(text, BASE)).toThrow(UpdateManifestError)
  })

  it('产物指到别的服务器就不下', () => {
    const text = manifestText({
      assets: { plugin_tgz: { url: 'https://somewhere-else.example/a.tgz', sha256: SHA_A, size: 10 } },
    })
    expect(() => parseManifest(text, BASE)).toThrow(/别的服务器/)
  })

  it('没有 plugin_tgz 就不是一份能用的清单', () => {
    const text = manifestText({ assets: { apk: { url: 'https://api.aibooo.cn/u/a.apk', sha256: SHA_B, size: 10 } } })
    expect(() => parseManifest(text, BASE)).toThrow(/工作台本体/)
  })

  it('认不出来的产物种类直接忽略,不当成错(以后加新产物,旧版也能升)', () => {
    const text = manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: SHA_A, size: 10 },
        something_new_tgz: { 这里: '随便什么' },
      },
    })
    const manifest = parseManifest(text, BASE)
    expect(Object.keys(manifest.assets)).toEqual(['plugin_tgz'])
  })

  it('不是 JSON / 不是对象 / 没有像样的 version,各自一句人话', () => {
    expect(() => parseManifest('不是 json', BASE)).toThrow(/JSON/)
    expect(() => parseManifest('[]', BASE)).toThrow(/最外层/)
    expect(() => parseManifest(manifestText({ version: '' }), BASE)).toThrow(/version/)
    expect(() => parseManifest(manifestText({ version: 'latest' }), BASE)).toThrow(/version/)
  })

  it('缺 size 也当清单坏了 —— 进度条与「要下多大」都靠它', () => {
    const text = manifestText({
      assets: { plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: SHA_A } },
    })
    expect(() => parseManifest(text, BASE)).toThrow(/size/)
  })

  it('min_installer_version 带过来', () => {
    expect(parseManifest(manifestText({ min_installer_version: '0.2.40' }), BASE).min_installer_version).toBe('0.2.40')
  })

  /** 没重打、照上一版原样带上的那几格(2026-09-26,卡 U8)。 */
  it('from_version 带过来:同一台服务器上**别的版本目录**照样收(旧版本的目录从不删)', () => {
    const manifest = parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.2.42/plugin.tgz', sha256: SHA_A, size: 1100 },
        apk: { url: 'https://api.aibooo.cn/updates/0.2.40/app.apk', sha256: SHA_B, size: 30_000_000, from_version: '0.2.40' },
      },
    }), BASE)
    expect(manifest.assets.apk?.from_version).toBe('0.2.40')
    expect(manifest.assets.apk?.url).toBe('https://api.aibooo.cn/updates/0.2.40/app.apk')
  })

  it('from_version 形状不对(不是字符串 / 不像版本号)就当没有,**不判死整份清单**', () => {
    for (const bad of [42, '', ' ', 'latest', '../0.2.40', null] as unknown[]) {
      const manifest = parseManifest(manifestText({
        assets: { plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.2.42/plugin.tgz', sha256: SHA_A, size: 1100, from_version: bad } },
      }), BASE)
      expect(manifest.assets.plugin_tgz?.from_version).toBeUndefined()
      expect(manifest.assets.plugin_tgz?.sha256).toBe(SHA_A)
    }
  })
})

describe('downloadBytesOf', () => {
  it('只算会下载的那几样 —— apk 不算(手机自己去下)', () => {
    const manifest = parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: SHA_A, size: 1000 },
        scripts_tgz: { url: 'https://api.aibooo.cn/updates/s.tgz', sha256: SHA_B, size: 200 },
        apk: { url: 'https://api.aibooo.cn/updates/a.apk', sha256: SHA_A, size: 30_000_000 },
      },
    }), BASE)
    expect(downloadBytesOf(manifest)).toBe(1200)
  })

  /** 电脑安装包也不算(2026-09-26,卡 SM):这台机器永远不下载它,它是给另一台装的。 */
  it('电脑安装包(installer_dmg)不算 —— 已经装好的机器点「立即更新」就够了', () => {
    const manifest = parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/a.tgz', sha256: SHA_A, size: 1000 },
        installer_dmg: { url: 'https://api.aibooo.cn/updates/0.4.4/工作台安装器.dmg', sha256: SHA_B, size: 102_454_199 },
      },
    }), BASE)
    expect(manifest.assets.installer_dmg?.size).toBe(102_454_199)
    expect(downloadBytesOf(manifest)).toBe(1000)
  })
})

/**
 * 电脑安装包那一格(2026-09-26,卡 SM)。文件名是中文的(线上 0.4.4 目录里那一份就叫
 * `工作台安装器.dmg`),所以顺手钉住:**那几道校验照样在跑、中文文件名照收、原样带出去**。
 */
describe('installer_dmg 那一格', () => {
  const DMG = 'https://api.aibooo.cn/updates/0.4.4/工作台安装器.dmg'

  it('中文文件名的地址照收,url 原样带出去(不改写、不转义)', () => {
    const manifest = parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.4.6/plugin.tgz', sha256: SHA_A, size: 1100 },
        installer_dmg: { url: DMG, sha256: SHA_B, size: 102_454_199, from_version: '0.4.4' },
      },
    }), BASE)
    expect(manifest.assets.installer_dmg?.url).toBe(DMG)
    // 照上一版原样带上的那一格(卡 U8)说得出它真出自哪一版。
    expect(manifest.assets.installer_dmg?.from_version).toBe('0.4.4')
  })

  it('这一格的 sha256 与同源那两道校验一样严(安装包也是要在别的机器上跑的代码)', () => {
    expect(() => parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.4.6/plugin.tgz', sha256: SHA_A, size: 1100 },
        installer_dmg: { url: DMG, sha256: 'nope', size: 10 },
      },
    }), BASE)).toThrow(/sha256/)
    expect(() => parseManifest(manifestText({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/updates/0.4.6/plugin.tgz', sha256: SHA_A, size: 1100 },
        installer_dmg: { url: 'https://example.com/工作台安装器.dmg', sha256: SHA_B, size: 10 },
      },
    }), BASE)).toThrow(/别的服务器/)
  })
})
