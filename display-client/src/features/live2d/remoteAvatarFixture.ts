import type { RemoteAvatarManifest } from './types.ts';

/**
 * 本地 mock manifest，用于在没有下载器 / 后端时验收远端覆盖闭环。
 *
 * 用法（开发者控制台 / 临时代码）：
 *   import { applyRemoteOverrides } from './features/live2d/avatarManifest.ts';
 *   import { remoteAvatarDemoFixture } from './features/live2d/remoteAvatarFixture.ts';
 *   applyRemoteOverrides(remoteAvatarDemoFixture);
 *
 * 预期：
 *   - getAvatarById('yumi').persona.tone === '冷静克制、理性沉稳'（覆盖内置人设）
 *   - CharacterDrawer 多出一个 'aurora' 角色（无缩略图 → 显示首字母 A，不崩）
 *   - 其余内置角色（shuangsheng / estella / rattan）保持不变
 */
export const remoteAvatarDemoFixture: RemoteAvatarManifest[] = [
  // 1) 覆盖既有 yumi 的人设（只给部分字段，其余沿用内置兜底）
  {
    id: 'yumi',
    persona: {
      tone: '冷静克制、理性沉稳',
      traits: ['冷静', '理性', '可靠', '观察入微'],
    },
    transform: {
      scaleMultiplier: 0.27,
      verticalOffset: 0.08,
    },
    model_entry: 'yumi.model3.json',
    version: '2',
    localDir: '/data/avatars/yumi/v2',
  },
  // 2) 全新远端角色（内置兜底里不存在）—— 故意不带缩略图，验证占位不崩
  {
    id: 'aurora',
    name: 'Aurora',
    summary: '远端新增的极光主题角色',
    persona: {
      tone: '空灵、神秘、带着远方的诗意',
      traits: ['空灵', '神秘', '诗意', '安静'],
      styleRules: ['用意象化的语言描绘情绪', '语速舒缓，留白克制'],
    },
    transform: {
      scaleMultiplier: 0.28,
      verticalOffset: 0.08,
      mobileDrawerOffsetX: -0.15,
      mobileDrawerOffsetY: -0.3,
    },
    motions: {
      idle: 'motions/idle.motion3.json',
      wave: { file: 'motions/wave.motion3.json', group: 'Gesture' },
    },
    model_entry: 'aurora.model3.json',
    version: '1',
    localDir: '/data/avatars/aurora/v1',
  },
];
