// 覆盖包模型参数兼容性检查：覆盖模型必须包含内置同名角色已声明表情（exp3）引用的
// 全部参数，否则换装/道具触发会"执行成功但画面无变化"（v3 覆盖包事故：云端把轻量
// 模型 shuangsheng03 打包下发，它比完整模型少 Param66/67，baowawa 等全部失效）。
import type { AvatarExpression } from './types.ts';
import { fetchExpressionFileParams } from './paramFlatten.ts';

export type OverrideCompatResult =
  | { ok: true }
  | { ok: false; missing: string[] };

/**
 * @param baseExpressions 内置同名角色声明的表情清单（无声明视为无要求，直接放行）
 * @param readCdi3 读取覆盖包 cdi3.json 文本的回调；文件不存在返回 null（无法校验→放行）
 */
export async function checkOverrideParamCompat(
  baseExpressions: AvatarExpression[] | undefined,
  readCdi3: () => Promise<string | null>,
): Promise<OverrideCompatResult> {
  const declared = (baseExpressions ?? []).filter((e) => e.binding.mode === 'file');
  if (declared.length === 0) return { ok: true };

  const raw = await readCdi3();
  if (!raw) return { ok: true };
  let modelParamIds: Set<string>;
  try {
    const parsed = JSON.parse(raw) as { Parameters?: { Id?: string }[] };
    modelParamIds = new Set((parsed.Parameters ?? []).map((p) => p.Id).filter((id): id is string => !!id));
  } catch {
    return { ok: true }; // 解析失败无法校验→放行
  }

  const required = new Set<string>();
  for (const expression of declared) {
    if (expression.binding.mode !== 'file') continue;
    try {
      const params = await fetchExpressionFileParams(expression.binding.file);
      for (const p of params) required.add(p.id);
    } catch {
      // 单个 exp3 拉取失败不阻塞校验其余项
    }
  }

  const missing = [...required].filter((id) => !modelParamIds.has(id));
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

/** 由 model_entry 推 cdi3.json 的包内相对路径（xxx.model3.json → xxx.cdi3.json）。 */
export function cdi3PathForModelEntry(modelEntry: string): string {
  return modelEntry.replace(/\.model3\.json$/i, '.cdi3.json');
}
