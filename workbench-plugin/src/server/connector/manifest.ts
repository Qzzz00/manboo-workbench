/**
 * 连接器(open-connector)的**版本钉与路径表**(卡 OC,2026-09-27)。
 *
 * 这一份是整条链路唯一的事实来源:装哪一版、装到哪、听哪个口、launchd 叫什么。
 * 安装、体检、卸载、发版脚本、测试全部只认这里的常量 —— 照 `setup/paths.ts`
 * 那条纪律(每个函数必须收 `home`,不给默认值,于是测试能整个搬进临时 HOME)。
 *
 * C4 供应链把关:版本**写死**,`CONNECTOR_TARBALL_INTEGRITY` 是 npm registry 上
 * 1.6.5 那一份 tarball 的 `dist.integrity`(2026-09-27 取)。升级是**单独一张卡**,
 * 不跟 latest、不跟 ^。
 */

/** npm 包名。它是「可嵌入的 runtime 库」,**没有 CLI**,所以我们自己带一个宿主进程。 */
export const CONNECTOR_PACKAGE = '@oomol-lab/open-connector'

/** 钉死的版本(2026-09-27 实测的那一版)。 */
export const CONNECTOR_VERSION = '1.6.5'

/** npm registry 上这一版 tarball 的完整性摘要,`npm install` 会逐字核对。 */
export const CONNECTOR_TARBALL_INTEGRITY =
  'sha512-jSrVven/+JOo8p7yMPtt+bcK7b2ytQc0BmQtOor+izyENE10Yq3I+a4oPi46Q4CiT9sKYpFnQOoZcfSp46vq9w=='

/**
 * 宿主要自己装的 HTTP 服务器。
 *
 * README 明说:隔离式包管理布局下拿不到这个包自己那一份,**宿主必须直接装一份**。
 */
export const CONNECTOR_HOST_SERVER_PACKAGE = '@hono/node-server'
export const CONNECTOR_HOST_SERVER_VERSION = '2.1.1'

/** 它自己声明的最低 node:`engines.node: ">=22.18.0"`。工作台自带的是 24.19.0,够。 */
export const CONNECTOR_MIN_NODE = '22.18.0'
export const CONNECTOR_MIN_NODE_MAJOR = 22

/**
 * 端口 8796。
 *
 * 本机已占:3080(DSH web)、8791(工作台)、8792(事务官本机后端)、
 * 8794(小组件单开来源)。8795 是云端 relay 的口,本机不占但**留着不用**,
 * 免得日后在同一台机器上跑 relay 时撞名。于是往上取 8796。
 */
export const CONNECTOR_DEFAULT_PORT = 8796

/** launchd 标签,与 `ai.deepseek.butler` 并列。 */
export const CONNECTOR_LAUNCHD_LABEL = 'ai.deepseek.connector'

/** 各家 Agent 的 MCP 配置里,我们这一条叫什么。改名等于换一条,不要改。 */
export const CONNECTOR_MCP_NAME = 'open-connector'

/** 写进各家配置时留的指纹:**只有带着它的那一条才是我们写的**,才允许覆盖。 */
export const CONNECTOR_MCP_FINGERPRINT = 'desktop-workbench/open-connector'

export interface ConnectorPaths {
  /** `~/.dsh/open-connector` —— 本体与依赖(node_modules)、宿主脚本。 */
  dir: string
  /** 宿主进程入口 `~/.dsh/open-connector/server.mjs`。 */
  entry: string
  /** `~/.dsh/open-connector/node_modules`。 */
  nodeModules: string
  /** 解开的包本体,用来读目录与 catalog。 */
  packageDir: string
  /** provider 目录(catalog)所在,策略生成要逐个读它。 */
  catalogDir: string
  /** 数据目录(SQLite + 中转文件)`~/.dsh/open-connector/data`。**凭据就落在这里,永不上传。** */
  dataDir: string
  /** 配置 `~/.dsh/workbench/connector.json`(0600,端口与本机令牌)。 */
  configFile: string
  /** 启动脚本 `~/.dsh/bin/connector-start`。 */
  startScript: string
  /** `~/Library/LaunchAgents/ai.deepseek.connector.plist`。 */
  plist: string
  /** 工作台自带的 node。 */
  nodeBin: string
}

/** 全部路径都从 `home` 算,**没有默认值** —— 测试整个搬进临时 HOME 靠的就是这一条。 */
export function connectorPaths(home: string): ConnectorPaths {
  const dsh = `${home}/.dsh`
  const dir = `${dsh}/open-connector`
  const packageDir = `${dir}/node_modules/${CONNECTOR_PACKAGE}`
  return {
    dir,
    entry: `${dir}/server.mjs`,
    nodeModules: `${dir}/node_modules`,
    packageDir,
    catalogDir: `${packageDir}/assets/open-connector/catalog/apps`,
    dataDir: `${dir}/data`,
    configFile: `${dsh}/workbench/connector.json`,
    startScript: `${dsh}/bin/connector-start`,
    plist: `${home}/Library/LaunchAgents/${CONNECTOR_LAUNCHD_LABEL}.plist`,
    nodeBin: `${dsh}/node/bin/node`,
  }
}

/**
 * 装它要往磁盘上放的那棵依赖树有多大(2026-09-27 在隔离 HOME 里实测 229MB)。
 * 只用于界面上说人话,不参与任何判断。
 */
export const CONNECTOR_DISK_BYTES = 229 * 1024 * 1024

/** 目录布局一旦改了,下面这张清单要跟着改 —— 卸载靠它,漏一项就卸不干净。 */
export function connectorOwnedPaths(home: string): readonly string[] {
  const p = connectorPaths(home)
  return [p.dir, p.configFile, p.startScript, p.plist]
}
