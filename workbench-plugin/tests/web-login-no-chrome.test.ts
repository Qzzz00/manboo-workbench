// @vitest-environment node
/**
 * **这台电脑上没装 Chrome,别把插件带崩**(2026-09-30,止血第 5 条;排查-写死的地方 §五-2)。
 *
 * 登录窗口那一路写死 `/Applications/Google Chrome.app/...`,既不看在不在、也不接 spawn 的
 * `error` 事件 —— 没装 Chrome 时 Node 会把它抛成进程级 `error`,整条工作台跟着走。
 * Kimi 网页登录、小红书两处(xhsBrowser / xhsNoteBrowser)走的都是这一个函数。
 *
 * 钉三条:
 * 1. 没装 → **根本不 spawn**,抛一句她看得懂的话;
 * 2. 装了但 spawn 自己失败(权限、坏包)→ `error` 事件被接住,同样变成一次 reject,不是进程级崩溃;
 * 3. 开出来的窗口记下 pid,`closeProfileWindows()`(插件收摊时调)把还活着的那几个收掉。
 */
import { describe, expect, it } from 'vitest'
import { NO_CHROME_NOTE, closeProfileWindows, openProfileWindow } from '../src/server/webLogin.ts'

const dir = '/假的/login-profile-kimi_web'

/** 一个假 spawn:记下调用,回一个能手动触发 error 的子进程。 */
function fakeSpawner() {
  const spawned: { command: string, args: readonly string[] }[] = []
  const kills: (number | undefined)[] = []
  let onError: ((err: Error) => void) | undefined
  const spawn = (command: string, args: readonly string[]) => {
    spawned.push({ command, args })
    return {
      pid: 4321,
      unref: () => {},
      on: (event: string, handler: (err: Error) => void) => { if (event === 'error') onError = handler },
    }
  }
  return {
    spawned,
    kills,
    spawn,
    fail: (message: string) => onError?.(new Error(message)),
    kill: (pid: number) => { kills.push(pid) },
  }
}

describe('没装 Chrome', () => {
  it('★根本不 spawn,抛的是一句她看得懂的话', async () => {
    const fake = fakeSpawner()
    await expect(openProfileWindow(dir, 'https://www.kimi.com/', undefined, {
      exists: async () => false,
      spawn: fake.spawn,
      mkdir: async () => {},
      readPort: async () => 1234,
    })).rejects.toThrow(NO_CHROME_NOTE)
    expect(fake.spawned).toEqual([])
    expect(NO_CHROME_NOTE).toContain('没装 Chrome')
  })

  it('装了、但 spawn 自己失败:error 事件被接住,变成一次 reject(不是进程级崩溃)', async () => {
    const fake = fakeSpawner()
    const promise = openProfileWindow(dir, 'https://www.kimi.com/', undefined, {
      exists: async () => true,
      spawn: fake.spawn,
      mkdir: async () => {},
      readPort: async () => await new Promise<number>(() => {}), // 永远等不到端口
    })
    await Promise.resolve()
    await Promise.resolve()
    fake.fail('EACCES: permission denied')
    await expect(promise).rejects.toThrow('EACCES')
  })
})

describe('开出来的窗口有人收', () => {
  it('记下 pid,收摊时把还活着的那个 kill 掉;收过一次就不再收第二次', async () => {
    const fake = fakeSpawner()
    const port = await openProfileWindow(dir, 'https://www.kimi.com/', undefined, {
      exists: async () => true,
      spawn: fake.spawn,
      mkdir: async () => {},
      readPort: async () => 9222,
    })
    expect(port).toBe(9222)
    closeProfileWindows(fake.kill)
    expect(fake.kills).toEqual([4321])
    closeProfileWindows(fake.kill)
    expect(fake.kills).toEqual([4321])
  })
})
