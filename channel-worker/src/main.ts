/**
 * 工人进程的入口。`node src/main.ts`(Node 26 原生剥类型,不用编译)。
 *
 * 起来之后做的事,按顺序:
 *   1. 读配置(全是环境变量,默认本机)并**把实际用上的那几项打出来** —— 配错了看一眼日志就知道;
 *   2. 找接话模型的 key(找不到不退出:照常进房收发文件,如实说一句「这一轮不接话」);
 *   3. 加载 Silero VAD(框架自带,约 3 秒);
 *   4. 向 8791 要一张进房凭证,进房,接线;**断了就退避重来**(见 runForever)。
 *
 * 日志里**永远不会出现任何密钥**:只会出现「有/没有」。
 */
import { initializeLogger } from '@livekit/agents'
import { VAD } from '@livekit/agents-plugin-silero'
import { applyModelChoice, channelModelNow, resolveChannelModel } from './modelChoice.ts'
import { startChannelAgent } from './agent.ts'
import { FreshVAD } from './audio/freshVad.ts'
import { LoadGuard, loadGuardSettingsOf } from './loadGuard.ts'
import { CallStateReporter, postCallState } from './callStateReport.ts'
import { workerRouteOf } from './twoRooms.ts'
import { channelWorkerConfigOf } from './config.ts'
import { defaultOutboxDir } from './files/outbox.ts'
import { probeTtsBackend } from './tts/backend.ts'
import { startTextTurnServer, textTurnSettingsOf } from './textTurn.ts'
import { createWorkbenchClient } from './workbench.ts'
import { applyFamilyPool } from './agentName.ts'
import { createParentWatch, createShutdown, parentPidOf } from './lifeline.ts'

/**
 * 进程级兜底(2026-09-18,Ben 真机:8792 没起来时工人一启动就崩、一秒重启一次)。
 *
 * **这是最后一道,不是第一道**:该接住的地方都自己接住了(TTS 见 tts/butlerTts.ts、
 * ASR 见 asr/segmentedStt.ts、进不了房见下面的退避梯子)。这一道只管**漏网的**那些 ——
 * 第三方库里某条我们没经手的 promise 拒绝了。常驻进程的职责是「一直在」:
 * 记一行接着跑,比带着一条干净的栈退出有用得多。
 *
 * `uncaughtException` **故意不接**:那是同步栈崩了,继续跑意味着状态可能已经坏了;
 * 那时候退出、由插件把它拉起来重新进房才是对的(见 workbench-plugin/src/server/channelWorker.ts)。
 */
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  console.error(`[channel-worker] 有一条没接住的 Promise 拒绝(进程照常活着):${message}`)
})

/**
 * 重新进房的退避梯子(毫秒)。工人会遇到两种断:
 *   - livekit-server 重启 / 网络抖一下 → 头两次很快就能回去;
 *   - 8791 还没起、凭证签不出来 → 得等,而且不该把日志刷满。
 * 所以前快后慢,最长一分钟一次,**不放弃** —— 常驻进程的职责就是「一直在」;
 * 真的起不来那一层由插件那边的上限管(workbench-plugin/src/server/channelWorker.ts)。
 */
const REJOIN_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000, 60_000]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `node src/main.ts --selfcheck`:**这一份工人包搬到这台机器上之后,还起得来吗**
 * (2026-09-18,「工人包瘦身」那张卡)。
 *
 * 为什么非有它不可:瘦身干的事就是**从 node_modules 里删东西**。删多了的表现不是编译错,
 * 是几天之后 Ben 打电话时她不出声。所以打包脚本在**打包之前**就在解开的那棵树上跑一次这个
 * —— 它把三样原生模块全都真的加载一遍:
 *
 *   1. `@livekit/rtc-node`   进房要它(rtc-node.darwin-arm64.node);
 *   2. `sharp`               `@livekit/agents` 一进来就 import 它(llm/utils.js),少了直接崩;
 *   3. `onnxruntime-node`    Silero VAD 真加载一次模型 —— 这一条最贵也最要紧,
 *                            因为瘦身正是拿 onnxruntime 的原生库开的刀。
 *
 * **不连网、不进房、不要 key**:它问的只有"这棵树完不完整",不是"这台机器配好了没有"。
 */
