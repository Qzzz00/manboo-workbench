// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarEdit.test.ts
import { describe, it, expect } from 'vitest';
import { createDefaultPromptTemplate } from './AvatarEdit';

describe('createDefaultPromptTemplate', () => {
  it('生成的默认 story_string 包含 {{original}} 宏，用于兜底 persona.styleRules', () => {
    const template = createDefaultPromptTemplate('avatar-123');
    expect(template.story_string).toContain('{{original}}');
  });

  it('{{original}} 位于 {{personality}} 之后、{{scenario}} 之前', () => {
    const template = createDefaultPromptTemplate('avatar-123');
    const personalityIndex = template.story_string.indexOf('{{personality}}');
    const originalIndex = template.story_string.indexOf('{{original}}');
    const scenarioIndex = template.story_string.indexOf('{{scenario}}');
    expect(personalityIndex).toBeGreaterThan(-1);
    expect(originalIndex).toBeGreaterThan(personalityIndex);
    expect(scenarioIndex).toBeGreaterThan(originalIndex);
  });
});
