/**
 * 自定义模块的**单开来源**(2026-09-22,C7「自定义模块真边界」)。
 *
 * 2026-09-21 那一版把模块页面挂在工作台自己那台服务(8791)的 `/modules/<id>/…` 上 ——
 * **同源**。同源意味着那张「能用 / 不要碰」的接口表只是一份规范:一个写岔了的模块页面
 * `fetch('/credentials')` 照样打得通,浏览器不会拦,服务端看见的也只是一条回环请求。
 * 交接-0921 第五节第 1 条把这件事原样写了出来,并留了三条路给 Ben 拍板;
 * 他选了第三条(决策记录 C7):**给模块另开一个来源,只放行那几条接口**。
 *
 * 这个文件就是那个来源。四件事:
 *
 *   1. **另一台监听**(默认 8794,只绑回环)。它只会端模块目录里的静态文件,一条别的路由都没有
 *      —— 于是 iframe 的 origin 是 `http://127.0.0.1:8794`,与工作台服务(8791)**不同源**。
 *   2. **模块专用令牌**。一个模块一把,签在 iframe 的 URL 里;它的权限**只有白名单那几条**,
 *      不是工作台的主令牌。可吊销(移进回收站就当场作废),30 分钟过期、12 小时内可续。
 *   3. **注入**。端出 HTML 时在文档头部塞一段前言:`window.WB_MODULE_TOKEN` / `WB_API_BASE`,
 *      外加一层 `fetch` 包装 —— **老模块目录一个字节都不用改**,它里面写的 `fetch('/state')`
 *      会被这层包装改写成"带令牌打 8791"。
 *   4. **CSP 按来源写死**。加了 `sandbox` 的 iframe 是**不透明来源**,CSP 里的 `'self'`
 *      在那种文档里谁都不匹配(连模块自己的 css/图片都会被拦)。所以这里不写 `'self'`,
 *      写两个具体的 origin。
 *
 * ## 这条边界拦得住什么
 *
 * - 模块 `fetch('http://127.0.0.1:8791/credentials')`:8791 那边看见 `Origin` 是模块来源
 *   (或 `null` —— sandbox 之后就是 null),**降权成模块身份**,白名单外一律 403。
 *   连 `mode:'no-cors'` 那种"发出去就不管回什么"的写请求也拦得住,因为门在服务端不在浏览器。
 * - 模块引外网:CSP 的 `script-src`/`connect-src` 里只有这两个 origin,浏览器那一层就断。
 * - 模块偷工作台的账号 cookie:跨源了,而且 8791 对模块来源**不发**
 *   `Access-Control-Allow-Credentials`,cookie 带不过去。
 *
 * ## 拦不住什么(如实写在这儿)
 *
 * - 本机上别的进程照样能直接打 8794 把模块页面拉下来。8794 只绑回环,而回环在这台机器上
 *   本来就是全权信任的 —— 这一版没有把"本机进程之间"也当成边界,那是另一件事。
 * - 模块把自己这一格 iframe 导航到别处。sandbox 没给 `allow-top-navigation`,
 *   导航之后的文档同样是不透明来源、同样读不回去,所以它只能把自己弄白屏。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { CustomModulesService } from './modules.ts'
import { isModuleId } from './modules.ts'

/** 模块来源的默认端口。8791 是工作台服务,8794 是模块 —— 中间留了三个号给以后。 */
export const DEFAULT_MODULE_PORT = 8794

/** 令牌的活期:签出来 30 分钟内能打接口。 */
export const MODULE_TOKEN_TTL_MS = 30 * 60 * 1000

/**
 * 一把令牌的**总寿命**:签出来 12 小时之内都还能拿它换一把新的(续期),超过就不认了。
 *
 * 为什么要两个时长:iframe 的 src 里签着令牌,而 src **一变这块 iframe 就重载** ——
 * 番茄钟当场从头开始计时(保活那条是这一档存在的理由之一)。所以 src 里那把用长的那个口径
 * 判(页面还端得出来),页面里真去打接口的那把用短的那个口径判、由注入的前言自己去续。
 */
export const MODULE_SESSION_MS = 12 * 60 * 60 * 1000

