/**
 * 房间代理的协议与白名单(2026-09-17)。房间那一层在 agent.ts 里,这里全是纯的:
 * 一行 JSON 进、一条回包出,不起房间、不发请求。
 *
 * 这几条用例里最要紧的是「哪些路不给走」—— 房间里的输入是整条链上最不可控的一处。
 */
import { describe, expect, it } from 'vitest'
import {
  DEVICE_ATTRIBUTE,
  FILE_TOPIC,
  LEGACY_FILE_TOPIC,
  RPC_TOPIC,
  WORKER_IDENTITY,
  deviceIdOfParticipant,
  encodeCaption,
  encodeRpcResponse,
  handleRpcRequest,
  isAllowedRpcPath,
  KIND_ATTRIBUTE,
  parseRpcRequest,
  participantKindOf,
  pickSpeaker,
  splitPath,
} from '../src/rpc.ts'

/** 两端唯一的约定。改这几个字符串就等于改协议,手机那一侧要一起改。 */
describe('两端的约定', () => {
  it('topic 与工人身份是写死的', () => {
    expect(RPC_TOPIC).toBe('wb.rpc')
    expect(FILE_TOPIC).toBe('wb.file')
    expect(LEGACY_FILE_TOPIC).toBe('wb-file')
    expect(WORKER_IDENTITY).toBe('wb-channel-worker')
    expect(DEVICE_ATTRIBUTE).toBe('wb_device_id')
  })
})

describe('读一条请求', () => {
  it('http 请求:方法大小写不计,body 可以没有', () => {
    const parsed = parseRpcRequest(JSON.stringify({ id: 'a1', type: 'http', method: 'get', path: '/state' }))
    expect(parsed).toEqual({ ok: true, request: { id: 'a1', type: 'http', method: 'GET', path: '/state' } })
  })

  it('renew 只要一个 id', () => {
    expect(parseRpcRequest('{"id":"a2","type":"renew"}')).toEqual({ ok: true, request: { id: 'a2', type: 'renew' } })
  })

  it('缺 id 就不回——回不到人身上,发出去只是噪音', () => {
    const parsed = parseRpcRequest('{"type":"http","method":"GET","path":"/state"}')
    expect(parsed).toEqual({ ok: false, error: '缺 id' })
    expect((parsed as { id?: string }).id).toBeUndefined()
  })

  it('坏 JSON、不是对象、不认识的 type / method 都如实说,不猜', () => {
    expect(parseRpcRequest('{{')).toEqual({ ok: false, error: '不是合法 JSON' })
    expect(parseRpcRequest('"x"')).toEqual({ ok: false, error: '不是一个对象' })
    expect(parseRpcRequest('{"id":"a","type":"ping"}')).toEqual({ ok: false, id: 'a', error: '不认识这种请求:ping' })
    expect(parseRpcRequest('{"id":"a","type":"http","method":"PATCH","path":"/x"}'))
      .toEqual({ ok: false, id: 'a', error: '不认识这个方法:PATCH' })
    expect(parseRpcRequest('{"id":"a","type":"http","method":"GET"}')).toEqual({ ok: false, id: 'a', error: '缺 path' })
  })

  it('body 是 null 当成没有 body(手机那边 path 没 body 时就填 null)', () => {
    const parsed = parseRpcRequest('{"id":"a","type":"http","method":"POST","path":"/butler/item","body":null}')
    expect(parsed).toEqual({ ok: true, request: { id: 'a', type: 'http', method: 'POST', path: '/butler/item' } })
  })
})

describe('路径规整', () => {
  it('query 拆出来单独带,白名单只按 path 比', () => {
    expect(splitPath('/onboarding/turns?after=3')).toEqual({ path: '/onboarding/turns', query: '?after=3' })
    expect(splitPath('/state')).toEqual({ path: '/state', query: '' })
  })

  it('不以 / 开头、带 .. 、带 // 、带反斜杠一律拒——白名单是按字符串比的,不能让它绕过去', () => {
    expect(splitPath('state')).toBeUndefined()
    expect(splitPath('/butler/../credentials')).toBeUndefined()
    expect(splitPath('//state')).toBeUndefined()
    expect(splitPath('/state\\\\x')).toBeUndefined()
  })
})

