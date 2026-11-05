/**
 * 登录台与外界的**全部**接触面(2026-09-17):读文件、写文件、跑命令、发 HTTP。
 *
 * 就这四样,而且每一样都是一个可注入的函数。测试里换成假的,于是:
 *   - 体检不真去读 `~/.dsh`,而是读临时 HOME 下自己摆出来的那套文件;
 *   - 一键装不真跑 npm / launchctl / ditto,只断言「调了什么命令、写了哪些文件」。
 *
 * 真实现(`nodeSetupIo`)也在这个文件里,但它**只在 http.ts 起服务时**被 new 出来一次,
 * 其余代码一律只认接口 —— 这样"哪段代码能碰磁盘"在结构上就是看得见的。
 */
import { appendFile as fsAppendFile, chmod as fsChmod, copyFile as fsCopyFile, mkdir as fsMkdir, readFile as fsReadFile, readdir as fsReaddir, rename as fsRename, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

export interface SetupStatInfo {
  isFile: boolean
  isDirectory: boolean
  size: number
  /** 毫秒时间戳。壳 App 的"构建时间"就是它。 */
  mtimeMs: number
  /** 有没有执行位(0o111 任意一位)。启动脚本 chmod 755 过没有,靠它判。 */
  executable: boolean
}

export interface SetupExecResult {
  ok: boolean
  /** 退出码。没跑起来(命令不存在)时是 -1。 */
  code: number
  /** stdout 与 stderr 合并后的全文。**调用方只把尾 20 行给界面**。 */
  out: string
}

export interface SetupExecOptions {
  cwd?: string
  /** 在 process.env 之上叠的环境变量。**这里永远不放密钥**。 */
  env?: Record<string, string>
  /** 每读到一行就回调一次 —— 装 npm 这种要几分钟的步骤靠它报进度。 */
  onLine?: (line: string) => void
  /** 超时毫秒。npm 那步要给得很大(网络慢)。 */
  timeoutMs?: number
  /**
   * 发出去就不管它(2026-10-13,「热更新装完没起来」那张卡)。
   *
   * `detached: true` = 自己一个会话与进程组,`stdio: 'ignore'` + `unref()` = 跟这个进程
   * 再没有任何牵连。**这个进程当场死掉它也照样跑完** —— 唯一要这样起的那一下是热更新
   * 最后的重启(`update/apply.ts`):launchd 杀作业时连它的整个进程组一起收
   * (`AbandonProcessGroup` 缺省 false,2026-10-13 在临时 launchd 测试项上量过),
   * 而那一下的全部意义就是"发它的人没了也要发得出去"。
   *
   * 回的结果只说得出**起起来了没有**(spawn 成了 = ok):不等它退出,所以
   * `code` 恒为 0、`out` 恒为空,`onLine` / `timeoutMs` 一概不生效。
   */
  background?: boolean
}

/**
 * 登录台的 I/O 面。
 *
 * `readFile` / `stat` 读不到时回 `undefined` 而不是抛 —— 体检的每一项都要能在
 * "这个文件不存在"上继续往下走,抛异常会让一项缺失拖垮整份体检。
 * `readdir` 是唯一区分"读不到"与"没权限"的:文稿目录授权那一项要的就是 EPERM 这个信号。
 */
export interface SetupIo {
  readFile: (path: string) => Promise<string | undefined>
  stat: (path: string) => Promise<SetupStatInfo | undefined>
  readdir: (path: string) => Promise<{ ok: true, names: readonly string[] } | { ok: false, code: string, message: string }>
  mkdirp: (path: string) => Promise<void>
  writeFile: (path: string, content: string, mode?: number) => Promise<void>
  /**
   * 往文件尾巴上追加(2026-09-27,卡 PN:安装全程写一份日志到磁盘)。
   *
   * 为什么不用 `readFile + writeFile` 凑:一次安装几千行,那样是 O(n²) 次全文件重写;
   * 而且它要能在**装到一半崩掉**之后留下已经写下去的那些行 —— 追加天然满足。
   */
  appendFile: (path: string, content: string) => Promise<void>
  copyFile: (from: string, to: string, mode?: number) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
  /** 删一棵树。**只有 rsync 兜底路径用得到**,而且只删登录台自己算出来的临时目录。 */
  rmrf: (path: string) => Promise<void>
  /**
   * 换名(2026-09-25 升 0.1.7,为了让热更新能换 DSH 运行时)。
   *
   * 同一个文件系统内 `rename(2)` 是**原子**的,运行时那一步全靠它:整棵新依赖树先装在
   * `runtime-next` 里,核过版本之后两次 rename 换过去 —— 磁盘上永远不存在"半棵树的 runtime"
   * 这种状态(那正是 09-23 白屏事故的形状)。
   *
   * **回值而不是抛**:那一步要在第二次 rename 失败时把第一次换回来,所以它需要一个
   * 能判断、带原因的结果,而不是一个异常。
   */
  rename: (from: string, to: string) => Promise<{ ok: true } | { ok: false, message: string }>
  exec: (cmd: readonly string[], options?: SetupExecOptions) => Promise<SetupExecResult>
  fetch: typeof fetch
  /** 当前这条 node 的可执行文件路径。`node` 那一步复制的就是它(0907 的做法)。 */
  currentNodeBinary: () => string
  /** 当前用户 uid,拼 `gui/<uid>/...`。 */
  uid: () => number
}

export function nodeSetupIo(): SetupIo {
  return {
    async readFile(path) {
      try { return await fsReadFile(path, 'utf8') }
      catch { return undefined }
    },
    async stat(path) {
      try {
        const info = await fsStat(path)
        return {
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
          size: info.size,
          mtimeMs: info.mtimeMs,
          executable: (info.mode & 0o111) !== 0,
        }
      }
      catch { return undefined }
    },
    async readdir(path) {
      try { return { ok: true, names: await fsReaddir(path) } }
      catch (error) {
        const err = error as { code?: string, message?: string }
        return { ok: false, code: err.code ?? 'UNKNOWN', message: err.message ?? String(error) }
      }
    },
    async mkdirp(path) { await fsMkdir(path, { recursive: true }) },
    async writeFile(path, content, mode) {
      await fsMkdir(dirname(path), { recursive: true })
      await fsWriteFile(path, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
      if (mode !== undefined) await fsChmod(path, mode)
    },
    async appendFile(path, content) {
      await fsMkdir(dirname(path), { recursive: true })
      await fsAppendFile(path, content, 'utf8')
    },
    async copyFile(from, to, mode) {
      await fsMkdir(dirname(to), { recursive: true })
      await fsCopyFile(from, to)
      if (mode !== undefined) await fsChmod(to, mode)
    },
    async chmod(path, mode) { await fsChmod(path, mode) },
    async rmrf(path) { await fsRm(path, { recursive: true, force: true }) },
    async rename(from, to) {
      try {
        await fsRename(from, to)
        return { ok: true }
      }
      catch (error) {
        const err = error as { code?: string, message?: string }
        return { ok: false, message: err.message ?? String(error) }
      }
    },
    exec(cmd, options) {
      return runCommandStreaming(cmd, options)
    },
    fetch: (...args) => fetch(...args),
    currentNodeBinary: () => process.execPath,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
  }
}

/**
 * 真的起一个子进程并**按行**把输出喂给回调。
 *
 * 为什么不用 execFile:npm 装 200 个包要好几分钟,execFile 要等它整个跑完才给一次输出,
 * 界面上就是一条"在装…"卡着不动的进度条。按行流出来,Ben 至少看得到它还在动。
 */
function runCommandStreaming(cmd: readonly string[], options?: SetupExecOptions): Promise<SetupExecResult> {
  const [bin, ...args] = cmd
  if (bin === undefined) return Promise.resolve({ ok: false, code: -1, out: '空命令' })
  if (options?.background === true) return runCommandDetached(bin, args, options)
  return new Promise<SetupExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, ...(options?.env ?? {}) },
      })
    }
    catch (error) {
      resolve({ ok: false, code: -1, out: error instanceof Error ? error.message : String(error) })
      return
    }
    let out = ''
    let pending = ''
    let settled = false
    const timer = options?.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经退了 */ } }, options.timeoutMs)
    const take = (chunk: unknown): void => {
      const text = String(chunk)
      out += text
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) options?.onLine?.(line)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const done = (result: SetupExecResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (pending !== '') options?.onLine?.(pending)
      resolve(result)
    }
    child.on('error', (error: Error) => { done({ ok: false, code: -1, out: `${out}${error.message}` }) })
    child.on('close', (code) => { done({ ok: code === 0, code: code ?? -1, out }) })
  })
}