/** 令牌前缀。8791 那边靠它一眼认出"这不是设备令牌,别送去配对服务验"。 */
export const MODULE_TOKEN_PREFIX = 'wbm.'

/**
 * 放给自定义模块的那几条接口。**逐条列全,不写前缀通配**。
 *
 * `docs/自定义模块-接口.md` 第三节那张表就是这一份,两边必须一个字不差 ——
 * 文档里多写一条而这里没有,模块作者会收到一个他看不懂的 403;
 * 这里多放一条而文档里没写,那就是一条没人知道的口子。
 *
 * ★ 2026-10-01 起**真有用例钉着**三处(这里、`devTool.ts` 的 `devToolBrief()` 正文、那份文档):
 * `tests/module-api-whitelist-guard.test.ts` 读源头文件比对,加漏一处当场红。
 *
 * 为什么不写成 `/task/*`:同一个处理分支下面还挂着 `/sprint/*`、`/module/*`、
 * `/board/project`,前缀通配会把它们一起放进来。
 */
export const MODULE_API_ROUTES: readonly { readonly method: 'GET' | 'POST', readonly path: string }[] = [
  { method: 'GET', path: '/state' },
  { method: 'POST', path: '/task/create' },
  { method: 'POST', path: '/task/move' },
  { method: 'POST', path: '/task/update' },
  { method: 'POST', path: '/note/add' },
  { method: 'POST', path: '/note/remove' },
  /**
   * **第七条(2026-09-23,用户层)**:读她的采集器采回来的那一份(`<工作目录>/数据/<名>/最新.txt`)。
   * 只读、只认 `?name=` 一个参数、名字过路径闸;别的文件一概读不到。
   * 有了它,「看店铺数据」那种小组件才有数可画 —— 解析在小组件自己的 JS 里,本体不解析。
   */
  { method: 'GET', path: '/module/data' },
  /**
   * **第八条(2026-10-01,C2「小组件派出去」那张卡)**:让她自己那一版「数据复盘」上也能有一颗「刷新」。
   *
   * 凭什么它可以进这张表,而 `/files/reveal` 不行:**它受的是它原有的那道频率闸**
   * ——两次自取之间至少 10 分钟,闸在 `xhs.collect('manual')` 自己身上,不在调用方这一侧。
   * 也就是说这条口给不出任何比内置那一格更多的东西:内置「数据复盘」上那颗键打的就是它。
   * 她把内置那格收起、换成自己那一版之后,要是连刷新都没了,那一版就不是「改成她要的样子」,
   * 是「少了一半」。
   */
  { method: 'POST', path: '/xhs/refresh' },
  /**
   * **第九条(2026-10-01,同一张卡)**:只准打开**素材那几个固定子文件夹**。
   *
   * 她自己那一版「素材管理」要能点开一个文件夹(内置那一排按钮干的就是这件事)。
   * 但**不放开 `POST /files/reveal`**:那一条收任意路径,而且会在她屏幕上弹 Finder
   * (2026-09-22 正因为这两样被从表上拿掉)。这一条换了个设计:
   *
   * - 只收**一个素材文件夹名**(`{ name: '脚本' }`),路径由服务端自己从
   *   `/state.template.asset_dirs` 里查 —— 模块手里从来没有、也拼不出绝对路径;
   * - 名字不在那一份里就 404,**一个字都不办**:能打开的集合是「模板建出来的那几个文件夹」,
   *   有限、她自己看得见,不是「这台 Mac 上的任意路径」。
   *
   * 还是会弹 Finder,所以它仍然是这张表上唯一一条**会在她屏幕上弹出东西**的 ——
   * 但弹出来的是她刚点的那个素材文件夹,与她在内置那一格里点一下的结果一模一样。
   */
  { method: 'POST', path: '/files/asset-reveal' },
  /**
   * **`POST /files/reveal` 2026-09-22 从这张表上去掉了**(待拍板 E3,按统筹建议做)。
   *
   * 它是当时那七条里唯一一条**会在 Ben 的屏幕上弹出东西**的(`open -R`,拉起 Finder)。
   * 它不读也不写任何内容,但一个写岔了(或者被喂了坏提示词)的模块可以拿它一直弹窗烦人,
   * 而模块本来就看不见文件路径 —— 它只能从 `/state` 里读到些什么再转手递过去,
   * 也就是说这条口子给的不是「模块要用的能力」,是「模块能打扰他的能力」。
   *
   * 路由本身**没删**:图谱、素材那一排、随手记文件卡照旧走 `POST /files/reveal`,
   * 那些是工作台自己的页面,走的是回环那道门,不经这张表。
   */
]

