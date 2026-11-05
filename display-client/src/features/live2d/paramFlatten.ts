// 表情拍平（原生渲染路径）：expressionMix + parameterOverrides + watermark → 参数 map。
// 语义 1:1 复刻 live2dEngine.buildMixedParameters / mergeBindingIntoParameters：
//   preset → mixOverwrite(current, value, weight)
//   file   → 按 exp3 Blend：Add=加权叠加 / Multiply=加权乘 / Overwrite=插值
//   parameterOverrides → 最后直写
// 差异仅在 baseline 来源：WebView 用「首次追踪时的活值」，原生用参数表 default（≈中立位）。
// 独立成纯模块以便 vitest 直测（引擎里的实现耦合 Pixi runtime 无法单测）。
import type { AvatarManifest, ExpressionBinding, ExpressionLayer, ParameterOverride } from './avatarManifest.ts';

export type ExpressionFilePayload = {
  Parameters?: Array<{
    Id?: string;
    Value?: number;
    Blend?: 'Add' | 'Multiply' | 'Overwrite' | string;
  }>;
};

export type ResolvedFileParam = { id: string; value: number; blend: 'Add' | 'Multiply' | 'Overwrite' };

const fileCache = new Map<string, ResolvedFileParam[]>();

/** 切角色/销毁时清缓存（exp3 文件按 URL 缓存，跨角色无碰撞但防内存常驻）。 */
export function clearExpressionFileCache(): void {
  fileCache.clear();
}

function clampWeight(weight: number): number {
  return Math.min(Math.max(weight, 0), 1);
}

function normalizeBlend(value: string | undefined): 'Add' | 'Multiply' | 'Overwrite' {
  if (value === 'Multiply' || value === 'Overwrite') return value;
  return 'Add';
}

function mixOverwrite(base: number, target: number, weight: number): number {
  return base + (target - base) * weight;
}

function mixMultiply(base: number, value: number, weight: number): number {
  return base * (1 + (value - 1) * weight);
}

async function resolveFileParams(
  file: string,
  fetchExpressionFile: (url: string) => Promise<ExpressionFilePayload>,
): Promise<ResolvedFileParam[]> {
  const cached = fileCache.get(file);
  if (cached) return cached;
  const payload = await fetchExpressionFile(file);
  const resolved = resolvePayloadParams(payload);
  fileCache.set(file, resolved);
  return resolved;
}

function resolvePayloadParams(payload: ExpressionFilePayload): ResolvedFileParam[] {
  return (payload.Parameters ?? [])
    .filter((p) => p.Id && typeof p.Value === 'number')
    .map((p) => ({ id: p.Id!, value: p.Value!, blend: normalizeBlend(p.Blend) }));
}

/** 生产用 exp3 直取（共享 fileCache）：profile costume 参数拍平等不走 expression 清单的场景。 */
export async function fetchExpressionFileParams(url: string): Promise<ResolvedFileParam[]> {
  const cached = fileCache.get(url);
  if (cached) return cached;
  const response = await fetch(encodeURI(url));
  if (!response.ok) throw new Error(`exp3 fetch failed ${response.status}: ${url}`);
  const resolved = resolvePayloadParams((await response.json()) as ExpressionFilePayload);
  fileCache.set(url, resolved);
  return resolved;
}

async function mergeBinding(
  params: Map<string, number>,
  binding: ExpressionBinding,
  weight: number,
  baseline: (id: string) => number,
  fetchExpressionFile: (url: string) => Promise<ExpressionFilePayload>,
): Promise<void> {
  const w = clampWeight(weight);

  if (binding.mode === 'preset') {
    for (const [id, value] of Object.entries(binding.params)) {
      const current = params.get(id) ?? baseline(id);
      params.set(id, mixOverwrite(current, value, w));
    }
    return;
  }

  const resolved = await resolveFileParams(binding.file, fetchExpressionFile);
  for (const param of resolved) {
    const current = params.get(param.id) ?? baseline(param.id);
    if (param.blend === 'Overwrite') {
      params.set(param.id, mixOverwrite(current, param.value, w));
    } else if (param.blend === 'Multiply') {
      params.set(param.id, mixMultiply(current, param.value, w));
    } else {
      params.set(param.id, current + param.value * w);
    }
  }
}

export async function flattenExpressionState(input: {
  avatar: AvatarManifest;
  expressionMix: ExpressionLayer[];
  parameterOverrides: ParameterOverride[];
  watermarkVisible: boolean;
  /** 参数基线（原生参数表 default；未知参数给 0，与引擎 `?? 0` 兜底一致）。 */
  baseline: (id: string) => number;
  /** exp3 文件加载（可注入测试 fixture；生产走 fetch）。 */
  fetchExpressionFile: (url: string) => Promise<ExpressionFilePayload>;
}): Promise<Record<string, number>> {
  const { avatar, expressionMix, parameterOverrides, watermarkVisible } = input;
  const params = new Map<string, number>();
  const byId = new Map(avatar.expressions.map((e) => [e.id, e]));

  for (const layer of expressionMix) {
    const expression = byId.get(layer.key);
    if (!expression) continue; // 清单外 id 静默跳过（与引擎一致）
    await mergeBinding(params, expression.binding, layer.weight, input.baseline, input.fetchExpressionFile);
  }

  if (watermarkVisible && avatar.watermark) {
    for (const binding of avatar.watermark.bindings) {
      await mergeBinding(params, binding, 1, input.baseline, input.fetchExpressionFile);
    }
  }

  for (const override of parameterOverrides) {
    params.set(override.id, override.value);
  }

  const result: Record<string, number> = {};
  for (const [id, value] of params) {
    if (Number.isFinite(value)) result[id] = value;
  }
  return result;
}
