/**
 * 目录归属(spec D5/D7)。
 *
 * 纪律:cwd 落在已知仓库或已生效规则的前缀下才归;两者都推不出就是 pending,绝不猜——
 * 猜错一次,Ben 就再也不敢信这张表,只能全部手动核对(spec D5)。
 * 优先级:仓库最长前缀 > 规则前缀(同样取最长前缀)> pending。
 */
import type { DirRule, PendingGroup } from '../protocol.ts'

/** 小写化、`\`→`/`、去尾斜杠——同一目录不管大小写/斜杠风格都要能匹配上。 */
export function normalizeDir(p: string): string {
  const unified = p.replace(/\\/g, '/').toLowerCase()
  const trimmed = unified.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function isPrefixOf(normParent: string, normChild: string): boolean {
  return normChild === normParent || normChild.startsWith(`${normParent}/`)
}

export type Attribution =
  | { kind: 'repo', repoPath: string }
  | { kind: 'rule', rule: DirRule }
  | { kind: 'pending' }

/** 归属一个 cwd:先在仓库列表里找最长前缀,再在规则里找最长前缀,都没有就 pending。 */
export function attributeCwd(
  cwd: string,
  repoPaths: readonly string[],
  rules: readonly DirRule[],
): Attribution {
  const normCwd = normalizeDir(cwd)

  let bestRepo: string | undefined
  let bestRepoLen = -1
  for (const repo of repoPaths) {
    const normRepo = normalizeDir(repo)
    if (isPrefixOf(normRepo, normCwd) && normRepo.length > bestRepoLen) {
      bestRepo = repo
      bestRepoLen = normRepo.length
    }
  }
  if (bestRepo !== undefined) return { kind: 'repo', repoPath: bestRepo }

  let bestRule: DirRule | undefined
  let bestRuleLen = -1
  for (const rule of rules) {
    const normRuleDir = normalizeDir(rule.dir)
    if (isPrefixOf(normRuleDir, normCwd) && normRuleDir.length > bestRuleLen) {
      bestRule = rule
      bestRuleLen = normRuleDir.length
    }
  }
  if (bestRule !== undefined) return { kind: 'rule', rule: bestRule }

  return { kind: 'pending' }
}

/**
 * 待归档聚类的分组 key(spec D5):home 下取 home + 前两段;否则取绝对路径前三段。
 * 保留原始大小写——这是要显示给 Ben 看的目录名,不是拿去比较用的规范化值。
 */
export function clusterKey(cwd: string, home: string): string {
  const unifiedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const unifiedHome = home.replace(/\\/g, '/').replace(/\/+$/, '')
  const underHome = isPrefixOf(unifiedHome.toLowerCase(), unifiedCwd.toLowerCase())

  if (underHome) {
    const rest = unifiedCwd.slice(unifiedHome.length).replace(/^\/+/, '')
    const parts = rest.split('/').filter(s => s !== '')
    const firstTwo = parts.slice(0, 2)
    return firstTwo.length === 0 ? unifiedHome : `${unifiedHome}/${firstTwo.join('/')}`
  }

  const parts = unifiedCwd.split('/').filter(s => s !== '')
  return `/${parts.slice(0, 3).join('/')}`
}

/** 按 clusterKey 聚合待归档目录,count 降序;first_at/last_at 取组内最早/最晚(字符串按 ISO 时间可比)。 */
export function clusterPending(
  items: readonly { cwd: string, at?: string }[],
  home: string,
): PendingGroup[] {
  const groups = new Map<string, { count: number, first?: string, last?: string }>()
  for (const item of items) {
    const key = clusterKey(item.cwd, home)
    const entry = groups.get(key) ?? { count: 0 }
    entry.count += 1
    if (item.at !== undefined) {
      if (entry.first === undefined || item.at < entry.first) entry.first = item.at
      if (entry.last === undefined || item.at > entry.last) entry.last = item.at
    }
    groups.set(key, entry)
  }

  const result: PendingGroup[] = []
  for (const [dir, entry] of groups) {
    result.push({
      dir,
      count: entry.count,
      ...(entry.first === undefined ? {} : { first_at: entry.first }),
      ...(entry.last === undefined ? {} : { last_at: entry.last }),
    })
  }
  result.sort((a, b) => b.count - a.count)
  return result
}

export { codexSessionCwds } from './sessionSources.ts'