describe('白名单', () => {
  it('只为已确认的协作页面开放三条精确路由和方法', () => {
    expect(isAllowedRpcPath('POST', '/task/comment')).toBe(true)
    expect(isAllowedRpcPath('GET', '/collab/relay/studio')).toBe(true)
    expect(isAllowedRpcPath('GET', '/collab/relay/channel')).toBe(true)
    expect(isAllowedRpcPath('GET', '/task/comment')).toBe(false)
    expect(isAllowedRpcPath('POST', '/collab/relay/studio')).toBe(false)
    expect(isAllowedRpcPath('GET', '/collab/relay/studio/extra')).toBe(false)
  })

  it('三条协作 RPC 经已有 callAsDevice 转发且保留请求 id、query 与 body', async () => {
    const calls: unknown[] = []
    for (const request of [
      { id: 'comment-1', type: 'http' as const, method: 'POST' as const, path: '/task/comment', body: { task_id: 't-1', text: '补充' } },
      { id: 'studio-1', type: 'http' as const, method: 'GET' as const, path: '/collab/relay/studio?after=3' },
      { id: 'channel-1', type: 'http' as const, method: 'GET' as const, path: '/collab/relay/channel' },
    ]) {
      const response = await handleRpcRequest(request, {
        deviceId: 'device-1',
        workbench: {
          callAsDevice: async input => { calls.push(input); return { status: 200, body: { ok: true } } },
          renewTicket: async () => ({ error: 'unused', status: 500 }),
        },
      })
      expect(response).toEqual({ id: request.id, type: 'http', status: 200, body: { ok: true } })
    }
    expect(calls).toEqual([
      { deviceId: 'device-1', method: 'POST', path: '/task/comment', body: { task_id: 't-1', text: '补充' } },
      { deviceId: 'device-1', method: 'GET', path: '/collab/relay/studio?after=3' },
      { deviceId: 'device-1', method: 'GET', path: '/collab/relay/channel' },
    ])
  })

  it('手机现在用到的那几条放行', () => {
    expect(isAllowedRpcPath('GET', '/state')).toBe(true)
    expect(isAllowedRpcPath('POST', '/butler/item')).toBe(true)
    expect(isAllowedRpcPath('POST', '/butler/item/say')).toBe(true)
    expect(isAllowedRpcPath('GET', '/butler/item/t-1/turns')).toBe(true)
    // 点开「某家在跑的一条会话」(2026-09-25,卡 P):只读的那一条;写的、别的路径照旧挡。
    expect(isAllowedRpcPath('GET', '/sessions/digest')).toBe(true)
    expect(isAllowedRpcPath('POST', '/sessions/digest')).toBe(false)
    expect(isAllowedRpcPath('GET', '/sessions/digest/x')).toBe(false)
    // Agent 登记表的外层那一句(卡 Q):出了局域网也按得动「知道了 / 这不是 Agent」;登记表诊断那一条不开。
    expect(isAllowedRpcPath('POST', '/agents/connect')).toBe(true)
    expect(isAllowedRpcPath('POST', '/agents/not-agent')).toBe(true)
    expect(isAllowedRpcPath('POST', '/agents/notice/dismiss')).toBe(true)
    expect(isAllowedRpcPath('GET', '/agents')).toBe(false)
    expect(isAllowedRpcPath('POST', '/channel/call-state')).toBe(false)
    // 别家会话在等他,手机上答(2026-09-25,卡 T):只放「答」这一条;「去回答」只在电脑上用。
    expect(isAllowedRpcPath('POST', '/sessions/answer')).toBe(true)
    expect(isAllowedRpcPath('POST', '/sessions/ask/dismiss')).toBe(true)
    expect(isAllowedRpcPath('GET', '/sessions/answer')).toBe(false)
    expect(isAllowedRpcPath('POST', '/sessions/reveal')).toBe(false)
    // 手机替她批准(2026-10-01,卡 AP):在外面也读得到弹窗上那几颗键;只开 POST。
    expect(isAllowedRpcPath('POST', '/sessions/approval/read')).toBe(true)
    expect(isAllowedRpcPath('GET', '/sessions/approval/read')).toBe(false)
    expect(isAllowedRpcPath('GET', '/onboarding')).toBe(true)
    expect(isAllowedRpcPath('POST', '/onboarding/say')).toBe(true)
    expect(isAllowedRpcPath('GET', '/butler/appearance')).toBe(true)
    expect(isAllowedRpcPath('POST', '/butler/call/record')).toBe(true)
  })

  /**
   * 就一条资讯深聊(2026-10-13,卡「播客页重做」)。资讯与播客的用法是通勤路上,
   * 所以这四条窄路要走得通;**`/task/create` 与 `/note/add` 照旧不进来** ——
   * 深聊那两颗键走的是 8791 上只收「哪条 + 一句话」的窄路,不是「让房间能编看板 / 写私记」。
   */
  it('/feed/dig 那四条放行;/task/create 与 /note/add 照旧挡着', () => {
    expect(isAllowedRpcPath('POST', '/feed/dig')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feed/dig/note')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feed/dig/task')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feed/dig/call')).toBe(true)
    expect(isAllowedRpcPath('GET', '/feed/dig')).toBe(false)
    expect(isAllowedRpcPath('POST', '/feed/dig/whatever')).toBe(false)
    expect(isAllowedRpcPath('POST', '/task/create')).toBe(false)
    expect(isAllowedRpcPath('POST', '/note/add')).toBe(false)
    // 播客音频照旧不走这条 JSON 通道(几 MB 的字节,见 rpc.ts 文件头那条规矩)。
    expect(isAllowedRpcPath('GET', '/feed/podcast')).toBe(false)
  })

  it('/channel/status 与 /channel/token 放行(手机要知道电脑那头在不在、要能续凭证)', () => {
    expect(isAllowedRpcPath('GET', '/channel/status')).toBe(true)
    expect(isAllowedRpcPath('POST', '/channel/token')).toBe(true)
  })

  /**
   * 「添加座机」最后一步(2026-09-27,卡 HS):手机请电脑替座机在账号里登记一次。
   * 手机跟座机之间是蓝牙,跟电脑之间这一下多半**不在同一个网** —— 走不了房间的话,
   * 整条配网就只能在家里的 Wi-Fi 上做。**只开 POST 这一条**:relay-device 是扫码配对时
   * 顺手做的(那时必然同网),不进来。
   */
  it('/channel/relay-handset 放行(座机的账号登记由电脑代办);relay-device 照旧不进来', () => {
    expect(isAllowedRpcPath('POST', '/channel/relay-handset')).toBe(true)
    expect(isAllowedRpcPath('GET', '/channel/relay-handset')).toBe(false)
    expect(isAllowedRpcPath('POST', '/channel/relay-device')).toBe(false)
  })

  /**
   * 放 / 清演示数据(2026-10-13,卡「演示数据一键放进去」):它在她看板上建十几张卡、
   * 往任务账上记一摞记录、还会跑一遍早报 —— 这条能力不交给远端(同 `/meeting/seed-demo` 的门)。
   */
  it('/demo/seed 与 /demo/clear 都**不进**白名单(只给本机)', () => {
    expect(isAllowedRpcPath('POST', '/demo/seed')).toBe(false)
    expect(isAllowedRpcPath('POST', '/demo/clear')).toBe(false)
    expect(isAllowedRpcPath('GET', '/demo/seed')).toBe(false)
  })

  it('改信任边界、碰本机进程、拿凭据的那些一条都不给走', () => {
    for (const path of ['/pair/start', '/pair/claim', '/pair/revoke', '/lan', '/credentials', '/channel/start', '/channel/stop', '/channel/persona', '/helper']) {
      expect(isAllowedRpcPath('POST', path)).toBe(false)
      expect(isAllowedRpcPath('GET', path)).toBe(false)
    }
  })

  it('二进制/大文件那条代理不给走——wb.rpc 是一条 JSON 通道', () => {
    expect(isAllowedRpcPath('GET', '/butler/proxy/api/avatars')).toBe(false)
    expect(isAllowedRpcPath('POST', '/butler/proxy/api/tts')).toBe(false)
  })

  it('方法也算数:白名单里是 GET 的,POST 过来照样不给', () => {
    expect(isAllowedRpcPath('POST', '/state')).toBe(false)
    expect(isAllowedRpcPath('DELETE', '/butler/item')).toBe(false)
  })

  it('事项 id 那条是按形状比的,塞路径进去也绕不过去', () => {
    expect(isAllowedRpcPath('GET', '/butler/item/t-1/turns')).toBe(true)
    expect(isAllowedRpcPath('GET', '/butler/item/t-1/turns/x')).toBe(false)
    expect(isAllowedRpcPath('GET', '/butler/item/a.b/turns')).toBe(false)
  })

  it('/questions/answer 放行,只认 POST(手机在外面也得答得了事务官问的话)', () => {
    // 2026-09-25,卡 M 补:8791 开了这条、表里漏了,出了局域网一点选项就 403。
    expect(isAllowedRpcPath('POST', '/questions/answer')).toBe(true)
    expect(isAllowedRpcPath('GET', '/questions/answer')).toBe(false)
  })
})

