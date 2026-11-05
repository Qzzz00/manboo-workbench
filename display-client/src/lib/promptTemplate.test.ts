import { describe, it, expect } from 'vitest';
import {
  renderAvatarPrompt,
  buildVoiceCallSystemPrompt,
  buildVideoCallSystemPrompt,
} from './promptTemplate.ts';
import type { AvatarManifest } from '../features/live2d/avatarManifest.ts';

// 最小可用的角色清单（只填 prompt 构建会读到的字段）。测试跑在 node 环境（无 window），
// 因此不会命中 loadCharacterSettings，角色名直接取 avatar.name。
const avatar = {
  id: 'test-avatar',
  name: '测试角色',
  summary: '用于测试的角色',
  persona: {
    tone: '温柔',
    traits: ['善良', '阳光'],
    styleRules: ['说话清晰温暖'],
  },
  system_prompt: '',
  post_history_instructions: '',
} as unknown as AvatarManifest;

const ANCHOR_SELF = '你的身份：你是「测试角色」';
const ANCHOR_USER = '用户 = 正在跟你聊天的**真人玩家本人**';

describe('身份锚定块', () => {
  it('renderAvatarPrompt 的 systemPrompt 含角色名/用户身份锚定语', () => {
    const { systemPrompt } = renderAvatarPrompt(avatar, []);
    expect(systemPrompt).toContain(ANCHOR_SELF);
    expect(systemPrompt).toContain(ANCHOR_USER);
    // 原有的"你是 Live2D 虚拟角色 X，正在与用户进行对话"整句被锚定块取代
    expect(systemPrompt).not.toContain('你是 Live2D 虚拟角色 测试角色');
  });

  it('语音通话 prompt 含同样的锚定语', () => {
    const prompt = buildVoiceCallSystemPrompt(avatar);
    expect(prompt).toContain(ANCHOR_SELF);
    expect(prompt).toContain(ANCHOR_USER);
  });

  it('视频通话 prompt 含同样的锚定语', () => {
    const prompt = buildVideoCallSystemPrompt(avatar);
    expect(prompt).toContain(ANCHOR_SELF);
    expect(prompt).toContain(ANCHOR_USER);
  });
});