/** 白名单判定。路径要**完全相等**(查询串由调用方先摘掉),方法也要对得上。 */
export function isModuleApiAllowed(method: string | undefined, path: string): boolean {
  return MODULE_API_ROUTES.some(route => route.method === method && route.path === path)
}

/** 前言里给页面看的那份清单(与上面同一份,只是摊平成路径)。 */
export function moduleApiPaths(): string[] {
  return [...new Set(MODULE_API_ROUTES.map(route => route.path))]
}

/**
 * 模块页面的 CSP。**不写 `'self'`**:见文件头第 4 条 —— sandbox 之后文档是不透明来源,
 * `'self'` 匹配不到任何东西,模块自己的 `assets/x.css` 都会被拦掉。
 *
 * `connect-src` 里多出来的那个 `apiOrigin` 是这一版唯一放宽的一处:模块要打的那几条接口
 * 现在在别的 origin 上。**放宽的是能打到哪台服务,不是能打哪几条** —— 打哪几条由 8791
 * 那边的白名单说了算,浏览器这一层管不了也不该管。
 */
export function moduleCsp(input: { moduleOrigin: string, apiOrigin: string }): string {
  const self = input.moduleOrigin
  const api = input.apiOrigin
  return [
    `default-src ${self}`,
    `script-src ${self} 'unsafe-inline'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `connect-src ${self} ${api}`,
    `media-src ${self} data: blob:`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // 谁能把它嵌进去:只有回环上的工作台页面(DSH 托在 :3080,服务在 :8791)。
    'frame-ancestors http://127.0.0.1:* http://localhost:*',
  ].join('; ')
}

// ───────────────────────────────────────────────────────────── 令牌

export interface ModuleTokenClaims {
  /** 这把令牌是哪个模块的。 */
  module_id: string
  /** 签出来的时刻(ms)。续期看它。 */
  issued_at: number
  /** 过期时刻(ms)。打接口看它。 */
  expires_at: number
}

export interface ModuleTokens {
  /** 签一把(同一个模块在有效期内反复要,给的是同一把 —— iframe 的 src 不能一秒一变)。 */
  issue: (moduleId: string) => string
  /** 打接口那道验:签名、吊销、**过期**都要过。 */
  verifyApi: (token: string | undefined) => ModuleTokenClaims | undefined
  /** 端页面 / 续期那道验:签名、吊销、**总寿命**要过,过期本身不拦。 */
  verifySession: (token: string | undefined) => ModuleTokenClaims | undefined
  /** 拿旧的换新的。换不了(签名坏、已吊销、超了总寿命)回 undefined。 */
  renew: (token: string | undefined) => string | undefined
  /** 吊销这个模块的全部令牌,**当场生效**(移进回收站时调它)。 */
  revoke: (moduleId: string) => void
}

function b64url(raw: Buffer | string): string {
  return Buffer.from(raw as never).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(raw: string): Buffer {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export interface ModuleTokensOptions {
  /** 签名密钥。缺省**每次起服务现摇一把**:重启即换,落盘的东西里一个字节都没有。 */
  secret?: Buffer
  now?: () => number
  ttlMs?: number
  sessionMs?: number
}

export function createModuleTokens(options: ModuleTokensOptions = {}): ModuleTokens {
  const secret = options.secret ?? randomBytes(32)
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? MODULE_TOKEN_TTL_MS
  const session = options.sessionMs ?? MODULE_SESSION_MS
  /**
   * 吊销靠**代**:每个模块一个数,吊销就 +1,旧令牌里签的那个数对不上就作废。
   * 不留"已吊销令牌清单" —— 那份清单会随时间只长不消,而且重启就丢。
   */
  const epochs = new Map<string, number>()
  /** 有效期内重复签发给的是同一把(见 issue 的注释)。 */
  const live = new Map<string, { token: string, expires_at: number }>()

  const sign = (payload: string): string =>
    b64url(createHmac('sha256', secret).update(payload).digest())

  const epochOf = (moduleId: string): number => epochs.get(moduleId) ?? 0

  const parse = (token: string | undefined): ModuleTokenClaims | undefined => {
    if (typeof token !== 'string' || !token.startsWith(MODULE_TOKEN_PREFIX)) return undefined
    const parts = token.slice(MODULE_TOKEN_PREFIX.length).split('.')
    if (parts.length !== 2) return undefined
    const [payload, mac] = parts as [string, string]
    const expect = sign(payload)
    // 定长才好做等时比较;长度对不上直接否(不同长度的 timingSafeEqual 会抛)。
    if (mac.length !== expect.length) return undefined
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return undefined
    let raw: { m?: unknown, e?: unknown, i?: unknown, x?: unknown }
    try { raw = JSON.parse(unb64url(payload).toString('utf8')) as typeof raw }
    catch { return undefined }
    if (!isModuleId(raw.m)) return undefined
    if (typeof raw.e !== 'number' || typeof raw.i !== 'number' || typeof raw.x !== 'number') return undefined
    // 吊销过的那一代,签名再对也不认。
    if (raw.e !== epochOf(raw.m)) return undefined
    return { module_id: raw.m, issued_at: raw.i, expires_at: raw.x }
  }

  const mint = (moduleId: string): string => {
    const issued = now()
    const payload = b64url(JSON.stringify({ m: moduleId, e: epochOf(moduleId), i: issued, x: issued + ttl }))
    return `${MODULE_TOKEN_PREFIX}${payload}.${sign(payload)}`
  }

  return {
    issue(moduleId) {
      const cached = live.get(moduleId)
      // 还剩一分钟以上就原样给回去:/state 是一秒一拍的,每拍换一把等于 iframe 的 src
      // 一秒一变 —— 那块 iframe 会被 React 当成换了一个页面,当场重载。
      if (cached !== undefined && cached.expires_at - now() > 60_000) return cached.token
      const token = mint(moduleId)
      live.set(moduleId, { token, expires_at: now() + ttl })
      return token
    },
    verifyApi(token) {
      const claims = parse(token)
      if (claims === undefined) return undefined
      return now() < claims.expires_at ? claims : undefined
    },
    verifySession(token) {
      const claims = parse(token)
      if (claims === undefined) return undefined
      return now() < claims.issued_at + session ? claims : undefined
    },
    renew(token) {
      const claims = parse(token)
      if (claims === undefined) return undefined
      if (now() >= claims.issued_at + session) return undefined
      const fresh = mint(claims.module_id)
      live.set(claims.module_id, { token: fresh, expires_at: now() + ttl })
      return fresh
    },
    revoke(moduleId) {
      epochs.set(moduleId, epochOf(moduleId) + 1)
      live.delete(moduleId)
    },
  }
}

// ───────────────────────────────────────────────────────────── 注入

/** 塞进文档里那段 JSON 不能带 `<`,否则 `</script>` 那种串会把 script 提前关掉。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * 注入的前言。**老模块跑得动全靠它**:模块里写的是 `fetch('/state')`,
 * 而 `/state` 现在在另一个 origin 上、还要带令牌 —— 这层包装把那种调用原样改写过去。
 *
 * 三条纪律:
 *   ① **只改白名单里那几条**。别的 URL(模块自己的 `assets/x.json`、外网)原样放过,
 *      让它照旧走 CSP 那一关 —— 这层包装不是第二道门,门在 8791 那边。
 *   ② **不带 cookie**(`credentials:'omit'`)。模块拿不到工作台的账号会话。
 *   ③ **401 自己去续一次**。令牌 30 分钟就过期,而一格模块开一整天不重载是常态。
 */
export function modulePrelude(input: {
  moduleId: string
  token: string
  apiOrigin: string
  moduleOrigin: string
}): string {
  return `<script>(function(){
var API=${safeJson(input.apiOrigin)},SELF=${safeJson(input.moduleOrigin)},ALLOW=${safeJson(moduleApiPaths())};
var token=${safeJson(input.token)};
window.WB_MODULE_ID=${safeJson(input.moduleId)};
window.WB_API_BASE=API;
window.WB_MODULE_API=ALLOW.slice();
Object.defineProperty(window,'WB_MODULE_TOKEN',{get:function(){return token},configurable:true});
var raw=window.fetch&&window.fetch.bind(window);
if(!raw)return;
function target(input){
var href=typeof input==='string'?input:(input&&input.url);
if(typeof href!=='string')return null;
var url;try{url=new URL(href,document.baseURI)}catch(e){return null}
if(url.origin!==SELF&&url.origin!==API)return null;
if(ALLOW.indexOf(url.pathname)<0)return null;
return API+url.pathname+url.search;
}
function call(to,init,input){
var opts={};for(var k in (init||{}))opts[k]=init[k];
var h=new Headers((init&&init.headers)||(typeof input!=='string'&&input&&input.headers)||{});
h.set('authorization','Bearer '+token);
opts.headers=h;opts.credentials='omit';opts.mode='cors';
if(opts.method===undefined&&typeof input!=='string'&&input&&input.method)opts.method=input.method;
return raw(to,opts).then(function(res){
if(res.status!==401)return res;
return renew().then(function(ok){
if(!ok)return res;
h.set('authorization','Bearer '+token);opts.headers=h;
return raw(to,opts);
});
});
}
function renew(){
return raw(SELF+'/__wb/renew',{method:'POST',mode:'cors',credentials:'omit',headers:{authorization:'Bearer '+token}})
.then(function(r){return r.ok?r.json():null})
.then(function(j){if(j&&typeof j.token==='string'){token=j.token;return true}return false})
.catch(function(){return false});
}
window.fetch=function(input,init){
var to=target(input);
return to===null?raw(input,init):call(to,init,input);
};
})();</script>`
}

/**
 * 把前言塞进这份 HTML。
 *
 * 位置很讲究:**绝不能塞在 `<!doctype html>` 前面** —— 文档类型声明前面出现内容会让
 * 浏览器进怪异模式,模块的布局当场走样。所以按 `<head>` → `<html>` → doctype → 开头
 * 这个顺序找第一个能塞的地方。
 */
export function injectModulePrelude(html: string, prelude: string): string {
  const after = (re: RegExp): number => {
    const hit = re.exec(html)
    return hit === null ? -1 : hit.index + hit[0].length
  }
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]
    .map(after).find(index => index >= 0) ?? 0
  return html.slice(0, at) + prelude + html.slice(at)
}

// ───────────────────────────────────────────────────────────── 那台监听

export interface ModuleOriginServer {
  port: number
  /** `http://127.0.0.1:<port>`。iframe 的 origin 就是它。 */
  origin: string
  /** 某个模块那块 iframe 的 src(带着这个模块那把令牌)。 */
  frameUrl: (moduleId: string, entry: string) => string
  close: () => Promise<void>
}

export interface StartModuleOriginOptions {
  /** 0 = 由系统分配(用例用)。 */
  port: number
  modules: CustomModulesService
  tokens: ModuleTokens
  /** 工作台服务那个 origin(`http://127.0.0.1:8791`)。CSP 与注入都要用它。 */
  apiOrigin: string
  /** 只绑回环。留这个参数是为了用例,不是为了给谁改成 0.0.0.0。 */
  host?: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 页面端不出来时给一句人话,而不是白屏 —— 白屏是这一档最难查的故障。 */
function sendNotice(res: ServerResponse, status: number, text: string): void {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e8edf5;font:14px/1.6 -apple-system,'PingFang SC',system-ui,sans-serif">${text}</body>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
  })
  res.end(html)
}