async function selfCheck(): Promise<void> {
  initializeLogger({ pretty: true, level: 'warn' })
  console.log(`[channel-worker] 自检:Node ${process.versions.node}`)
  const rtc = await import('@livekit/rtc-node')
  console.log(`[channel-worker] 自检:@livekit/rtc-node 加载成功(${typeof rtc.Room === 'function' ? '有 Room' : '没有 Room'})`)
  console.log('[channel-worker] 自检:正在加载 Silero VAD(要几秒)……')
  const vad = await VAD.load()
  console.log('[channel-worker] 自检:Silero VAD 加载成功')
  // 加载得起来就够了;关掉它免得进程被一条活着的 onnx 会话拖住。
  await (vad as unknown as { close?: () => Promise<void> }).close?.()
  console.log('[channel-worker] 自检通过:这一份工人包在这台机器上起得来。')
}

async function main(): Promise<void> {
  // 自检要排在**最前面**:它不读配置、不找 key、不探 8792,所以这几步都还没发生。
  if (process.argv.includes('--selfcheck')) {
    await selfCheck()
    return
  }

  /**
   * 框架的那几个基类在构造时就取 logger,没初始化过会抛「logger not initialized」。
   * 生产里通常是 `cli.runApp` 顺手初始化的;这个工人是**自己进房**的(不走 agent dispatch),
   * 所以得自己来一次。等级跟着 `WORKBENCH_CHANNEL_LOG_LEVEL`,默认只看警告以上 ——
   * 框架的 info 日志里有房间与轨道的细节,刷屏且盖住我们自己那几行。
   */
  initializeLogger({ pretty: true, level: (process.env.WORKBENCH_CHANNEL_LOG_LEVEL ?? 'warn') as 'warn' })

  const base = channelWorkerConfigOf(process.env)
  /**
   * 接话模型往哪儿发:工作台设置里「模型服务」那一节的选择(~/.dsh/workbench/model.json)。
   * 没有那个文件就完全照旧(官方地址 + 自己的 Key),见 modelChoice.ts 的三条优先级。
   *
   * ★ **每一通电话现读一次**(2026-10-23 运行时 P1):`modelNow` 在下边 room 那条
   * 「每通刷新」里被 agent 调 —— 设置里换了模型/地址/Key,在通这一通照旧打完,
   * 下一通自然吃新配置;不打断通话,不靠外部重启进程,也不擅自拉起被点停的工人。
   */
  const firstModel = await resolveChannelModel({ env: process.env, fallbackBaseUrl: base.llmBaseUrl })
  const config = applyModelChoice(base, firstModel, process.env)
  const modelNow = async () => {
    const fresh = await resolveChannelModel({ env: process.env, fallbackBaseUrl: base.llmBaseUrl })
    return channelModelNow(applyModelChoice(base, fresh, process.env), fresh.key, fresh.source)
  }
  const outboxDir = process.env.WORKBENCH_CHANNEL_OUTBOX_DIR?.trim() || defaultOutboxDir(config.inboxDir)
  console.log('[channel-worker] 配置:', {
    工作台: config.workbenchUrl,
    本机后端: config.butlerUrl,
    ASR: config.asr,
    接话模型: config.llmModel,
    模型服务: `${firstModel.source}(${config.llmBaseUrl})`,
    收件目录: config.inboxDir,
    发件目录: outboxDir,
    传输记录: config.transfersFile,
    设备名: config.deviceName,
    身份后缀: process.env.WORKBENCH_CHANNEL_WORKER_SUFFIX?.trim() || '(没有,就是第一台)',
    路线: process.env.WORKBENCH_CHANNEL_WORKER_ROUTE?.trim() || '(没点名,照老规矩)',
    // 2026-09-23 那三手的当前状态。量前后时第一件事就是确认这一行(开关见 config.ts)。
    回合计时: config.latencyLog ? '开' : '关',
    // 2026-09-23 第二轮(合成首包):流式走没走通看工人日志里有没有「流式合成走不通」那一行。
    流式合成: config.ttsStream ? '开(先试 /api/tts/stream,不通就回退老路)' : '关',
    首块断句: `${config.ttsFirstBreakAt ?? 10} 字(其余 ${config.ttsSoftBreakAt ?? 18} 字)`,
    抢跑合成: config.preemptiveTts ? '开' : '关(框架默认)',
    垫场: config.workerFiller ? '工人用当前音色说(手机不再放本地那份)' : '只发信号,手机自己放(老行为)',
    // 2026-10-03 这一卡那两格。两格都开着才是维护者拍板的那个样子。
    应声不进模型文本: config.ackOutOfText ? '开(回合提交前剥掉开头那几声)' : '关(上游行为:接在下一句前面一起交上去)',
    没办成不许说办了: config.claimGuard ? '开(一回合没有工具办成时,「派了 / 换好了」换成如实的问话)' : '关(原样念)',
    人设按意图裁: config.personaByIntent ? '开(工作台下发段标记,用不上的段这一回合不带)' : '关(每回合整份)',
    端点固定等待: config.endpointingMinMs === undefined && config.endpointingMaxMs === undefined
      ? '框架默认(流式 300/2500)'
      : `${config.endpointingMinMs ?? '默认'}/${config.endpointingMaxMs ?? '默认'}`,
  })

  // 只打「有没有」和那一句人话,**永远不打 key 本身**。
  const deepseekKey = firstModel.key
  console.log(`[channel-worker] ${firstModel.note}`)

  /**
   * 房里显示的名字 = **设备名**(2026-09-21)。以前是「事务官」——那时房里只有一台电脑,
   * 叫什么都行;现在「发到…」的选单里列的就是这个名字,它必须是他认得出的那台机器。
   *
   * `WORKBENCH_CHANNEL_WORKER_SUFFIX`:同一个房间里的**第二台**电脑要填,身份才不会撞
   * (第一台不填,身份保持 `wb-channel-worker` —— 手机只认它)。
   */
  const workerSuffix = process.env.WORKBENCH_CHANNEL_WORKER_SUFFIX?.trim()
  /**
   * 这条工人进哪条路线的房(2026-10-22,局域网主路 M6):8791 一条路线拉一条工人,在进程环境里说清是哪条;
   * 取票时点名那一条(本机房间 / 云房间)。手工起、老 8791 不给 = 不点名,照老规矩(本机有钥匙签本机,没有就中转)。
   * 两间房里身份都是 `wb-channel-worker`(手机与听筒只认它),后缀照旧只留给「第二台电脑进同一间房」。
   */
  const workerRoute = workerRouteOf(process.env)
  /**
   * 工人自己那把进程令牌(2026-09-28,卡 BS):8791 开机时现生,**只放进这个进程的 spawn env**。
   * 靠它,8791 认得出「这一条是电话工人转的、算她本人」—— 她在电话里亲口说的那一句要过那道门。
   * 没拿到(老版本的工作台、手动起的工人)就不带:那几个口回 403 并说清只有她本人能答。
   */
  const actorToken = (process.env.WORKBENCH_WORKER_ACTOR ?? '').trim()
  const workbench = createWorkbenchClient({
    baseUrl: config.workbenchUrl,
    workerName: config.deviceName,
    ...(workerSuffix === undefined || workerSuffix === '' ? {} : { workerSuffix }),
    ...(workerRoute === undefined ? {} : { workerRoute }),
    ...(actorToken === '' ? {} : { actorToken }),
  })

  /**
   * 8792 在不在:**探一次只为日志里有一句人话,探不到照常往下走**(2026-09-18)。
   * 说不了话的电话仍然是一通电话 —— 字幕照出、答案照落。这一格的结论不缓存:
   * 8792 起来之后下一句合成自己就成了,不用重启工人。
   */
  const ttsProbe = await probeTtsBackend({ butlerUrl: config.butlerUrl })
  console.log(`[channel-worker] ${ttsProbe.note}`)

  console.log('[channel-worker] 正在加载 Silero VAD……')
  /**
   * **VAD 只听最近的**(2026-09-25):这台 Mac 忙的时候 Silero 会落后几十秒、排着队补算旧音频,
   * 判出来的「他开口了 / 说完了」全是过时的。包一层,落后超过 1 秒就丢最旧的 —— 理由见 audio/freshVad.ts。
   * 送火山识别的那一路不经过这里,一帧不丢。
   */
  const vad = new FreshVAD(await VAD.load(), { log: line => console.log(line) })

  /** 当前这一轮的把手。SIGTERM 要能把它关掉,重连时要能换掉。 */
  let handle: Awaited<ReturnType<typeof startChannelAgent>> | undefined
  let stopping = false

  /**
   * **通话护栏**(2026-09-25):通话中把这台 Mac 上认得出的构建 / 测试调到后台档,挂断还原。
   * 派出去的活大多是 Codex / Claude 的桌面 App 自己起的进程,起的时候带不上我们的档位,
   * 只能在通话时事后调。理由、边界与开关见 loadGuard.ts。
   */
  const guardSettings = loadGuardSettingsOf(process.env)
  const guard = guardSettings.on
    ? new LoadGuard({
        isActive: () => handle?.inCall() ?? false,
        log: line => console.log(line),
        ...(guardSettings.onlyUnder === undefined ? {} : { onlyUnder: guardSettings.onlyUnder }),
      })
    : undefined
  console.log(guard === undefined
    ? `[channel-worker] ${guardSettings.note ?? '通话护栏没开'}`
    : `[channel-worker] 通话护栏开着:通话中把这台 Mac 上的构建/测试调到后台档,挂断还原(关:WORKBENCH_CHANNEL_LOAD_GUARD=off)${guardSettings.onlyUnder === undefined ? '' : `;只管进程 ${guardSettings.onlyUnder} 的子孙`}`)
  guard?.start()
  /**
   * 「现在在不在通话」报给工作台(2026-09-25,卡 Q):工作台据此在通话中停掉读各家 Agent 窗口的巡检。
   * 与通话护栏同一个 `inCall` 口径;报不出去不要紧,下一拍接着报(见 callStateReport.ts)。
   */
  const callStateReporter = new CallStateReporter({
    isActive: () => handle?.inCall() ?? false,
    send: postCallState(config.workbenchUrl, fetch, () => workerRoute),
  })
  callStateReporter.start()

  /**
   * ——— 「文字当成他说的话」测试口(2026-09-27,卡 TT) ———
   *
   * **默认关**,只在统筹本机开:`WORKBENCH_CHANNEL_TEXT_TURN=1`。开了也只听 127.0.0.1、
   * 只认那个 600 权限的口令文件(口令不打印)。起在这里而不是起在 `startChannelAgent` 里,
   * 是为了让它**跨掉线重进房活着**:每一条请求现问一次 `handle.textTurn`,
   * 工人换了一轮之后拿到的自然是新那一份。安装包的默认配置里没有这一项。
   */
  const textTurn = textTurnSettingsOf(process.env)
  console.log(`[channel-worker] ${textTurn.note}`)
  const textTurnServer = textTurn.on
    ? await startTextTurnServer({
      settings: textTurn,
      port: () => handle?.textTurn,
      roomReplay: () => handle?.roomDecisionReplay,
      log: line => console.log(line),
    }).catch((err: unknown) => {
      // 开不起来不许把工人带走:电话那一路是主线,测试口只是给统筹看的。
      console.error(`[channel-worker] 测试口起不来(照常进房):${(err as Error)?.message ?? String(err)}`)
      return undefined
    })
    : undefined
  // 不管从哪条路退出,压着的都还回去(退出时等不了异步,同步还原)。
  process.on('exit', () => guard?.releaseSync())

  /**
   * 退出有时限(2026-10-10):`handle.close()` 里的 session.close / room.disconnect 没有自己的超时,
   * 挂住就永远不退 —— 那几个孤儿工人收到 SIGTERM 不走,多半卡在这里。见 lifeline.ts。
   */
  const shutdown = createShutdown({
    close: async () => {
      stopping = true
      guard?.releaseSync()
      callStateReporter.stop()
      parentWatch.stop()
      void textTurnServer?.close()
      await (handle?.close() ?? Promise.resolve())
    },
  })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  /**
   * 工作台没了就自己走(2026-10-10):kickstart -k 硬杀工作台时,工人被过继给 1 号进程活下来,
   * 用同一个身份和新工人互相踢。手动起的工人不带 WORKBENCH_CHANNEL_PARENT_PID,只看父进程号变没变。
   */
  const parentWatch = createParentWatch({
    ...(parentPidOf(process.env) === undefined ? {} : { expected: parentPidOf(process.env) as number }),
    onGone: (reason) => {
      console.log(`[channel-worker] ${reason}`)
      shutdown('工作台不在了')
    },
  })
  parentWatch.start()

  /**
   * 一直在房里。断了(livekit-server 重启、网断了、被踢)或者这一轮压根没进去(8791 还没起、
   * 没配 key/secret)都走同一条路:退避、重新取凭证、重新接线。
   *
   * **每一轮都重新向 8791 要凭证**,不复用上一张:服务器地址跟着凭证一起回来,
   * Ben 把 channel.json 从本机 dev 换成阿里云那台之后,工人下一轮就自己搬过去了,不用重启。
   */
  let failures = 0
  while (!stopping) {
    /** 这一轮结束的信号:房间断了,或者接线时就抛了。 */
    let settle: (() => void) | undefined
    const lost = new Promise<void>((resolve) => { settle = resolve })
    try {
      /**
       * 这一轮的第三方凭据(2026-09-21)。**每轮现取,不缓存** —— 和「每一轮都重新向 8791
       * 要进房凭证」同一条理由:用户刚登录完、服务器上换了钥匙,下一轮就跟上,不用重启工人。
       * 取不到不算错(多半只是还没登录),如实记一行,这一轮走分段兜底。
       */
      const credentials = await workbench.credentials()
      // **只打「有没有」**,永远不打值本身。
      console.log(credentials.note === undefined
        ? `[channel-worker] 通道凭据:${credentials.source}(识别 ${credentials.volc_asr === undefined ? '无' : '有'})`
        : `[channel-worker] 通道凭据:${credentials.note}`)

      /**
       * ★ **认家名那一池从主人那里拉**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
       *
       * 主人是插件的家族目录(`GET /families`:家族目录 + 本机探测 + 登记表)。和凭据同一条理由
       * **每轮现取、不缓存**:服务器上换了什么,下一轮进房就跟上,不用重启工人。
       *
       * ★ **但这个循环一圈是一次进房,不是一通电话**(2026-10-03,卡 C;审计附证 C)。
       * 工人常驻在房里,所以**每通电话开始时还会再拉一次**(`agent.ts` 的 `refreshSelfBrief`)
       * —— 她启动之后才装上的那一家,下一通就认得出,不用等断房重连。
       * 两处同一种处置、同一行措辞:`applyFamilyPool`(拉不到沿用上一份,日志说清是哪一份)。
       */
      console.log(applyFamilyPool(await workbench.families()))

      handle = await startChannelAgent({
        config,
        workbench,
        vad,
        ...(deepseekKey === undefined ? {} : { deepseekKey }),
        modelNow,
        // 走中转还是直连:**只进「关于我自己」那段话**(2026-09-23),不影响任何一次模型调用。
        modelRoute: firstModel.source,
        ...(credentials.volc_asr === undefined ? {} : { volcAsrCreds: credentials.volc_asr }),
        outboxDir,
        onLost: () => settle?.(),
      })
      failures = 0
      await lost
      if (stopping) return
      console.log('[channel-worker] 掉线了,准备重新进房。')
      try { await handle.close() } catch { /* 已经断了 */ }
      handle = undefined
    }
    catch (err) {
      handle = undefined
      const wait = REJOIN_BACKOFF_MS[Math.min(failures, REJOIN_BACKOFF_MS.length - 1)] as number
      failures += 1
      console.error(`[channel-worker] 进不了房(第 ${failures} 次):${(err as Error)?.message ?? String(err)};${Math.round(wait / 1000)} 秒后再试。`)
      await sleep(wait)
      continue
    }
    // 掉线之后的第一次重连不等 —— 服务器多半只是重启了一下。
    await sleep(REJOIN_BACKOFF_MS[0] as number)
  }
}

void main().catch((err: unknown) => {
  // 走到这里说明是进房**之外**的哪一步崩了(VAD 加载、配置)。进不了房那一类在 main 里退避重来,
  // 不会到这儿 —— 常驻进程不该因为「这会儿 8791 还没起」就退出。
  console.error(`[channel-worker] 起不来:${(err as Error)?.message ?? String(err)}`)
  process.exit(1)
})
