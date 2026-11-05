/**
 * 本机端到端:**一台不在局域网里的手机,只知道中转的地址,照样进得了房、找得到电脑**。
 *
 *   node dev/account-smoke.ts
 *
 * 这是「账号搬到服务器」那张卡的验收脚本。它按真实顺序把整条链路串起来,
 * **除了 8791 与上游模型之外全是真的**:
 *
 *   ① 真的 `livekit-server --dev`(7880);
 *   ② 真的中转(relay/server/app.cjs),带这张卡新加的账号那几条路;
 *   ③ 真的注册一个账号 → 真的用会话令牌给「这台 Mac」和「这台手机」各领一把设备令牌;
 *   ④ 一个**很薄的假 8791**:它只做工人要的那两件事,而且签凭证那一下是
 *      **真的去问中转**(`POST /v1/channel-token`)—— 也就是插件那条路;
 *   ⑤ 真的工人进程(`src/main.ts`),它自己进房;
 *   ⑥ 假手机:跑的是 **butler-app 里那一份真的 `createRelayRoomSource`**
 *      (不是一份长得像的复制品),只给它中转地址与它自己那把设备令牌,
 *      **完全不给它 8791 的地址** —— 这正是"人在外面"的样子;
 *   ⑦ 手机进房之后经 `wb.rpc` 问一句 `GET /state`,看工人有没有替它去问到电脑。
 *
 * 最后再验一条边界:**另一个账号的手机领不到这一间房**。
 *
 * 少的只有音频(VAD/ASR/TTS)与真上游模型 —— 那几件与"房间归谁、谁进得来"无关。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Room } from '@livekit/rtc-node'
import { RPC_TOPIC } from '../src/rpc.ts'

/**
 * 手机那一侧用的是 **butler-app 里那份真的代码**,不是复制品 —— 这是这个脚本的价值所在。
 * 它那边的 import 不带扩展名(Vite 的 bundler 解析),Node 直接 import 不了,
 * 所以先用 esbuild 把它打成一个临时 .mjs 再动态 import。**打的是源文件本身**。
 */
async function loadPhoneSide(): Promise<{
  createRelayRoomSource: typeof import('../../butler-app/src/account/roomFromRelay.ts')['createRelayRoomSource']
  createAccountStore: typeof import('../../butler-app/src/account/accountStore.ts')['createAccountStore']
}> {
  const appDir = join(import.meta.dirname, '..', '..', 'butler-app')
  const esbuild = join(appDir, 'node_modules', '.pnpm', 'esbuild@0.25.12', 'node_modules', 'esbuild', 'bin', 'esbuild')
  const out = join(mkdtempSync(join(tmpdir(), 'wb-smoke-phone-')), 'phone.mjs')
  temps.push(out)
  const entry = join(appDir, 'src', 'account', 'phoneSideEntry.ts')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(entry, "export { createRelayRoomSource } from './roomFromRelay';\nexport { createAccountStore } from './accountStore';\n")
  temps.push(entry)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(esbuild, [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'inherit' })
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`esbuild 退出码 ${code}`))))
  })
  return import(out) as Promise<{
    createRelayRoomSource: typeof import('../../butler-app/src/account/roomFromRelay.ts')['createRelayRoomSource']
    createAccountStore: typeof import('../../butler-app/src/account/accountStore.ts')['createAccountStore']
  }>
}

const require_ = createRequire(import.meta.url)
const relayDir = join(import.meta.dirname, '..', '..', 'relay')
const { createApp } = require_(join(relayDir, 'server', 'app.cjs'))
const { relayConfigOf } = require_(join(relayDir, 'server', 'config.cjs'))
const { openRelayDb } = require_(join(relayDir, 'server', 'db.cjs'))

/** livekit-server --dev 自带的那一对(公开的开发用值,不是任何人的密钥)。 */
const LK_KEY = 'devkey'
const LK_SECRET = 'secret'
const LK_URL = 'ws://127.0.0.1:7880'