/**
 * 起一个**跟这个进程再没有牵连**的子进程(`background: true`,见 `SetupExecOptions`)。
 *
 * 回值等的是 `spawn` 这件事本身成没成:`spawn` 事件 = 真起起来了;`error` 事件
 * (ENOENT / EAGAIN —— 机器负载高时 fork 真的会失败)= 没起来,而且要**说出来**
 * (今天那一下是 `void io.exec(...)`,失败一个字都不留,正是 10-12 现场查不下去的原因之一)。
 */
function runCommandDetached(bin: string, args: readonly string[], options: SetupExecOptions): Promise<SetupExecResult> {
  return new Promise<SetupExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, ...(options.env ?? {}) },
        detached: true,
        stdio: 'ignore',
      })
    }
    catch (error) {
      resolve({ ok: false, code: -1, out: error instanceof Error ? error.message : String(error) })
      return
    }
    let settled = false
    const done = (result: SetupExecResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.on('error', (error: Error) => { done({ ok: false, code: -1, out: error.message }) })
    child.on('spawn', () => {
      // 父进程退出时别等它、也别因为它迟迟不退而钉住事件循环。
      child.unref()
      done({ ok: true, code: 0, out: '' })
    })
  })
}

/** 取一段输出的**尾 n 行**(默认 20)。空行不算 —— 一堆空行顶掉真正的报错就白给了。 */
export function tailLines(text: string, n = 20): readonly string[] {
  return text.split('\n').map(line => line.replace(/\s+$/, '')).filter(line => line !== '').slice(-n)
}
