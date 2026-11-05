/**
 * 这份构建带着哪台中转、去哪查更新。**构建时注入**(同 version.ts 的做法;怎么定的见 scripts/build-endpoints.mjs):
 * 我们自己的发版构建编进我们那台,开源构建是空 —— 零服务器是缺省(2026-10-21,局域网 M7)。
 *
 * 空的意思是「这台没接中转」:不领中转令牌、不登录中转账号、不查热更新,界面在那几处如实说一句,在家功能照常。
 * 自建中转的人在 `model.json` 的 `relay_url`、`endpoints.json` 的 `update_manifest_url` 里填,压过这里。
 * 没注入到(用例、直接跑源码)就是空,不猜。
 */
declare const __WORKBENCH_BUILD_RELAY_URL__: unknown
declare const __WORKBENCH_BUILD_UPDATE_URL__: unknown

export const BUILD_RELAY_URL: string = typeof __WORKBENCH_BUILD_RELAY_URL__ === 'string' ? __WORKBENCH_BUILD_RELAY_URL__ : ''

export const BUILD_UPDATE_MANIFEST_URL: string = typeof __WORKBENCH_BUILD_UPDATE_URL__ === 'string' ? __WORKBENCH_BUILD_UPDATE_URL__ : ''
