/**
 * 页面该打哪台服务(2026-09-26,卡 GP)。
 *
 * ## 撞出来的事
 *
 * 页面里的服务地址一直是写死的 `http://127.0.0.1:8791`(`client/useWorkbenchState.ts` 的
 * `DEFAULT_BASE_URL`),而服务端的端口是**环境变量算出来的**(`WORKBENCH_PORT`,见
 * `server/http.ts` 的 `resolveWorkbenchPort`)。两边一直不说话:于是灰度实例(DSH 3090 +
 * 服务 8890)的页面把所有请求 —— 包括注册、写配置这种**写操作** —— 全打到了生产的 8791。
 * 09-26 统筹在灰度页面注册演示账号,被生产回了「这台电脑已经有账号了」,就是这条。
 *
 * ## 所以:服务端把自己的地址告诉页面
 *
 * 走 DSH 自己的那条客户端配置通道(不是我们另造一个全局变量):宿主半区在
 * `webserver/index-inject` 表里 push 一行 `{ kind: 'global', name, value }`,DSH 把它渲染成
 * index.html `<head>` 里一句赋值(`host/webserver/src/injections.ts`),页面端在 apply 里读走。
 * 上游自己就是这么给客户端传 config 的,同形的两处:
 * `dsh-client-ui-sidebar-documentpreview`(`__DSH_DOCUMENT_PREVIEW_CONFIG__`)、
 * `dsh-client-ui-settings-account`(`__DSH_CONTACT_CONFIG__`,连"名字做成共享常量"这一点也照它)。
 *
 * **只放地址,永远不放凭据**:这一行会渲进任何人都能看见的 HTML。
 *
 * ## 这个文件为什么在 src/ 根上
 *
 * 宿主半区(`src/index.ts`)与页面(`src/client/index.ts`)两边都要用同一个名字、同一套算法,
 * 名字对不上就是那种"界面上一切正常、其实一直没生效"的沉默失效(升级卡 U4 的 cookie 寿命
 * bug 活了两个大版本,就是 id 打错一个字)。所以放在两边都 import 得到的地方,并且
 * **一行 node 依赖都不许有** —— 它要跟着 `src/client/*` 一起进浏览器那份产物。
 */

/** 注入口的名字。宿主与页面各自 import 这一个常量,于是拼错就不可能发生。 */
export const SERVICE_CONFIG_GLOBAL = '__BEN_WORKBENCH_SERVICE__'

/** 宿主放进页面的那一份。**只有地址**,没有任何凭据。 */
export interface WorkbenchServiceConfig {
  /** 工作台服务的 origin,形如 `http://127.0.0.1:8791`,不带结尾斜杠。 */
  baseUrl: string
}

/**
 * DSH `webserver/index-inject` 表里我们要 push 的那一行(上游 `IndexInjection` 的
 * `global` 那一档)。**不 import 上游的类型**:宿主半区的运行时依赖只有 Node 内置模块,
 * 引一个 @deepseek-ai 的类型进来会把这个文件绑到某个具体版本的类型形状上(同
 * `src/index.ts` 里 `DshHostContext` 那段的理由,C3 明说会有破坏性变更)。
 */
export interface IndexInjectGlobalRow {
  kind: 'global'
  name: string
  value: unknown
}

/**
 * 页面该打的那个地址,由服务真正绑上的 host / port 算出来。
 *
 * host 的规矩(卡 GP:一律回环或页面自己的主机名):
 * - `0.0.0.0` / `::`(「允许手机在局域网访问」那档绑的通配地址)→ **回环**。绑了所有网卡,
 *   回环一定在里面,而页面就在这台机器上;回环也是账号 cookie 认的那个域
 *   (`account/accountApi.ts` 那句「请用 http://127.0.0.1:3080 打开」说的就是它)。
 * - `localhost` → 同样收成 `127.0.0.1`,别让 cookie 落在两个域上。
 * - 显式配了某个地址的旧用法(`WORKBENCH_HOST=<局域网 IP>`)→ 原样用它:那一档**只**绑那个
 *   地址,回环上根本没有人听。
 *
 * @param host 服务真正绑上的地址(`resolveWorkbenchHost` 的结果,或 `WorkbenchServer.host`)。
 * @param port 服务真正听着的端口(`resolveWorkbenchPort` 的结果,或 `WorkbenchServer.port`)。
 */
export function serviceBaseUrl(host: string, port: number): string {
  const reachable = host === '0.0.0.0' || host === '::' || host === 'localhost' ? '127.0.0.1' : host
  return `http://${reachable}:${String(port)}`
}

/** 宿主半区往 `webserver/index-inject` 表里放的那一行。 */
export function serviceInjectRow(host: string, port: number): IndexInjectGlobalRow {
  return {
    kind: 'global',
    name: SERVICE_CONFIG_GLOBAL,
    value: { baseUrl: serviceBaseUrl(host, port) } satisfies WorkbenchServiceConfig,
  }
}

/**
 * 页面端读注入进来的地址。
 *
 * **拿不到就返回 undefined,绝不自己编一个** —— 编出来的那个地址正是这张卡要修的病
 * (打到别人家的服务上,而且界面上一切正常)。兜底与那句日志由调用方
 * (`client/index.ts`)负责,它才知道"本来应该拿到"。
 *
 * @param scope 一般是 `globalThis`;用例传一个假对象。
 * @returns 规范化过的 origin(去掉结尾斜杠),形状不对就是 undefined。
 */
export function readServiceBaseUrl(scope: object): string | undefined {
  const raw = (scope as Partial<Record<typeof SERVICE_CONFIG_GLOBAL, unknown>>)[SERVICE_CONFIG_GLOBAL]
  if (typeof raw !== 'object' || raw === null) return undefined
  const baseUrl = (raw as Partial<WorkbenchServiceConfig>).baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  }
  catch {
    return undefined
  }
  // 只认 http(s):注入表是一行 HTML,别让 `javascript:` 这类东西顺着 fetch 的第一个参数进来。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.origin
}
