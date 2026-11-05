// @vitest-environment node
/**
 * 通道层在工作台这一侧(server/channel.ts)的纯函数与服务:
 * 配置怎么合、进房凭证长什么样、身份怎么拼、状态探不到时说什么、人设从哪来。
 *
 * **凭据纪律也在这里钉死**:签出来的 token 里不该出现 secret,view() 只回「配了没有」。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TasksState } from '../src/protocol.ts'
import {
  CHANNEL_DEFAULT_ROOM,
  CHANNEL_DEFAULT_URL,
  CHANNEL_DEFAULT_TOKEN_TTL_SECONDS,
  CHANNEL_DEVICE_ATTRIBUTE,
  CHANNEL_KIND_ATTRIBUTE,
  CHANNEL_WORKER_IDENTITY,
  adminGrant,
  buildChannelSystemMessage,
  buildChannelWelcome,
  channelConfigOf,
  channelIdentityOf,
  channelModeOf,
  createChannelService,
  httpUrlOf,
  joinGrant,
  participantIdentitiesOf,
  signAccessToken,
} from '../src/server/channel.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'

const NOW = Math.floor(Date.parse('2026-09-17T09:00:00Z') / 1000)
const AGENTS = `我叫 周到。

<!-- 引导:说话方式:开始 -->
- 先说结论。
<!-- 引导:说话方式:结束 -->
`

function tasksState(): TasksState {
  return {
    tasks: [
      { id: 't-1', title: '订机票', status: 'doing' },
      { id: 't-2', title: '看合同', status: 'confirm' },
    ],
    sprints: [],
    modules: [],
  } as unknown as TasksState
}

describe('配置', () => {
  it('key 或 secret 缺一个就当没配——不去猜另一半', () => {
    expect(channelConfigOf({ WORKBENCH_CHANNEL_API_KEY: 'devkey' })).toBeUndefined()
    expect(channelConfigOf({ WORKBENCH_CHANNEL_API_SECRET: 'secret' })).toBeUndefined()
    expect(channelConfigOf({})).toBeUndefined()
  })

  it('两样齐了就成,地址与房间名有默认值', () => {
    const config = channelConfigOf({ WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' })
    expect(config?.url).toBe(CHANNEL_DEFAULT_URL)
    expect(config?.room).toBe(CHANNEL_DEFAULT_ROOM)
    expect(config?.httpUrl).toBe('http://127.0.0.1:7880')
  })

  it('环境变量压过配置文件(本机跑原型时不用落任何文件)', () => {
    const config = channelConfigOf(
      { WORKBENCH_CHANNEL_API_KEY: 'from-env', WORKBENCH_CHANNEL_API_SECRET: 's' },
      { api_key: 'from-file', api_secret: 's2', url: 'wss://vps.example:443', room: '远程' },
    )
    expect(config?.apiKey).toBe('from-env')
    expect(config?.url).toBe('wss://vps.example:443')
    expect(config?.httpUrl).toBe('https://vps.example:443')
  })

  it('ws/wss 换成 http/https,已经是 http 的原样', () => {
    expect(httpUrlOf('ws://a:7880')).toBe('http://a:7880')
    expect(httpUrlOf('wss://a')).toBe('https://a')
    expect(httpUrlOf('http://a')).toBe('http://a')
  })
})

describe('进房凭证', () => {
  const token = signAccessToken({
    apiKey: 'devkey',
    apiSecret: 'secret',
    identity: 'wb-phone-d1',
    grant: joinGrant('workbench'),
    ttlSeconds: CHANNEL_DEFAULT_TOKEN_TTL_SECONDS,
    nowSeconds: NOW,
  })
  const [header, payload, signature] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>

  it('就是一个 HS256 JWT:iss = api key,sub = 身份', () => {
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(claims.iss).toBe('devkey')
    expect(claims.sub).toBe('wb-phone-d1')
    expect(claims.exp).toBe(NOW + CHANNEL_DEFAULT_TOKEN_TTL_SECONDS)
  })

  it('签名对得上(自己验一遍,免得改错了编码还以为没事)', () => {
    const expected = createHmac('sha256', 'secret').update(`${header}.${payload}`).digest('base64url')
    expect(signature).toBe(expected)
  })

  it('secret 一个字节都不在 token 里', () => {
    expect(token).not.toContain('secret')
  })

  it('手机的授权没有 roomAdmin——它不该能踢人、关房', () => {
    expect(claims.video).toEqual({ room: 'workbench', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true })
    expect(adminGrant('workbench')).toEqual({ room: 'workbench', roomAdmin: true, roomList: true })
  })
})

describe('身份', () => {
  it('工人的身份是固定的——status 就靠它判在不在房', () => {
    expect(channelIdentityOf({ worker: true })).toBe(CHANNEL_WORKER_IDENTITY)
    // worker 压过一切:就算同时给了 deviceId 也还是工人。
    expect(channelIdentityOf({ worker: true, deviceId: 'd1' })).toBe(CHANNEL_WORKER_IDENTITY)
  })

  it('手机的身份里带设备 id,奇怪字符换掉', () => {
    expect(channelIdentityOf({ deviceId: 'dev 1/../x' })).toBe('wb-phone-dev-1----x')
  })

  it('本机测试页有自己的前缀,没给后缀就是 page', () => {
    expect(channelIdentityOf({})).toBe('wb-dev-page')
    expect(channelIdentityOf({ suffix: 'chrome' })).toBe('wb-dev-chrome')
  })
})

describe('状态', () => {
  const env = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }

  function service(fetchImpl: typeof fetch) {
    return createChannelService({
      agentsFile: '/不存在/AGENTS.md',
      env,
      configFile: '/不存在/channel.json',
      fetchImpl,
      nowSeconds: () => NOW,
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
    })
  }

  it('没配就说没配,别的一律缺席', async () => {
    const bare = createChannelService({
      agentsFile: '/x',
      env: {},
      configFile: '/不存在',
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
    })
    // 2026-09-21:多了 `source` —— 「本机没配」「服务器还没下发」「还没登录」从这一版起要分得清。
    expect(await bare.status()).toEqual({
      configured: false, server: false, worker: false, source: 'none', note: '没配 LiveKit 的 api key / secret',
    })
    expect(await bare.issue({})).toBeUndefined()
    expect(await bare.view()).toEqual({
      url: CHANNEL_DEFAULT_URL, room: CHANNEL_DEFAULT_ROOM, configured: false, mode: 'local', source: 'none',
    })
  })

  it('服务器连不上:server false,并给一句能照着做的话', async () => {
    const status = await service((async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch).status()
    expect(status.server).toBe(false)
    expect(status.worker).toBe(false)
    expect(status.note).toContain('先在本机把 livekit-server 起起来')
  })

  it('服务器在但 key 不对(401):说清是 key 的问题,不说成「没起」', async () => {
    const status = await service((async () => new Response('', { status: 401 })) as unknown as typeof fetch).status()
    expect(status.server).toBe(true)
    expect(status.note).toContain('api key / secret 不对')
  })

  it('房里有工人就报 true,只有别人就报 false', async () => {
    const withWorker = await service((async () => new Response(
      JSON.stringify({ participants: [{ identity: CHANNEL_WORKER_IDENTITY }, { identity: 'wb-phone-d1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch).status()
    expect(withWorker.worker).toBe(true)
    expect(withWorker.participants).toEqual([CHANNEL_WORKER_IDENTITY, 'wb-phone-d1'])

    const without = await service((async () => new Response(
      JSON.stringify({ participants: [{ identity: 'wb-phone-d1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch).status()
    expect(without.worker).toBe(false)
  })

  it('回包读不懂就说读不懂,不当成「房里没人」', async () => {
    const status = await service((async () => new Response('不是 JSON', { status: 200 })) as unknown as typeof fetch).status()
    expect(status.server).toBe(true)
    expect(status.note).toContain('读不懂')
    expect(status.participants).toBeUndefined()
  })

  it('参与者列表解析不出来只是空,不抛', () => {
    expect(participantIdentitiesOf(null)).toEqual([])
    expect(participantIdentitiesOf({ participants: 'x' })).toEqual([])
    expect(participantIdentitiesOf({ participants: [{}, { identity: '' }, { identity: 'a' }] })).toEqual(['a'])
  })
})

describe('人设', () => {
  it('名字与说话方式取自 AGENTS.md(与通话模式同一处),事项摘要来自看板', () => {
    const message = buildChannelSystemMessage({
      agentsText: AGENTS,
      tasks: tasksState(),
      inboxName: '通道收件箱',
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
      handTool: 'wb_hand_to_butler',
    })
    expect(message).toContain('名字叫周到')
    expect(message).toContain('先说结论。')
    expect(message).toContain('在办:订机票。')
    expect(message).toContain('等我确认:看合同。')
    expect(message).toContain('通道收件箱')
    /*
     * ★★ 2026-10-02(卡「电话里像个活人」):**只有一个「我」**。
     * 以前这里钉的是「我让事务官去办,办完告诉你」—— 那句话把电话里的她说成了事务官的传话人,
     * Air 那几通里「事务官」第三人称出现 35 次,她当场问「你是什么身份?」。
     */
    expect(message).toContain('【只有一个「我」】')
    expect(message).toContain('永远说「我」')
    expect(message).not.toContain('我让事务官去办,办完告诉你')
    // 那几句第三人称**逐字列成禁例**(同「狗东西」那一条的写法:禁例里出现 ≠ 教她这么说)
    expect(message).toContain('**不许**说「我让事务官去办」「交给事务官本尊」「事务官这边」')
    // 单子上那几条工具说明里一个「本尊」都不剩
    expect(message.split('【你能做什么】')[1] ?? '').not.toContain('事务官本尊')
    // 称呼不写死「他」:这份 AGENTS 没写称呼表 → 用中性的「对方」(运营同学是女生,见 personaAddress)
    expect(message).toContain('对方在手机上跟你说话')
    expect(message).not.toContain('他在手机上跟你说话')
  })

  it('没写过 AGENTS.md 就不给她起名字', () => {
    const message = buildChannelSystemMessage({
      rememberTool: 'a', doingTool: 'b', handTool: 'c',
    })
    // 2026-09-23:不写死维护者的名字 —— 新用户的事务官会照着这句管他叫「Ben」。
    // 2026-10-02:第一句从「你是他的事务官」改成「你就是事务官」(只有一个「我」);
    // 称呼表空着时用中性的「对方」,**不编一个性别**(运营同学是女生)。
    expect(message).toContain('你就是事务官。')
    expect(message).toContain('对方在手机上跟你说话')
    expect(message).not.toContain('Ben')
    expect(buildChannelWelcome(undefined)).toBe('喂,我在,你说。')
    expect(buildChannelWelcome('周到')).toBe('喂,我是周到,你说。')
  })

  it('看板拿不到时说拿不到,不说成「没有」(D13)', () => {
    const message = buildChannelSystemMessage({ rememberTool: 'a', doingTool: 'b', handTool: 'c' })
    expect(message).toContain('这会儿拿不到')
    expect(message).not.toContain('待办:没有。')
  })

  it('工具通道永远是开着的——本机直接执行,没有「这通电话记不了事项」那种降级', () => {
    const message = buildChannelSystemMessage({ rememberTool: CALL_TOOL_REMEMBER, doingTool: 'b', handTool: 'c' })
    expect(message).toContain(CALL_TOOL_REMEMBER)
    expect(message).not.toContain('记不下来')
  })

  it('persona() 读不到 AGENTS.md / 看板也照常出得来', async () => {
    const service = createChannelService({
      agentsFile: '/不存在/AGENTS.md',
      env: {},
      configFile: '/不存在',
      tasks: { list: async () => { throw new Error('看板炸了') } },
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
    })
    const persona = await service.persona()
    expect(persona.welcome).toBe('喂,我在,你说。')
    expect(persona.butler_name).toBeUndefined()
    expect(persona.system_message).toContain('这会儿拿不到')
  })
})

