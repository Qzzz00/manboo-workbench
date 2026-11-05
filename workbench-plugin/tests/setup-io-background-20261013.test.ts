// @vitest-environment node
/**
 * `io.exec(..., { background: true })`:**发出去就不管它**(2026-10-13,
 * 「热更新装完重启没起来」那张卡)。
 *
 * 这一条是热更新最后那下重启唯一的依靠,所以它要真起一个子进程来验 —— 跑的命令
 * 全是 `/bin/sh` 往临时目录里写一个字,一条 `launchctl` 都没有。
 *
 * 要钉三件:
 *   ① **不等它跑完**:回来的那一刻那个文件还不在;
 *   ② **不在这个进程的进程组里**(launchd 杀作业时连它的进程组一起收,量过:
 *      交接 `docs/交接-1013-热更新装完重启没起来.md` 的 E-A);
 *   ③ **起不来要说出来**:ok=false + 一句原因(今天那一下是 `void io.exec(...)`,
 *      失败一个字都不留)。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-io-background-'))
  dirs.push(dir)
  return dir
}

/** 等到那个文件出现(或者到点放弃)。 */
async function waitFor(file: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  return false
}

/** 等文件**写上了字**:`> 文件` 那一下 shell 先建空文件、命令随后才写,机器忙时两者之间能隔几十毫秒(10-13 整包里红过)。 */
async function waitForContent(file: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').trim() !== '') return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  return false
}

describe('io.exec 的 background', () => {
  it('不等它跑完:回来的那一刻还没写,过一会儿才写上', async () => {
    const dir = temp()
    const mark = `${dir}/mark`
    const io = nodeSetupIo()
    const result = await io.exec(['/bin/sh', '-c', `sleep 0.4; printf x > ${mark}`], { background: true })
    expect(result.ok).toBe(true)
    expect(existsSync(mark)).toBe(false)
    expect(await waitFor(mark)).toBe(true)
  })

  it('跟这个进程不在同一个进程组里(launchd 收作业进程组时它不在被收的那一堆里)', async () => {
    const dir = temp()
    const file = `${dir}/pgid`
    const io = nodeSetupIo()
    const result = await io.exec(['/bin/sh', '-c', `ps -o pgid= -p $$ > ${file}`], { background: true })
    expect(result.ok).toBe(true)
    expect(await waitForContent(file)).toBe(true)
    const theirs = readFileSync(file, 'utf8').trim()
    const ours = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
    expect(theirs).not.toBe('')
    expect(theirs).not.toBe(ours)
  })

  it('普通那条路还是等它退出、还是收得到输出(没把老的那条改掉)', async () => {
    const io = nodeSetupIo()
    const lines: string[] = []
    const result = await io.exec(['/bin/sh', '-c', 'printf "一行\\n"'], { onLine: line => lines.push(line) })
    expect(result.ok).toBe(true)
    expect(result.out).toContain('一行')
    expect(lines).toEqual(['一行'])
  })

  it('压根起不来:ok=false,而且说得出为什么', async () => {
    const io = nodeSetupIo()
    const result = await io.exec(['/nonexistent/binary-for-test', 'x'], { background: true })
    expect(result.ok).toBe(false)
    expect(result.out).not.toBe('')
  })
})