describe('这个参与者是哪台设备', () => {
  it('属性优先——凭证里签的那份是原样的', () => {
    expect(deviceIdOfParticipant({ identity: 'wb-phone-abc', attributes: { wb_device_id: 'abc-DEF.99' } })).toBe('abc-DEF.99')
  })

  it('没有属性就从 identity 前缀拆', () => {
    expect(deviceIdOfParticipant({ identity: 'wb-phone-abc' })).toBe('abc')
  })

  it('不是手机的一律 undefined——测试页、工人自己、空身份都够不到 8791', () => {
    expect(deviceIdOfParticipant({ identity: 'wb-dev-page', attributes: { wb_device_id: '偷来的' } })).toBeUndefined()
    expect(deviceIdOfParticipant({ identity: 'wb-channel-worker' })).toBeUndefined()
    expect(deviceIdOfParticipant({ identity: '' })).toBeUndefined()
    expect(deviceIdOfParticipant({ identity: 'wb-phone-' })).toBeUndefined()
  })
})

describe('办一条请求', () => {
  function port(overrides: Partial<Parameters<typeof handleRpcRequest>[1]['workbench']> = {}) {
    const calls: unknown[] = []
    return {
      calls,
      workbench: {
        callAsDevice: async (input: unknown) => { calls.push(input); return { status: 200, body: { ok: true } } },
        renewTicket: async () => ({ token: 'tok', expires_at: 123 }),
        ...overrides,
      } as Parameters<typeof handleRpcRequest>[1]['workbench'],
    }
  }

  it('白名单里的路转给 8791,query 原样带上,设备 id 一起带', async () => {
    const p = port()
    const response = await handleRpcRequest(
      { id: 'a', type: 'http', method: 'GET', path: '/onboarding/turns?after=3' },
      { deviceId: 'dev-1', workbench: p.workbench },
    )
    expect(response).toEqual({ id: 'a', type: 'http', status: 200, body: { ok: true } })
    expect(p.calls).toEqual([{ deviceId: 'dev-1', method: 'GET', path: '/onboarding/turns?after=3' }])
  })

  it('不在白名单里就 403,而且**根本不发出去**', async () => {
    const p = port()
    const response = await handleRpcRequest(
      { id: 'a', type: 'http', method: 'POST', path: '/pair/start' },
      { deviceId: 'dev-1', workbench: p.workbench },
    )
    expect(response).toEqual({
      id: 'a',
      type: 'http',
      status: 403,
      body: { error: 'POST /pair/start 不在房间代理的白名单里' },
    })
    expect(p.calls).toEqual([])
  })

  it('路径不合法就 400,同样不发出去', async () => {
    const p = port()
    const response = await handleRpcRequest(
      { id: 'a', type: 'http', method: 'GET', path: '/butler/../credentials' },
      { deviceId: 'dev-1', workbench: p.workbench },
    )
    expect((response as { status: number }).status).toBe(400)
    expect(p.calls).toEqual([])
  })

  it('8791 回的 403 / 409 原样转回去——房里那头要的是真回答', async () => {
    const p = port({ callAsDevice: async () => ({ status: 409, body: { error: '这件事的会话没开' } }) })
    const response = await handleRpcRequest(
      { id: 'a', type: 'http', method: 'POST', path: '/butler/item/say', body: { id: 't-1', text: 'x' } },
      { deviceId: 'dev-1', workbench: p.workbench },
    )
    expect(response).toEqual({ id: 'a', type: 'http', status: 409, body: { error: '这件事的会话没开' } })
  })

  it('工作台连不上 → 502,不抛', async () => {
    const p = port({ callAsDevice: async () => { throw new Error('ECONNREFUSED') } })
    const response = await handleRpcRequest(
      { id: 'a', type: 'http', method: 'GET', path: '/state' },
      { deviceId: 'dev-1', workbench: p.workbench },
    )
    expect(response).toEqual({ id: 'a', type: 'http', status: 502, body: { error: '工作台连不上' } })
  })

  it('renew 回一张新凭证', async () => {
    const p = port()
    expect(await handleRpcRequest({ id: 'r', type: 'renew' }, { deviceId: 'dev-1', workbench: p.workbench }))
      .toEqual({ id: 'r', type: 'token', token: 'tok', expires_at: 123 })
  })

  it('renew 没成就如实说是什么原因(设备刚被解除配对那种)', async () => {
    const p = port({ renewTicket: async () => ({ status: 401, error: '这台设备没配对过,或者已经解除配对了' }) })
    expect(await handleRpcRequest({ id: 'r', type: 'renew' }, { deviceId: 'dev-1', workbench: p.workbench }))
      .toEqual({ id: 'r', type: 'error', error: '这台设备没配对过,或者已经解除配对了' })
  })
})

