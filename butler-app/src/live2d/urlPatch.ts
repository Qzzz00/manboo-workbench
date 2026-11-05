/**
 * pixi-live2d-display 0.4.0 用旧版 `url.resolve` 把 model3.json 里的相对路径拼到 settings.url 上;
 * 遇到我们塞进去的绝对 `blob:http://…` 会被它改成 `blob:http//…`(少一根斜杠,实测),纹理/moc 全 404。
 * 这里在原型上补一刀:带 scheme 的绝对地址原样返回,其它照旧。只动 pixi-live2d-display,不动 Aiboo 引擎文件。
 */
import { ModelSettings } from 'pixi-live2d-display/cubism4';

let installed = false;

export function installLive2DUrlPatch(): void {
  if (installed) return;
  installed = true;
  const original = ModelSettings.prototype.resolveURL;
  ModelSettings.prototype.resolveURL = function patchedResolveURL(this: ModelSettings, path: string): string {
    return isAbsoluteUrl(path) ? path : original.call(this, path);
  };
}

export function isAbsoluteUrl(path: string): boolean {
  return /^(blob|data|https?|file|capacitor):/i.test(path);
}
