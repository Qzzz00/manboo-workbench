/**
 * 命令行那一条通道(2026-10-03,卡「派活三只手收进引擎」;设计 `docs/设计-派活三只手收进引擎-2026-10-03.md`)。
 *
 * 从前它是 `dispatchRun` 手循环里直接调 `runCli` 的「第二只手」:不过引擎的闸、账上一行 `assigned` / `sent` 都没有,
 * 换路由外层管 —— 闸拦住窗口之后外层接着换到它,等于没拦(审计第二节第 3 条)。现在它是登记表里的一条通道。
 *
 * 只管一件事:**起进程**。命令行的「送到」= 进程起来了(`JobResult.process`);结果要等它退出,
 * 由 `dispatchRun.finishCli` 按卡上记的 pid / 结果文件收(那是卡与进程的生命周期,不是「送」)。
 * 这里不碰卡、不挪状态、不写 note。
 *
 * 哪几家有这条通道:写代码的那几家(`agentCaps.hasCodeCli`:Claude / Codex / Kimi,2026-10-22 卡 C 起)+ 聊天时留命令行当备用的那一家
 * (`agentSources` 的 `cliBackup`,今天 = Codex)—— 合起来就是 {@link CLI_FAMILIES};用例读源头钉着。
 * 用不用(策略)在 `agentDispatch.cliAllowedFor` 一处:聊天只给 Codex 当备用、写代码三家都用。
 */
import type { AgentDispatchFamily } from '../../../protocol.ts'
import { hasCodeCli } from '../../../protocol.ts'
import { dispatchCommand, kimiCliArgv, type AgentCli } from '../../agentDispatch.ts'
import { FAMILY_SOURCES } from '../../agentSources.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../adapter.ts'

/** 起进程那一下的结果(生产:detached 子进程;用例:计数的假件)。 */
export interface CliProcessRun {
  /** 起来了就有 pid;起不来缺席,`error` 是原话。 */
  pid?: number
  error?: string
  /** 进程结束(退出码;被信号杀掉时是 null)。 */
  exited: Promise<{ code: number | null }>
}

export interface CliAdapterDeps {
  /** 这一家的命令行在哪(`resolveAgentCli` 的结果;事实,不是策略)。 */
  resolveCli: (family: AgentDispatchFamily) => AgentCli
  /** 起那个进程(生产:`taskpolicy -c utility` + detached,标准输出落 `logFile`)。 */
  runCli: (cmd: { bin: string, argv: readonly string[], cwd: string, logFile: string, env?: NodeJS.ProcessEnv }) => CliProcessRun
  /** 起进程之前备好的那份环境(`server/cliEnv.ts`);缺席 = 照工作台自己的。 */
  envForCli?: () => Promise<{ env: NodeJS.ProcessEnv }>
  /** 结果文件放哪个目录(一件一对:`-o` 的结果 + 事件流)。 */
  resultDir: string
  /**
   * ★ relay(续说)那一次起进程的 cwd(2026-10-23 深夜,卡 A 硬门槛前置):续跑(`--session`)
   * 不吃 cwd(Kimi 会话自带上下文),但 `runCli` 必须要一个 —— 宿主给一个稳的(如 workbench 目录)。
   */
  sayCwd?: () => string
  /** 这条 CLI 会话的原目录(kimi 续跑认原目录):缺席退回 {@link sayCwd}。 */
  sessionCwd?: (sessionId: string) => string | undefined
  now: () => Date
  /** 这一家叫什么(人话;缺席 = 家名)。 */
  name?: (family: string) => string
}

/**
 * 有命令行这条通道的那几家(读源头拼的,不写死):写代码的那几家(`agentCaps.hasCodeCli`:Claude / Codex / Kimi)
 * + 聊天时留命令行当备用的那一家(`agentSources` 的 `cliBackup`,今天 = Codex)。用例读源头钉着。
 */
export const CLI_FAMILIES: readonly AgentDispatchFamily[] = FAMILY_SOURCES
  .filter(one => one.cliBackup === true || hasCodeCli(one.agent))
  .map(one => one.agent)

/*
 * 这几句**不带「命令行:」那一截**:引擎把没送成的几条通道的原因按通道接起来时自己加
 * (`VIA_TEXT`,「窗口:…;命令行:…」),这里再写一遍就成了「命令行:后台那条路:…」。
 */
export const CLI_NO_CWD_WHY = '不知道在哪个项目里做(这件事没归到项目)'
export const CLI_NOT_THIS_WAY_WHY = '这一家不走这条路'
export function cliNotFoundWhy(who: string): string {
  return `这台电脑上还没有 ${who} 在后台做事要用的那一份`
}
export function cliDidNotStartWhy(error: string | undefined): string {
  return `没起来(${error ?? '没说原因'})`
}

const NOTHING: AdapterCapabilities = { open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false }

