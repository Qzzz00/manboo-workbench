/**
 * **GitHub 设备码登录**(2026-10-21 协作区全量,视觉需求第 11 屏;维护者 10-21 勾回来的「GitHub 登录集成」)。
 *
 * 标准 OAuth device flow:向 GitHub 要一枚设备码 → 界面显示给她 → 她在 github.com/login/device 点允许 →
 * 这里按 GitHub 给的间隔轮询换到令牌。三条:
 * - **client id 从配置读**(app.json 的 `github_client_id` 或 `WORKBENCH_GITHUB_CLIENT_ID`);没有就 `unconfigured` 如实说,不编一个;
 * - **令牌只存本机**(`~/.dsh/workbench/github.json`,600),不进中转、不回界面;
 * - 只拿项目挂的远端仓库的 PR 列表,PR 可以挂到便签上(`pull_requests`)。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CollabGitHubView, CollabPullRequest } from '../protocol.ts'

export function defaultGitHubFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/github.json`
}

/** 一个远端地址是不是 GitHub 仓库:认 https 与 ssh 两种写法。 */
export function githubRepoOf(url: string | undefined): { owner: string, repo: string } | undefined {
  if (url === undefined) return undefined
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m === null ? undefined : { owner: m[1] as string, repo: m[2] as string }
}

interface Pending {
  device_code: string
  user_code: string
  verification_uri: string
  expires_at: number
  interval: number
}

interface Stored { token: string, login?: string, at: string }

export interface GitHubDevice {
  view: () => Promise<CollabGitHubView>
  /** 要一枚设备码,开始等她点允许。 */
  start: () => Promise<CollabGitHubView>
  /** 轮询一次(定时器调;用例直接调)。回这一拍之后的样子。 */
  poll: () => Promise<CollabGitHubView>
  disconnect: () => Promise<void>
  /** 几个仓库的打开中的 PR(没连上回 undefined)。 */
  pulls: (repos: readonly { owner: string, repo: string }[]) => Promise<CollabPullRequest[] | undefined>
}

export interface GitHubDeviceOptions {
  file: string
  clientId: () => Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => number
  /** 排下一次轮询(缺席 = setTimeout;用例传一个什么都不做的,手动调 poll)。 */
  schedule?: (fn: () => void, ms: number) => void
}

export const GITHUB_SCOPE = 'repo read:org'

export function createGitHubDevice(opts: GitHubDeviceOptions): GitHubDevice {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.() })
  let pending: Pending | undefined
  let lastError: string | undefined

  async function stored(): Promise<Stored | undefined> {
    try {
      const raw = JSON.parse(await readFile(opts.file, 'utf8')) as Record<string, unknown>
      return typeof raw.token === 'string' && raw.token !== ''
        ? { token: raw.token, ...(typeof raw.login === 'string' ? { login: raw.login } : {}), at: typeof raw.at === 'string' ? raw.at : '' }
        : undefined
    }
    catch { return undefined }
  }

  async function save(value: Stored): Promise<void> {
    await mkdir(dirname(opts.file), { recursive: true })
    const tmp = `${opts.file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, opts.file)
  }

  async function view(): Promise<CollabGitHubView> {
    const have = await stored()
    if (have !== undefined) return { state: 'connected', ...(have.login === undefined ? {} : { login: have.login }) }
    if ((await opts.clientId()) === undefined) return { state: 'unconfigured' }
    if (pending !== undefined && pending.expires_at > now()) {
      return { state: 'pending', user_code: pending.user_code, verification_uri: pending.verification_uri, expires_at: new Date(pending.expires_at).toISOString() }
    }
    return { state: 'disconnected', ...(lastError === undefined ? {} : { error: lastError }) }
  }

  async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })
    return await res.json().catch(() => ({})) as Record<string, unknown>
  }

  function keepPolling(): void {
    if (pending === undefined) return
    schedule(() => { void poll().catch(() => undefined) }, pending.interval * 1000)
  }

  async function poll(): Promise<CollabGitHubView> {
    const clientId = await opts.clientId()
    if (pending === undefined || clientId === undefined) return await view()
    if (pending.expires_at <= now()) { pending = undefined; lastError = '设备码过期了,再点一次「连接 GitHub」'; return await view() }
    const got = await form('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: pending.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof got.access_token === 'string' && got.access_token !== '') {
      pending = undefined
      lastError = undefined
      let login: string | undefined
      try {
        const res = await doFetch('https://api.github.com/user', { headers: { authorization: `Bearer ${got.access_token}`, accept: 'application/vnd.github+json' } })
        const user = await res.json().catch(() => ({})) as Record<string, unknown>
        login = typeof user.login === 'string' ? user.login : undefined
      }
      catch { login = undefined }
      await save({ token: got.access_token, ...(login === undefined ? {} : { login }), at: new Date(now()).toISOString() })
      return await view()
    }
    if (got.error === 'authorization_pending') { keepPolling(); return await view() }
    if (got.error === 'slow_down') { pending.interval += 5; keepPolling(); return await view() }
    pending = undefined
    lastError = got.error === 'access_denied' ? '你在 GitHub 那边点了拒绝' : got.error === 'expired_token' ? '设备码过期了,再点一次「连接 GitHub」' : `GitHub 回了:${String(got.error ?? '没认出来的回包')}`
    return await view()
  }

  return {
    view,
    async start() {
      const clientId = await opts.clientId()
      if (clientId === undefined) return { state: 'unconfigured' }
      const got = await form('https://github.com/login/device/code', { client_id: clientId, scope: GITHUB_SCOPE })
      if (typeof got.device_code !== 'string' || typeof got.user_code !== 'string') {
        lastError = `GitHub 没给设备码:${String(got.error_description ?? got.error ?? '没认出来的回包')}`
        return await view()
      }
      lastError = undefined
      pending = {
        device_code: got.device_code,
        user_code: got.user_code,
        verification_uri: typeof got.verification_uri === 'string' ? got.verification_uri : 'https://github.com/login/device',
        expires_at: now() + (typeof got.expires_in === 'number' ? got.expires_in : 900) * 1000,
        interval: typeof got.interval === 'number' && got.interval > 0 ? got.interval : 5,
      }
      keepPolling()
      return await view()
    },
    poll,
    async disconnect() {
      pending = undefined
      lastError = undefined
      await rm(opts.file, { force: true })
    },
    async pulls(repos) {
      const have = await stored()
      if (have === undefined) return undefined
      const out: CollabPullRequest[] = []
      for (const { owner, repo } of repos) {
        const res = await doFetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=30`, {
          headers: { authorization: `Bearer ${have.token}`, accept: 'application/vnd.github+json' },
        })
        if (!res.ok) continue
        const list = await res.json().catch(() => []) as Record<string, unknown>[]
        for (const pr of Array.isArray(list) ? list : []) {
          if (typeof pr.number !== 'number' || typeof pr.title !== 'string') continue
          const user = typeof pr.user === 'object' && pr.user !== null ? (pr.user as Record<string, unknown>).login : undefined
          out.push({
            repo: `${owner}/${repo}`, number: pr.number, title: pr.title,
            url: typeof pr.html_url === 'string' ? pr.html_url : `https://github.com/${owner}/${repo}/pull/${pr.number}`,
            state: typeof pr.state === 'string' ? pr.state : 'open',
            ...(typeof user === 'string' ? { author: user } : {}),
            ...(typeof pr.updated_at === 'string' ? { updated_at: pr.updated_at } : {}),
          })
        }
      }
      return out
    },
  }
}
