// @vitest-environment node
/**
 * 脱敏规则(2026-09-22)。纯函数,一条规则一条用例。
 *
 * 这一组的价值在于**它是那份「包内清单」里那张表的可执行版本** ——
 * 清单上写着"这几样会被擦掉",这里逐条验它真被擦掉了;
 * 同时也验反面:**不该擦的一个字都没动**。一个把报错本身擦没了的诊断包,
 * 比没有诊断包更耽误事。
 */
import { describe, expect, it } from 'vitest'

import { diagCode, DIAG_CODE_RE, DIAG_COMPONENTS, DIAG_KINDS, isDiagComponent, isDiagKind } from '../src/diag.ts'
import { redactJson, redactLines, redactPath, redactText, REDACTED, SENSITIVE_KEY_RE } from '../src/server/diagnostics/redact.ts'

describe('redactText:该擦的', () => {
  it('DSH 网页地址里那个 token —— 它就躺在 web.stdout.log 第一行', () => {
    // 夹具:假值,形状同 DSH 启动令牌(43 位 base64url),不是真令牌。
    const line = 'dsh web: http://127.0.0.1:3080/?token=fakeDshLaunchTokenTestFixture00000000000000'
    const out = redactText(line)
    expect(out).not.toContain('fakeDshLaunchTok')
    // 地址本身留着:排障要看它起在哪个端口
    expect(out).toContain('127.0.0.1:3080')
  })

  it('Authorization 头', () => {
    expect(redactText('authorization: Bearer wb_abcdefghijklmnop')).toBe(`authorization: Bearer ${REDACTED}`)
  })

  it('设备令牌 wb_ 与模型 Key sk-', () => {
    expect(redactText('领到了 wb_kPBgbQQQQQQQQQQQQ')).toBe(`领到了 wb_${REDACTED}`)
    expect(redactText('用的是 sk-0123456789abcdefghij')).toBe(`用的是 sk-${REDACTED}`)
  })

  it('JWT(LiveKit 进房凭证就是这个形状)', () => {
    expect(redactText('token: eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF')).not.toContain('SflKxwRJSM')
  })

  it('家目录里的用户名 —— 只换名字,路径留着', () => {
    expect(redactText('读 /Users/example/.dsh/workbench/app.json 失败'))
      .toBe('读 /Users/<用户>/.dsh/workbench/app.json 失败')
    expect(redactText('/home/deploy/relay/server')).toBe('/home/<用户>/relay/server')
  })

  it('一行里有好几样,一次全擦掉', () => {
    const out = redactText('GET /x from /Users/example with Bearer wb_zzzzzzzzzzzz and sk-aaaaaaaaaaaa')
    expect(out).not.toContain('/Users/example')
    expect(out).not.toContain('wb_zzzz')
    expect(out).not.toContain('sk-aaaa')
  })
})

describe('redactText:**不该擦的一个字都没动**', () => {
  it('普通的中文报错', () => {
    const line = '[工作台] 读 app.json 失败:ENOENT'
    expect(redactText(line)).toBe(line)
  })

  it('房间名、会话 id、sha —— 它们也是随机串,但正是排障要看的', () => {
    const line = '进房:wb-eed7c7f243badf32,会话 f79a3489-c019-4cb3-abac-65ae61f77ec1,sha 8294b7aa9b03'
    expect(redactText(line)).toBe(line)
  })

  it('端口、pid、耗时', () => {
    const line = '[channel-worker] 起了(pid 73014),8791 → 200,用了 43ms'
    expect(redactText(line)).toBe(line)
  })

  it('空串与非字符串不炸', () => {
    expect(redactText('')).toBe('')
    expect(redactText(undefined as unknown as string)).toBe('')
  })
})

describe('redactJson:按键名整格换', () => {
  it('敏感键的值不管是什么形状都换掉', () => {
    const out = redactJson({
      token: 'wb_xxxxxxxxxxxx',
      credentials: { deepseek: { api_key: 'sk-yyyyyyyyyyyy' } },
      pairing: { code: '882131', expires_at: '2026-09-22T10:20:00Z' },
      cookie: ['a=1', 'b=2'],
    }) as Record<string, unknown>
    expect(out.token).toBe(REDACTED)
    expect(out.credentials).toBe(REDACTED)
    expect(out.pairing).toBe(REDACTED)
    expect(out.cookie).toBe(REDACTED)
  })

  it('`key` 是整词匹配 —— keyboard / hotkey 不受连累', () => {
    const out = redactJson({ key: '绝密', keyboard: '认得的', hotkey: 'cmd+k' }) as Record<string, unknown>
    expect(out.key).toBe(REDACTED)
    expect(out.keyboard).toBe('认得的')
    expect(out.hotkey).toBe('cmd+k')
  })

  it('`code` **不在**敏感键里 —— 那个名字在诊断里是界面报错的短编号', () => {
    expect(SENSITIVE_KEY_RE.test('code')).toBe(false)
    const out = redactJson({ code: 'WB-123456' }) as Record<string, unknown>
    expect(out.code).toBe('WB-123456')
  })

  it('字符串值照样过一遍 redactText', () => {
    const out = redactJson({ note: '在 /Users/example/Desktop 上' }) as Record<string, unknown>
    expect(out.note).toBe('在 /Users/<用户>/Desktop 上')
  })

  it('数组封顶 500 条,而且**说清楚省了多少**,不是悄悄截断', () => {
    const out = redactJson(Array.from({ length: 600 }, (_, i) => i)) as unknown[]
    expect(out.length).toBe(501)
    expect(out[500]).toContain('还有 100 条')
  })

  it('太深的树不递归到死,而且如实说「太深」', () => {
    let deep: Record<string, unknown> = { bottom: '到底了' }
    for (let i = 0; i < 20; i += 1) deep = { next: deep }
    expect(JSON.stringify(redactJson(deep))).toContain('太深')
  })

  it('数字、布尔、null 原样', () => {
    expect(redactJson({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null })
  })
})

describe('redactPath / redactLines', () => {
  it('路径只换用户名', () => {
    expect(redactPath('/Users/example/Desktop/工作台诊断包-20260922.zip'))
      .toBe('/Users/<用户>/Desktop/工作台诊断包-20260922.zip')
  })

  it('多行一次过', () => {
    expect(redactLines(['/Users/example/a', '正常一行'])).toEqual(['/Users/<用户>/a', '正常一行'])
  })
})

describe('短编号', () => {
  it('形状是「组件缩写 + 横杠 + 时间戳后 6 位」,固定长度好念', () => {
    expect(diagCode('plugin', 1789123456789)).toBe('WB-456789')
    expect(diagCode('worker', 1789123456789)).toBe('CW-456789')
    expect(DIAG_CODE_RE.test(diagCode('butler', Date.now()))).toBe(true)
  })

  it('不足 6 位左补零 —— 长度固定,念错一位对方立刻听得出来', () => {
    expect(diagCode('plugin', 42)).toBe('WB-000042')
  })

  it('同一毫秒同一组件永远是同一个编号(纯函数,不摸时钟)', () => {
    expect(diagCode('shell', 1_000_000_042)).toBe(diagCode('shell', 1_000_000_042))
  })

  it('闭集的守卫认得自己、认不得别的', () => {
    for (const c of DIAG_COMPONENTS) expect(isDiagComponent(c)).toBe(true)
    for (const k of DIAG_KINDS) expect(isDiagKind(k)).toBe(true)
    expect(isDiagComponent('随便写的')).toBe(false)
    expect(isDiagKind('boom')).toBe(false)
  })
})