export function createCliAdapter(family: AgentDispatchFamily, deps: CliAdapterDeps): Adapter {
  const who = (): string => deps.name?.(family) ?? family
  const unsupported = (why: string): JobResult => ({ delivered: 'not_sent', via: 'cli', evidence: 'none', unsupported: true, why })
  const notSent = (why: string): JobResult => ({ delivered: 'not_sent', via: 'cli', evidence: 'none', why })

  return {
    family,
    via: 'cli',
    capabilities: async (): Promise<AdapterCapabilities> => ({ ...NOTHING, send: deps.resolveCli(family).found }),
    unavailable: () => (deps.resolveCli(family).found ? undefined : cliNotFoundWhy(who())),
    run: async (job: Job): Promise<JobResult> => {
      if (family === 'kimi' && job.effort !== undefined) return { delivered: 'not_sent', via: 'cli', evidence: 'none', blocked: true, why: 'Kimi 当前这条执行通道不能指定思考档，这次没有按其它档位开跑' }
      /*
       * ★ relay = 往 CLI 起的原会话里**续说一句**(2026-10-23 深夜,卡 A 硬门槛前置;统筹定
       * 既有卡 t-b34ddf83 的 Kimi 这一支最小修由本接缝主人吸收):只接 Kimi(既有登录 + 既有
       * `--session` 实测);复用 `kimiCliArgv` 的续跑拼装(--session <id> -p <text>,不带 --agent-file)。
       * 进程正常退出 = 排进原会话(delivered 'confirmed',与「起进程 = 送到」同一口径)。
       * Claude / Codex 的 CLI 续说不在这一支(整卡「两家各一条」仍留 t-b34df83),照 unsupported。
       */
      if (job.kind === 'relay') {
        if (family !== 'kimi') return unsupported(`${who()} 的命令行这条支还不接续说(归 CLI 续跑核验那一张卡)`)
        if (job.target.kind !== 'session') return unsupported('续说得指明哪一条会话')
        const cli0 = deps.resolveCli(family)
        if (!cli0.found) return notSent(cliNotFoundWhy(who()))
        const stamp0 = deps.now().toISOString().replace(/[:.]/g, '-')
        // relay Job 的 id 形如 `session:kimi/<会话号>`(带冒号斜线)——文件名先洗一遍,不然落盘 ENOENT。
        const safeName = `${job.itemId ?? 'relay'}-${job.target.kind === 'session' ? job.target.sessionId.slice(0, 8) : job.id}`.replace(/[^A-Za-z0-9._-]/g, '_')
        const outputFile0 = `${deps.resultDir}/${safeName}-relay-${stamp0}.txt`
        const logFile0 = `${outputFile0}.jsonl`
        const env0 = await deps.envForCli?.().catch(() => undefined)
        // kimi 续跑**认原目录**(会话是在哪个目录起的就得在哪个目录续,换了它拒绝)——原目录取自派活账。
        const relayCwd = job.target.kind === 'session' ? deps.sessionCwd?.(job.target.sessionId) : undefined
        const run0 = deps.runCli({
          bin: cli0.bin,
          argv: [...kimiCliArgv(job.text, relayCwd ?? deps.sayCwd?.() ?? '.', { resume: job.target.sessionId, model: job.model })],
          cwd: relayCwd ?? deps.sayCwd?.() ?? '.',
          logFile: logFile0,
          ...(env0 === undefined ? {} : { env: env0.env }),
        })
        if (run0.pid === undefined) return notSent(cliDidNotStartWhy(run0.error))
        const exit0 = await run0.exited
        if (exit0.code !== 0) return notSent(`那句话没能排进原会话(续跑进程退出码 ${exit0.code ?? '信号'})`)
        return { delivered: 'confirmed', via: 'cli', evidence: 'receipt', process: { pid: run0.pid, output_file: outputFile0, log_file: logFile0, exited: run0.exited } }
      }
      // 命令行只接派活:替她答 / 捎话 / 点键那几样它做不了(`codex exec resume` 那条 10-02 整只删了)。
      if (job.kind !== 'dispatch') return unsupported(`${who()} 的命令行只接派活`)
      const cli = deps.resolveCli(family)
      if (!cli.found) return notSent(cliNotFoundWhy(who()))
      if (job.cwd === undefined || job.cwd === '') return notSent(CLI_NO_CWD_WHY)
      const stamp = deps.now().toISOString().replace(/[:.]/g, '-')
      const outputFile = `${deps.resultDir}/${job.itemId ?? job.id}-${stamp}${job.attemptId === undefined ? '' : `-${job.attemptId}`}.txt`
      const logFile = `${outputFile}.jsonl`
      // 策略闸在 `dispatchCommand` 里(聊天只给 Codex 当备用、写代码三家都用):拼不出命令 = 这一家这种活不走这条路 → 让引擎换路。
      // 续跑接原会话(2026-10-23 卡③):Job 指了哪一段(target session),照原样接着(Kimi --session / Claude --resume)。
      const resume = job.target.kind === 'session' ? job.target.sessionId : undefined
      const cmd = dispatchCommand(cli, { prompt: job.text, cwd: job.cwd, outputFile, json: true, ...(job.work === undefined ? {} : { kind: job.work }), ...(job.model === undefined ? {} : { model: job.model }), ...(job.effort === undefined ? {} : { effort: job.effort }), ...(job.agentFile === undefined ? {} : { agentFile: job.agentFile }), ...(job.agentFileOmit === true ? { agentFileOmit: true } : {}), ...(resume === undefined ? {} : { resume }) })
      if (cmd === undefined) return unsupported(CLI_NOT_THIS_WAY_WHY)
      let prepared: { env: NodeJS.ProcessEnv } | undefined
      try { prepared = await deps.envForCli?.() }
      catch { prepared = undefined }
      const run = deps.runCli({ bin: cmd.bin, argv: cmd.argv, cwd: cmd.cwd, logFile, ...(prepared === undefined ? {} : { env: prepared.env }) })
      if (run.pid === undefined) return notSent(cliDidNotStartWhy(run.error))
      return {
        delivered: 'confirmed',
        via: 'cli',
        evidence: 'receipt',
        process: { pid: run.pid, output_file: outputFile, log_file: logFile, exited: run.exited },
      }
    },
  }
}