describe('编码', () => {
  it('回包就是一行 JSON', () => {
    expect(encodeRpcResponse({ id: 'a', type: 'http', status: 200, body: { x: 1 } }))
      .toBe('{"id":"a","type":"http","status":200,"body":{"x":1}}')
  })

  it('太大的回包换成 413,而不是发半截 JSON 过去', () => {
    const huge = { id: 'a', type: 'http' as const, status: 200, body: { blob: 'x'.repeat(2 * 1024 * 1024) } }
    const parsed = JSON.parse(encodeRpcResponse(huge)) as { status: number, body: { error: string } }
    expect(parsed.status).toBe(413)
    expect(parsed.body.error).toContain('太大')
  })

  it('字幕就是那四个字段', () => {
    expect(JSON.parse(encodeCaption({ type: 'caption', role: 'me', text: '记一下', final: false })))
      .toEqual({ type: 'caption', role: 'me', text: '记一下', final: false })
  })
})

/**
 * 声音跟谁走(2026-09-21,座机形态:手机 + 树莓派话筒)。
 *
 * 这一组钉住的是这张卡里唯一一处会让人「听不见对方」的判断:房里同时有手机和
 * 树莓派话筒时,麦克风接哪一位。挑错的后果不是报错,是他拿着听筒说话而她在听手机。
 */
