import type { AvatarManifest } from './types.ts';

/**
 * 把 model3.json 的原始 settings 增强成「带命名动作组 + 表情」的版本。
 *
 * 为什么必须有这一步：模型自带的 model3.json **没有任何 Motions 组与 Expressions**
 * （ghostpuppy / tororo / hijiki 实测皆为空），动作与表情全部由 avatarData.ts 的清单注入。
 * 不做增强就加载模型，角色会是个静止的木头人。
 *
 * 本模块刻意不依赖 PixiJS / DOM / 设备探测，因此除了运行时（live2dEngine、nativeStage），
 * 构建期脚本（scripts/export-wallpaper-avatars.mjs，为动态壁纸烘 settings）也能直接复用，
 * 保证两端零漂移。纹理路径映射通过参数注入——运行时传低端降档函数，构建期不传。
 */
export function createAugmentedSettings(
  settings: Record<string, unknown>,
  avatar: AvatarManifest,
  options: { mapTexturePath?: (path: string) => string } = {},
): Record<string, unknown> {
  const { mapTexturePath } = options;
  const fileReferences = {
    ...(settings.FileReferences as Record<string, unknown> | undefined),
  };

  if (mapTexturePath && Array.isArray(fileReferences.Textures)) {
    fileReferences.Textures = (fileReferences.Textures as string[]).map(mapTexturePath);
  }

  const expressions = avatar.expressions
    .filter((expressionItem) => expressionItem.binding.mode === 'file')
    .map((expressionItem) => ({
      Name: expressionItem.id,
      File: toRelativeAssetPath(avatar.modelJson, (expressionItem.binding as { file: string }).file),
    }));

  if (expressions.length > 0) {
    fileReferences.Expressions = expressions;
  }

  if (avatar.motions && Object.keys(avatar.motions).length > 0) {
    const namedGroups: Record<string, Array<{ File: string }>> = {};
    for (const [name, binding] of Object.entries(avatar.motions)) {
      const file = toRelativeAssetPath(avatar.modelJson, binding.file);
      namedGroups[name] = [{ File: file }];
    }
    fileReferences.Motions = namedGroups;
  }

  return {
    url: encodeURI(avatar.modelJson),
    ...settings,
    FileReferences: fileReferences,
  };
}

export function toRelativeAssetPath(modelJson: string, assetPath: string) {
  const modelDirectory = modelJson.slice(0, modelJson.lastIndexOf('/') + 1);
  return assetPath.replace(modelDirectory, '');
}
