/**
 * 手机端源码(butler-app/src)的相对 import 不带后缀(它由 Vite 解析);Node 直接载要补上 `.ts`。
 * 只管相对路径、只在原样那个文件不在时补,别的一律交回默认解析。
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

export function installTsResolve(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:') === true && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        for (const ext of ['.ts', '.tsx', '/index.ts']) {
          const url = new URL(specifier + ext, context.parentURL)
          if (existsSync(fileURLToPath(url))) return next(url.href, context)
        }
      }
      return next(specifier, context)
    },
  })
}