/**
 * 凭证里那两项设备属性(2026-09-21 多了 `wb_kind`,座机形态:手机 + 树莓派话筒)。
 *
 * **为什么非要签进凭证**:工人按这个值决定通话的声音走哪台设备。房里自称的东西
 * 谁都能说;签在凭证里的由 8791 签、LiveKit 强制,而授权里没有 canUpdateOwnMetadata。
 */
describe('凭证里的设备属性', () => {
  const service = createChannelService({
    agentsFile: '/不存在/AGENTS.md',
    env: { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' },
    configFile: '/不存在/channel.json',
    nowSeconds: () => NOW,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
  })

  const claims = async (input: Parameters<typeof service.issue>[0]): Promise<Record<string, unknown>> => {
    const issued = await service.issue(input)
    if (issued === undefined) throw new Error('应当签得出')
    return JSON.parse(Buffer.from(issued.token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
  }

  it('树莓派话筒那张签着 wb_kind=handset', async () => {
    const payload = await claims({ deviceId: 'pi-1', kind: 'handset' })
    expect(payload.attributes).toEqual({ [CHANNEL_DEVICE_ATTRIBUTE]: 'pi-1', [CHANNEL_KIND_ATTRIBUTE]: 'handset' })
    expect(payload.sub).toBe('wb-phone-pi-1')
  })

  it('没报 kind 的老调用方缺省是 phone(行为与 2026-09-21 之前逐字相同)', async () => {
    const payload = await claims({ deviceId: 'dev-1' })
    expect(payload.attributes).toEqual({ [CHANNEL_DEVICE_ATTRIBUTE]: 'dev-1', [CHANNEL_KIND_ATTRIBUTE]: 'phone' })
  })

  it('工人自己那张一项属性都不带 —— 它不是一台设备,也不该被降权成谁', async () => {
    const payload = await claims({ worker: true })
    expect(payload.attributes).toBeUndefined()
    expect(payload.sub).toBe(CHANNEL_WORKER_IDENTITY)
  })

  it('本机测试页那张也不带 —— 它够不到 8791', async () => {
    expect((await claims({ suffix: 'chrome' })).attributes).toBeUndefined()
  })
})