const STATE_MARK = '端到端验收用的那条事项'

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  ✓ ${label}${detail === '' ? '' : ` — ${detail}`}`) }
  else { failed += 1; console.error(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await probe().catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`等 ${what} 超时`)
}

/** 内存里的 KeyValueStore —— 假手机的"安全存储"。 */
function memoryKv() {
  const map = new Map<string, string>()
  return {
    async get(key: string) { return map.get(key) ?? null },
    async set(key: string, value: string) { map.set(key, value) },
    async remove(key: string) { map.delete(key) },
  }
}

const children: ChildProcess[] = []
const servers: Server[] = []
const temps: string[] = []

async function main(): Promise<void> {
  console.log('【一】起 livekit-server --dev')
  const livekit = spawn('livekit-server', ['--dev'], { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(livekit)
  livekit.stderr?.on('data', () => {})
  await waitFor('livekit-server', async () => (await fetch('http://127.0.0.1:7880')).status < 500)
  check('livekit-server 起来了', true)

  console.log('【二】起中转(带这张卡新加的账号那几条路)')
  const db = openRelayDb(':memory:')
  const config = relayConfigOf({
    RELAY_CHANNEL_LIVEKIT_URL: LK_URL,
    RELAY_CHANNEL_LIVEKIT_API_KEY: LK_KEY,
    RELAY_CHANNEL_LIVEKIT_API_SECRET: LK_SECRET,
  })
  const relayApp = createApp({ db, config, log: (line: string) => console.log(`    [relay] ${line}`) })
  const relayServer = await new Promise<Server>((resolve) => {
    const s = relayApp.listen(0, '127.0.0.1', () => resolve(s as Server))
  })
  servers.push(relayServer)
  const relayPort = (relayServer.address() as { port: number }).port
  const relayUrl = `http://127.0.0.1:${relayPort}`
  check('中转起来了', true, relayUrl)

  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${relayUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
  }

  console.log('【三】注册账号 → 给 Mac 与手机各领一把设备令牌')
  const registered = await post('/v1/account/register', { email_or_phone: 'smoke@example.test', password: 'hunter22' })
  check('注册成功', registered.status === 201)
  const session = registered.body.session_token as string
  check('会话令牌是 wbs_ 开头的', typeof session === 'string' && session.startsWith('wbs_'))

  const macDevice = await post('/register-device', { device_id: 'smoke-mac', name: '验收用的 Mac', kind: 'mac' }, session)
  const phoneDevice = await post('/register-device', { device_id: 'smoke-phone', name: '验收用的手机', kind: 'phone' }, session)
  check('Mac 领到设备令牌', macDevice.status === 201)
  check('手机领到设备令牌', phoneDevice.status === 201)

  const devices = await (await fetch(`${relayUrl}/v1/account/devices`, { headers: { authorization: `Bearer ${session}` } })).json() as { devices: { device_id: string }[] }
  check('「我的设备」列得出两台', devices.devices.length === 2, devices.devices.map(d => d.device_id).join(' / '))

  console.log('【四】起一个很薄的假 8791(签凭证那一下是真的去问中转)')
  let rpcSeen = 0
  const fakeWorkbench = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      void (async () => {
        const path = (req.url ?? '').split('?')[0]
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (path === '/channel/token' && req.method === 'POST') {
          // 这正是插件那条路:本机没有 secret,让中转替我们签。
          const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
          const signed = await post('/v1/channel-token', {
            identity: body.worker === true ? 'wb-channel-worker' : 'wb-dev-smoke',
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
          }, macDevice.body.token as string)
          return reply(signed.status, signed.body)
        }
        if (path === '/channel/credentials') return reply(200, { livekit: { configured: true } })
        if (path === '/state') {
          rpcSeen += 1
          return reply(200, { items: [{ id: 'smoke-1', title: STATE_MARK }], sessions: [] })
        }
        if (path === '/channel/persona') {
          return reply(200, { system_message: '你是验收用的事务官。', welcome: '我在。', items: [] })
        }
        return reply(404, { error: '这条路假 8791 不管' })
      })()
    })
  })
  await new Promise<void>(resolve => { fakeWorkbench.listen(8791, '127.0.0.1', resolve) })
  servers.push(fakeWorkbench)
  check('假 8791 起来了', true)

  console.log('【五】起真的工人进程(它自己去进房)')
  const home = mkdtempSync(join(tmpdir(), 'wb-smoke-home-'))
  temps.push(home)
  const worker = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'main.ts')], {
    env: {
      ...process.env,
      HOME: home,
      WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://127.0.0.1:8791',
      WORKBENCH_CHANNEL_ASR: 'segmented',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(worker)
  let workerLog = ''
  const note = (chunk: unknown) => { workerLog += String(chunk) }
  worker.stdout?.on('data', note)
  worker.stderr?.on('data', note)
  try { await waitFor('工人进房', async () => /进房了|进房:/.test(workerLog), 90_000) }
  catch (error) { console.error(`    [worker 日志]\n${workerLog}`); throw error }
  const roomLine = /进房:.*?(wb-[0-9a-f]{16})/.exec(workerLog)
  check('工人进房了', roomLine !== null, roomLine?.[1] ?? workerLog.slice(-200))

  console.log('【六】假手机:只给它中转地址与自己那把设备令牌,**不给 8791**')
  const { createRelayRoomSource, createAccountStore } = await loadPhoneSide()
  const store = createAccountStore(memoryKv())
  await store.save({
    relayUrl,
    deviceId: 'smoke-phone',
    deviceToken: phoneDevice.body.token as string,
    identifier: 'smoke@example.test',
    accountId: registered.body.account.id as string,
    sessionToken: session,
  })
  const source = createRelayRoomSource({ store, name: '验收用的手机' })
  const got = await source.credential()
  check('手机领到了房间凭证', got !== null && got.ok === true, got === null ? 'null' : (got.ok ? got.credential.room : got.error))
  if (got === null || !got.ok) throw new Error('手机没领到凭证,后面没法继续')
  check('房间就是工人那一间', got.credential.room === roomLine?.[1], `${got.credential.room} vs ${roomLine?.[1]}`)

  const room = new Room()
  await room.connect(got.credential.url, got.credential.token, { autoSubscribe: false, dynacast: false })
  check('手机进房了', true, `身份 ${got.credential.identity}`)
  await waitFor('房里看见工人', async () => [...room.remoteParticipants.values()].some(p => p.identity === 'wb-channel-worker'), 30_000)
  check('房里看得见工人', true)

  console.log('【七】经 wb.rpc 问电脑一句')
  const answers = new Map<string, (value: Record<string, any>) => void>()
  await room.registerTextStreamHandler(RPC_TOPIC, (reader: any) => {
    void (async () => {
      const text = await reader.readAll()
      try {
        const message = JSON.parse(text) as Record<string, any>
        const resolve = answers.get(String(message.id))
        if (resolve !== undefined) { answers.delete(String(message.id)); resolve(message) }
      } catch { /* 不是给我们的 */ }
    })()
  })
  const ask = async (id: string, path: string) => {
    const waiting = new Promise<Record<string, any>>((resolve, reject) => {
      answers.set(id, resolve)
      setTimeout(() => reject(new Error(`等 ${path} 的回答超时`)), 20_000)
    })
    await room.localParticipant?.sendText(JSON.stringify({ type: 'http', id, method: 'GET', path }), { topic: RPC_TOPIC })
    return waiting
  }
  const state = await ask('smoke-1', '/state')
  const text = JSON.stringify(state)
  check('工人替手机问到了电脑上的 /state', text.includes(STATE_MARK), text.slice(0, 160))
  check('假 8791 那边真的被问过', rpcSeen > 0, `${rpcSeen} 次`)

  console.log('【八】边界:另一个账号的手机领不到这一间房')
  const other = await post('/v1/account/register', { email_or_phone: 'someone-else@example.test', password: 'hunter22' })
  const otherDevice = await post('/register-device', { device_id: 'other-phone', kind: 'phone' }, other.body.session_token as string)
  const otherStore = createAccountStore(memoryKv())
  await otherStore.save({ relayUrl, deviceId: 'other-phone', deviceToken: otherDevice.body.token as string })
  const otherGot = await createRelayRoomSource({ store: otherStore }).credential()
  check(
    '别人的手机算出来的是另一间房',
    otherGot !== null && otherGot.ok === true && otherGot.credential.room !== got.credential.room,
    otherGot !== null && otherGot.ok ? otherGot.credential.room : 'n/a',
  )
  // 再直接拿别人的令牌去要我们这一间 —— 中转该拒。
  const stolen = await post('/v1/channel-token', { identity: 'wb-phone-evil', room: got.credential.room }, otherDevice.body.token as string)
  check('拿别人的令牌要这一间房被拒', stolen.status === 400 && stolen.body?.error?.code === 'room_not_yours', String(stolen.status))

  console.log('【九】把这台手机移除,它当场进不来')
  await post('/v1/account/devices/revoke', { device_id: 'smoke-phone' }, session)
  const afterRevoke = await createRelayRoomSource({ store }).credential()
  check(
    '移除之后领不到凭证,而且说的是人话',
    afterRevoke !== null && afterRevoke.ok === false && afterRevoke.error.includes('移除'),
    afterRevoke !== null && !afterRevoke.ok ? afterRevoke.error : 'n/a',
  )

  await room.disconnect()
  console.log(`\n结果:${passed} 通过,${failed} 失败`)
}

async function cleanup(): Promise<void> {
  for (const child of children) { try { child.kill('SIGTERM') } catch { /* 已经没了 */ } }
  await sleep(300)
  for (const child of children) { try { child.kill('SIGKILL') } catch { /* 同上 */ } }
  for (const server of servers) { await new Promise<void>(done => server.close(() => done())) }
  for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 同上 */ } }
}

main()
  .then(async () => { await cleanup(); process.exit(failed === 0 ? 0 : 1) })
  .catch(async (error: unknown) => {
    console.error(`\n炸了:${error instanceof Error ? error.message : String(error)}`)
    await cleanup()
    process.exit(1)
  })