describe('这一通的声音跟谁走', () => {
  const kinds = (map: Record<string, 'phone' | 'handset'>) => (id: string) => map[id] ?? 'phone'

  it('属性里写着 handset 的才是话筒,别的一律当手机', () => {
    expect(participantKindOf({ attributes: { [KIND_ATTRIBUTE]: 'handset' } })).toBe('handset')
    expect(participantKindOf({ attributes: { [KIND_ATTRIBUTE]: 'phone' } })).toBe('phone')
    // 老手机的凭证里压根没有这一项 —— 缺省是手机,不是「看不懂」。
    expect(participantKindOf({ attributes: {} })).toBe('phone')
    expect(participantKindOf({})).toBe('phone')
    // 认不出来的值当手机:把一台看不懂的设备当成听筒,会把声音送错地方。
    expect(participantKindOf({ attributes: { [KIND_ATTRIBUTE]: 'HANDSET' } })).toBe('phone')
  })

  it('★ 房里同时有手机和话筒时跟话筒走', () => {
    const picked = pickSpeaker(
      ['wb-phone-mobile', 'wb-phone-pi'],
      kinds({ 'wb-phone-pi': 'handset' }),
    )
    expect(picked).toBe('wb-phone-pi')
  })

  it('话筒后进房也接得上(它开机比 Mac 慢)', () => {
    const picked = pickSpeaker(
      ['wb-phone-mobile', 'wb-phone-pi'],
      kinds({ 'wb-phone-pi': 'handset' }),
      'wb-phone-mobile',
    )
    // 现任还在房里就不换 —— 老行为,这条**故意**压过「跟话筒走」:
    // 他正对着手机说话,不该因为派刚上电就被切走。
    expect(picked).toBe('wb-phone-mobile')
  })

  it('现任走了才轮到下一位', () => {
    expect(pickSpeaker(['wb-phone-pi'], kinds({ 'wb-phone-pi': 'handset' }), 'wb-phone-mobile'))
      .toBe('wb-phone-pi')
  })

  it('没有话筒时跟手机走(2026-09-21 之前的行为,逐字不变)', () => {
    expect(pickSpeaker(['wb-dev-page', 'wb-phone-mobile'], kinds({}))).toBe('wb-phone-mobile')
  })

  it('房里只有测试页就挑它', () => {
    expect(pickSpeaker(['wb-dev-page'], kinds({}))).toBe('wb-dev-page')
  })

  it('房里没人就是没人', () => {
    expect(pickSpeaker([], kinds({}))).toBeUndefined()
  })

  it('自称 handset 但身份不是一台配对设备的,不算话筒', () => {
    // 测试页拿的是 `wb-dev-` 那种身份,而属性要 8791 按设备令牌签才有 ——
    // 这一条钉住「两道门都过了才算」。
    expect(pickSpeaker(['wb-dev-page'], kinds({ 'wb-dev-page': 'handset' })))
      .toBe('wb-dev-page')
    expect(pickSpeaker(['wb-dev-page', 'wb-phone-mobile'], kinds({ 'wb-dev-page': 'handset' })))
      .toBe('wb-phone-mobile')
  })
})

