/**
 * 形象包渲染要用的纯函数(2026-10-01;从 packRenderer.ts 拆出来,那边一 import 就要 WebGL / window)。
 */
import type { HostAvatarItem } from './hostFeed';

/** 待机循环 / 随机插播在模型设置里的动作组名。 */
export const LOOP = 'Loop';
export const BEAT = 'Beat';

/** 路径逐段编码(包里有中文文件名),保留 `/`。 */
export function joinUrl(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return b + rel.split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * 把待机动作塞进模型设置:队列里给了循环 / 插播就以它为准(有的模型自己没登记动作)。
 * 一段都没给(上传的形象包、模型里找不到像待机的动作组)就不动模型自己登记的那些 —— 清成两组空的模型就僵住了。
 */
export function withPackMotions(settings: Record<string, unknown>, item: HostAvatarItem, url: string): Record<string, unknown> {
  if (item.idle.loop.length === 0 && item.idle.beats.length === 0) return { ...settings, url };
  const refs = { ...((settings.FileReferences as Record<string, unknown> | undefined) ?? {}) };
  refs.Motions = {
    [LOOP]: item.idle.loop.map((f) => ({ File: f })),
    [BEAT]: item.idle.beats.map((f) => ({ File: f })),
  };
  return { ...settings, url, FileReferences: refs };
}

