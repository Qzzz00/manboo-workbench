/**
 * 「看懂代码结构」这件能力的版本钉与路径(2026-09-27,卡 SE)。
 *
 * 这一份是**唯一出处**:`deploy/code-sense-install.sh` 里那几行版本号必须与这里逐字一致,
 * `tests/code-sense-manifest.test.ts` 会去读那个脚本比对 —— 改一边忘了另一边,测试就红。
 * 同一个做法在 `setup/dshRuntimeLock.ts`(DSH 运行时锁)那儿已经用了一年,理由一样:
 * 「钉版本」这件事只要有两处写法,迟早有一处漏。
 *
 * 为什么要钉(AGENTS.md「C4 供应链把关:第三方插件需 pin 版本」):serena 会在运行时
 * 按需从 npm / GitHub releases 往机器上拉语言服务器 —— 这是一条真实的供应链面。
 * 我们能钉的是入口那三样:uv 的二进制(连 sha256 一起钉)、Python 的大版本、serena 的包版本。
 * 拉下来的语言服务器钉不住,所以这件能力**只装在有源码仓库的机器上**,不进用户的安装包。
 */

/** uv(astral-sh/uv)的锁定版本。换它 = 一次独立的升级评估,同 C3 对 DSH 的做法。 */
export const CODE_SENSE_UV_VERSION = '0.12.19'

/**
 * 上面那个包的 sha256,**从 astral-sh 的 `.sha256` 附件抄下来钉在这里**(2026-09-27 取)。
 * 钉在仓库里而不是跟着包一起下:跟着下的校验和只防传输损坏,钉在这儿的还经过一次人工审阅
 * (同 `setup/paths.ts` 里 node 那一份)。换版本时这两行一起改。
 */
export const CODE_SENSE_UV_SHA256 =
  'a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba'

/** serena 的 PyPI 包与版本。`serena-agent` 1.7.0(2026-08-09 发,评估文档里那一版)。 */
export const CODE_SENSE_SERENA_SPEC = 'serena-agent==1.7.0'

/** uv 自己管的那个 Python 大版本(serena 声明 `>=3.11,<3.15`,官方推荐 3.13)。 */
export const CODE_SENSE_PYTHON_VERSION = '3.13'

/** 装在哪。**只在 `~/.dsh` 底下**,不碰系统 Python、不写全局 PATH、不动 shell 配置。 */
export function codeSenseRoot(dshHome: string): string {
  return `${dshHome}/code-sense`
}

/** 各家 MCP 配置里唯一要写的那一条命令(装的时候由脚本生成)。 */
export function codeSenseRunMcp(dshHome: string): string {
  return `${codeSenseRoot(dshHome)}/run-mcp`
}

/** 设置页读的那一份「装了什么」。 */
export function codeSenseInstalledJson(dshHome: string): string {
  return `${codeSenseRoot(dshHome)}/installed.json`
}

/** 我们写过哪几家、写进去的逐字原文。卸载与「是不是被手改过」都靠它,见 agentConfig.ts。 */
export function codeSenseWrittenJson(dshHome: string): string {
  return `${codeSenseRoot(dshHome)}/written.json`
}

/**
 * 能挂这件能力的那几家。**每一家的 context 名字都是钉死的** —— serena 1.7.0 把
 * 原来那个通用的 `ide-assistant` 拆成了按家分的 context(`claude-code` / `codex` / `ide` …),
 * 写错一个名字它会报错退出。2026-09-27 从 1.7.0 自带的 `resources/config/contexts/` 逐个核过。
 *
 * **事务官(DSH)用 `ide`**:它自带的读文件/跑命令那几只手与 IDE 那一类一样,而
 * 上游没给 DSH 专门的 context。
 */
export interface CodeSenseHost {
  /** 内部 id,也是 written.json 里的键。 */
  id: 'claude-code' | 'codex' | 'dsh'
  /** 设置页上显示的名字(中文,给不懂代码的人看)。 */
  label: string
  /** 传给 `run-mcp` 的第一个参数(serena 的 context 名)。 */
  context: string
}

export const CODE_SENSE_HOSTS: readonly CodeSenseHost[] = [
  { id: 'claude-code', label: 'Claude Code', context: 'claude-code' },
  { id: 'codex', label: 'Codex', context: 'codex' },
  { id: 'dsh', label: '事务官(DSH)', context: 'ide' },
]

/**
 * MCP 里这台服务器叫什么。DSH 的 `mcp-client` 对 `serverName` 有硬要求:
 * `[A-Za-z0-9_-]{1,32}`(上游 `packages/mcp/mcp-client/src/index.ts` 的注释),
 * 所以不能带中文、不能带点。三家统一用这一个名字 —— 卸载时「删名为 code-sense 的那一条」
 * 才说得清楚。
 */
export const CODE_SENSE_SERVER_NAME = 'code-sense'

/** DSH 的补丁层里那一行的 id(与 serverName 同名会更难找,所以后面带个 -mcp)。 */
export const CODE_SENSE_DSH_ENTRY_ID = 'code-sense-mcp'

/** DSH 那一行挂的是上游哪个插件。0.1.7-rc.2 的 profile node_modules 里有它。 */
export const CODE_SENSE_DSH_PLUGIN = '@deepseek-ai/dsh-mcp-client'