/**
 * 需求卡与选题卡的那几条(2026-09-23,中秋断点 A)。**逐条钉**:
 * 放行的一条一条点名,没放行的也一条一条点名 —— 房间白名单是这条链上的第一道门,
 * 「谁在表里」和「谁故意不在表里」同样要有人守着。
 */
describe('白名单:需求卡与选题卡', () => {
  it('需求卡那四条放行(读产物 / 推进 / 把关 / 写进决策记录)', () => {
    expect(isAllowedRpcPath('POST', '/feature/docs')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feature/run')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feature/review')).toBe(true)
    expect(isAllowedRpcPath('POST', '/feature/record')).toBe(true)
  })

  /**
   * ★ 2026-09-23:第五条。Ben 明知地点头 ——「手机在外面按一下会合并 main 并发一版」
   * (docs/设计-同一个事务官-2026-09-23.md 第四节)。重的那一下由手机上的二次确认把着,
   * 不靠"只认本机"把她自己挡在外面。
   */
  it('★ 发版那一条放行(手机在外面按得动,代价 Ben 明知)', () => {
    expect(isAllowedRpcPath('POST', '/feature/ship')).toBe(true)
    // 只认 POST,别的方法一律不认。
    expect(isAllowedRpcPath('GET', '/feature/ship')).toBe(false)
  })

  /**
   * 事务官自己在这台 Mac 上回结果/开分支用的那两条 —— 手机上**没有调用方**,不放。
   * 这不是"手机权限低"(8791 那边它们与 ship 同一道门,配对设备走得通),
   * 是这个文件开头那条老规矩:只放手机现在真的用到的那几条。
   */
  it('回结果 / 开分支那两条不放行——它们是电脑上的事务官自己在报,手机没有调用方', () => {
    expect(isAllowedRpcPath('POST', '/feature/result')).toBe(false)
    expect(isAllowedRpcPath('POST', '/feature/branch')).toBe(false)
  })

  it('选题卡那三条放行(与需求卡同一套,少一条 record —— 选题没有那一件)', () => {
    expect(isAllowedRpcPath('POST', '/topic/docs')).toBe(true)
    expect(isAllowedRpcPath('POST', '/topic/run')).toBe(true)
    expect(isAllowedRpcPath('POST', '/topic/review')).toBe(true)
    // 8791 那边压根没有这条路(FEATURE_DECK_PATHS 才有 record),表里也就不该有。
    expect(isAllowedRpcPath('POST', '/topic/record')).toBe(false)
  })

  it('写回产物那两条**不放行**——手机上四个页签只读,今天没有调用方', () => {
    expect(isAllowedRpcPath('POST', '/feature/doc/save')).toBe(false)
    expect(isAllowedRpcPath('POST', '/topic/doc/save')).toBe(false)
  })

  it('建卡 / 改卡不放行——`/task/update` 收的是一整张卡,为推一格进度不值当', () => {
    expect(isAllowedRpcPath('POST', '/task/create')).toBe(false)
    expect(isAllowedRpcPath('POST', '/task/update')).toBe(false)
    expect(isAllowedRpcPath('DELETE', '/task/delete')).toBe(false)
    // 老的那一条仍然只放「挪一格」,这一版一个字没动。
    expect(isAllowedRpcPath('POST', '/task/move')).toBe(true)
    // 卡 O(2026-09-25):手机事项详情的「停掉这一件」、到上限的三颗键、派不出去时换一家 / 事务官自己做。
    expect(isAllowedRpcPath('POST', '/butler/item/stop')).toBe(true)
    expect(isAllowedRpcPath('POST', '/butler/item/budget')).toBe(true)
    // 卡 BS2(2026-09-28):「事务官自己做」那一支拿掉了,白名单里也没了。
    expect(isAllowedRpcPath('POST', '/butler/item/self')).toBe(false)
    expect(isAllowedRpcPath('POST', '/dispatch/run')).toBe(true)
    // 在 Mac 上开窗口的两条不进(只认回环)
    expect(isAllowedRpcPath('POST', '/agents/login')).toBe(false)
    expect(isAllowedRpcPath('POST', '/agents/show')).toBe(false)
  })

  /**
   * ★ 2026-09-23 起 8791 那边这两条**已经给配对设备走了**(「同一个事务官」:派活是事务官
   * 的核心活)。这里仍然不放,理由换成了「手机上没有调用方」—— 手机点的是
   * 「让事务官推进这一步」,派哪只手由事务官按技能决定。
   */
  it('派活直连那两条不放行——手机上没有那颗键(不是权限,是没有调用方)', () => {
    expect(isAllowedRpcPath('POST', '/dispatch/client')).toBe(false)
    expect(isAllowedRpcPath('POST', '/dispatch/api')).toBe(false)
  })

  it('接技能那两条也不放行——同上,手机上没有那一页', () => {
    expect(isAllowedRpcPath('POST', '/config/skill/apply')).toBe(false)
    expect(isAllowedRpcPath('POST', '/config/ops-skills/apply')).toBe(false)
  })

  it('选题的素材与「在 Mac 上打开文件夹」不放行', () => {
    expect(isAllowedRpcPath('POST', '/topic/assets')).toBe(false)
    expect(isAllowedRpcPath('POST', '/topic/open')).toBe(false)
  })

  it('方法也算数:这几条都只认 POST', () => {
    for (const path of ['/feature/docs', '/feature/run', '/feature/review', '/feature/record',
      '/feature/ship', '/topic/docs', '/topic/run', '/topic/review']) {
      expect(isAllowedRpcPath('GET', path)).toBe(false)
      expect(isAllowedRpcPath('DELETE', path)).toBe(false)
    }
  })

  it('表外的那一条仍然 403,而且如实说是哪条路不给走', async () => {
    const calls: unknown[] = []
    const response = await handleRpcRequest(
      { id: 'r1', type: 'http', method: 'POST', path: '/feature/doc/save', body: { id: 't-1' } },
      {
        deviceId: 'dev-1',
        workbench: {
          callAsDevice: async (input) => { calls.push(input); return { status: 200, body: {} } },
          renewTicket: async () => ({ error: '用不到', status: 500 }),
        },
      },
    )
    expect(response).toEqual({
      id: 'r1',
      type: 'http',
      status: 403,
      body: { error: 'POST /feature/doc/save 不在房间代理的白名单里' },
    })
    // **一个字节都没转发出去**:403 是在工人这一侧挡下的,8791 压根没被打扰。
    expect(calls).toEqual([])
  })

  it('放行的那一条按设备身份原样转发(带 body、带 query)', async () => {
    const calls: unknown[] = []
    const response = await handleRpcRequest(
      { id: 'r2', type: 'http', method: 'POST', path: '/feature/run', body: { id: 't-7', note: '第三件没验' } },
      {
        deviceId: 'dev-1',
        workbench: {
          callAsDevice: async (input) => { calls.push(input); return { status: 200, body: { ok: true } } },
          renewTicket: async () => ({ error: '用不到', status: 500 }),
        },
      },
    )
    expect(calls).toEqual([{ deviceId: 'dev-1', method: 'POST', path: '/feature/run', body: { id: 't-7', note: '第三件没验' } }])
    expect(response).toEqual({ id: 'r2', type: 'http', status: 200, body: { ok: true } })
  })

  it('8791 那边今天回的 403 原样带回来——放行不等于那边给走', async () => {
    // 那几条路由眼下判的是 loopback,而经房间代理的请求是**降权过的设备请求**。
    // 工人不替它编一句更好听的话:界面上要能看见电脑那头说了什么。
    const response = await handleRpcRequest(
      { id: 'r3', type: 'http', method: 'POST', path: '/feature/docs', body: { id: 't-7' } },
      {
        deviceId: 'dev-1',
        workbench: {
          callAsDevice: async () => ({ status: 403, body: { error: '只能在本机操作需求目录' } }),
          renewTicket: async () => ({ error: '用不到', status: 500 }),
        },
      },
    )
    expect(response).toEqual({ id: 'r3', type: 'http', status: 403, body: { error: '只能在本机操作需求目录' } })
  })
})

describe('事项详情里「现在到哪」那三颗出了局域网也按得动(2026-09-25,卡 N)', () => {
  it('说一句 / 现在核一次 / 派给 X 进白名单(只 POST);别的进度口子不放', () => {
    expect(isAllowedRpcPath('POST', '/progress/said')).toBe(true)
    expect(isAllowedRpcPath('POST', '/progress/check')).toBe(true)
    expect(isAllowedRpcPath('POST', '/item/drive')).toBe(true)
    expect(isAllowedRpcPath('GET', '/item/drive')).toBe(false)
    // 「XX 到哪了」手机上走 /butler/item(当场按证据答),不开 /progress/ask 这条。
    expect(isAllowedRpcPath('POST', '/progress/ask')).toBe(false)
  })
})
