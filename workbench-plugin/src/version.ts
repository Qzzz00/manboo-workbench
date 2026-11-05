/**
 * 插件自己的版本号,**构建时注入**(tsdown `define` 从 package.json 读,vitest 同款注入),
 * 运行时不读文件——DSH 里 lib/index.js 到 package.json 的相对路径只是碰巧对,不该作为
 * 依据;注入进 bundle 后版本号跟代码本身一起发布,装了哪份代码就报哪个版本。
 *
 * 用处:mDNS TXT 的 v(手机配对)与 helper 通道的服务端 hello(壳据此判断插件换版要不要
 * 重载页面,2026-09-14)。没注入到就 '0',不猜。
 */
declare const __WORKBENCH_VERSION__: unknown

export const PLUGIN_VERSION: string = typeof __WORKBENCH_VERSION__ === 'string' ? __WORKBENCH_VERSION__ : '0'
