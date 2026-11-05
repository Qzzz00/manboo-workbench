/**
 * 真实模式的配置解析(2026-10-27,卡 t-bd1c04ed 全链驱动):只读引用本机
 * `~/.dsh/workbench/model.json` 与 `credentials.json` —— **不复制、不打印、不进证据**。
 * 解析本身是这个纯函数:给定家目录,回那两份的绝对路径;不变量(绝对、在
 * `<home>/.dsh/workbench` 之下)由用例钉着(run.mjs 只把路径传给 createModelService)。
 *
 * @param {string} homeDir
 * @returns {{ modelFile: string, credentialFile: string }}
 */
export function resolveRealModelFiles(homeDir) {
  const home = resolve(homeDir)
  const dir = join(home, '.dsh', 'workbench')
  return { modelFile: join(dir, 'model.json'), credentialFile: join(dir, 'credentials.json') }
}

/** 不变量检查(用例用):两份都绝对路径、都在 `<home>/.dsh/workbench` 之下。 */
export function isRealModelFilesShape(files, homeDir) {
  const dir = join(resolve(homeDir), '.dsh', 'workbench')
  return isAbsolute(files.modelFile) && isAbsolute(files.credentialFile)
    && files.modelFile.startsWith(dir + '/') && files.credentialFile.startsWith(dir + '/')
}

import { join, isAbsolute, resolve } from 'node:path'
