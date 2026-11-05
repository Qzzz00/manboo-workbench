// 来源:Aiboo origin/main 7c55ce12 src/features/live2d/avatarManifest.ts —— 裁剪版:
// 只留 live2dEngine 用到的两个纯函数与类型再导出。原文件还带内置角色表(avatarData.ts)与
// 参数发现、统一动作清单生成,那些是 Aiboo 的角色库,事务官的形象从本机后端下发,用不到。
import type {
  AvatarManifest,
  AvatarExpression,
  DiscoveredLive2DParameter,
  ExpressionBinding,
  ExpressionId,
  ExpressionLayer,
  ParameterCall,
  ParameterOverride,
  UnifiedAction,
} from './types.ts';

export type {
  AvatarManifest,
  AvatarExpression,
  DiscoveredLive2DParameter,
  ExpressionBinding,
  ExpressionId,
  ExpressionLayer,
  ParameterCall,
  ParameterOverride,
  UnifiedAction,
};

export function getAvatarNeutralExpressionId(avatar: AvatarManifest) {
  return avatar.expressions.find((item) => item.id === 'neutral')?.id
    ?? avatar.expressions[0]?.id
    ?? 'neutral';
}

export function getAvatarAction(avatar: AvatarManifest, idOrAlias: string): UnifiedAction | undefined {
  const normalized = idOrAlias.trim().toLowerCase();
  if (!normalized) return undefined;
  return avatar.actions?.find(
    (action) => action.id === normalized
      || action.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}