/**
 * 模块来源那台监听。**它只会做一件事:端模块目录里的静态文件**(外加一条续期)。
 * 没有 /state、没有 /task、没有任何工作台的东西 —— 这正是"单开来源"这四个字的意思。
 */
export async function startModuleOriginServer(options: StartModuleOriginOptions): Promise<ModuleOriginServer> {
  const host = options.host ?? '127.0.0.1'
  const { modules, tokens, apiOrigin } = options

  let origin = ''

  const bearer = (req: IncomingMessage): string | undefined => {
    const raw = req.headers.authorization
    if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return undefined
    const token = raw.slice('Bearer '.length).trim()
    return token === '' ? undefined : token
  }

  /**
   * 跨源头。sandbox 之后模块文档是**不透明来源**,它发出来的 `Origin` 是字面量 `null` ——
   * 所以这里反射回去的也是 `null`。不发 `Allow-Credentials`:模块不带 cookie。
   */
  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const raw = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    if (raw === undefined) return
    res.setHeader('Access-Control-Allow-Origin', raw === 'null' ? 'null' : raw)
    res.setHeader('Vary', 'Origin')
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    cors(req, res)
    const url = req.url ?? '/'
    const query = url.indexOf('?')
    const path = query < 0 ? url : url.slice(0, query)
    const search = query < 0 ? '' : url.slice(query + 1)

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
      res.setHeader('Access-Control-Max-Age', '600')
      res.writeHead(204)
      res.end()
      return
    }

    // 续期:拿旧的换新的。旧的过期了也认(只要没超总寿命、没被吊销)——
    // 一格模块开一整天不重载是常态,而令牌 30 分钟就过期。
    if (path === '/__wb/renew' && req.method === 'POST') {
      const fresh = tokens.renew(bearer(req))
      if (fresh === undefined) { sendJson(res, 401, { error: '模块令牌换不了新的:过期太久,或者这个模块已经被移走' }); return }
      sendJson(res, 200, { token: fresh })
      return
    }

    if (!path.startsWith('/modules/') || req.method !== 'GET') {
      // 这台服务**只有**模块文件这一条路由。别的一律 404,不代理、不转发。
      sendJson(res, 404, { error: '这台只端自定义模块的文件' })
      return
    }

    const rest = path.slice('/modules/'.length)
    const slash = rest.indexOf('/')
    const id = slash < 0 ? rest : rest.slice(0, slash)
    const rel = slash < 0 ? '' : rest.slice(slash + 1)
    if (!isModuleId(id)) { sendNotice(res, 400, '认不出这个模块'); return }

    const hit = await modules.file(id, rel)
    if ('kind' in hit) {
      const reason = hit.kind === 'id'
        ? '认不出这个模块'
        : hit.kind === 'path'
          ? '这个路径不在模块目录里'
          : hit.kind === 'type'
            ? '这种文件不给'
            : '模块里没有这个文件'
      if (hit.kind === 'missing') sendNotice(res, 404, reason)
      else sendJson(res, 400, { error: reason })
      return
    }

    const headers: Record<string, string> = {
      'content-type': hit.contentType,
      'content-security-policy': moduleCsp({ moduleOrigin: origin, apiOrigin }),
      'x-content-type-options': 'nosniff',
      // 模块是 DSH 随时会改写的东西,缓存住只会让他改完看不见。
      'cache-control': 'no-store',
    }

    if (!hit.contentType.startsWith('text/html')) {
      const body = await readFile(hit.path)
      res.writeHead(200, { ...headers, 'content-length': String(body.byteLength) })
      res.end(body)
      return
    }

    // HTML 才注入前言。令牌从 URL 上的 `?wb=` 取 —— 那是工作台签给这一格 iframe 的那把。
    const token = new URLSearchParams(search).get('wb') ?? undefined
    const claims = tokens.verifySession(token)
    if (claims === undefined || claims.module_id !== id) {
      sendNotice(res, 403, '这一格的模块令牌过期了,或者不是这个模块的。刷新一下工作台就好。')
      return
    }
    const html = await readFile(hit.path, 'utf8')
    const body = injectModulePrelude(html, modulePrelude({
      moduleId: id,
      // 注入的是**新签的那把**(URL 上那把可能只剩总寿命、已经过了活期)。
      token: tokens.issue(id),
      apiOrigin,
      moduleOrigin: origin,
    }))
    res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(body)) })
    res.end(body)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`模块来源的端口 ${options.port} 已被占用,换一个(WORKBENCH_MODULE_PORT)或先停掉占用的进程`)
        : err)
    })
    server.listen(options.port, host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  origin = `http://${host === '::1' ? '[::1]' : host}:${port}`

  return {
    port,
    origin,
    frameUrl(moduleId, entry) {
      return `${origin}/modules/${moduleId}/${entry}?wb=${encodeURIComponent(tokens.issue(moduleId))}`
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    },
  }
}
