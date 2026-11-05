import { useState } from 'react';
import { getAvatarById } from '../live2d/avatarManifest.ts';
import { generateDiary, type ChatMessage } from '../../lib/llm.ts';
import { addEntry, getLastGenTime, setLastGenTime } from '../../lib/diaryStore.ts';

const DIARY_THROTTLE_MS = 3600000; // 同一角色最多每小时自动生成一次

export interface UseDiaryResult {
  diaryOpen: boolean;
  setDiaryOpen: (open: boolean) => void;
  /** 对话后自动尝试：受 1 小时节流，不打开日记页。 */
  tryGenerateDiary: (avatarId: string) => void;
  /** 用户手动触发：跳过节流，生成后打开日记页。 */
  onDiaryTriggerGenerate: (avatarId: string) => void;
}

/**
 * 日记生成 + 日记页开关。从 App.tsx 抽出，行为不变。
 * 依赖当前各角色消息（用于喂给 generateDiary），由调用方传入。
 */
export function useDiary(messagesByAvatar: Record<string, ChatMessage[]>): UseDiaryResult {
  const [diaryOpen, setDiaryOpen] = useState(false);

  function generateDiaryEntry(avatarId: string, opts: { force: boolean; openAfter: boolean }) {
    if (!opts.force && Date.now() - getLastGenTime(avatarId) < DIARY_THROTTLE_MS) return;
    const avatar = getAvatarById(avatarId);
    if (!avatar) return;
    const recentMsgs = messagesByAvatar[avatarId] || [];
    generateDiary(avatar, recentMsgs)
      .then((text) => {
        addEntry({
          id: crypto.randomUUID(),
          authorId: avatarId,
          authorName: avatar.name,
          text,
          emotion: '📝',
          time: Date.now(),
          likes: [],
          comments: [],
        });
        setLastGenTime(avatarId);
        if (opts.openAfter) setDiaryOpen(true);
      })
      .catch((e) => console.error('[diary] generate failed:', e));
  }

  return {
    diaryOpen,
    setDiaryOpen,
    tryGenerateDiary: (avatarId) => generateDiaryEntry(avatarId, { force: false, openAfter: false }),
    onDiaryTriggerGenerate: (avatarId) => generateDiaryEntry(avatarId, { force: true, openAfter: true }),
  };
}
