import { markLocalChanged } from './syncEngine.ts';

export type CharacterSettings = {
  customName: string;
  customPersona: string;
  customTone: string;
  customTraits: string;
  customStyleRules: string;
  worldBackground: string;
  /** 通话(RTC)音色，留空则用角色默认音色 */
  callVoice?: string;
};

const STORAGE_PREFIX = 'llm-live2d:char-settings:';

function getKey(avatarId: string) {
  return `${STORAGE_PREFIX}${avatarId}`;
}

export function loadCharacterSettings(avatarId: string): CharacterSettings | null {
  try {
    const raw = localStorage.getItem(getKey(avatarId));
    if (!raw) return null;
    return JSON.parse(raw) as CharacterSettings;
  } catch {
    return null;
  }
}

export function saveCharacterSettings(avatarId: string, settings: CharacterSettings) {
  localStorage.setItem(getKey(avatarId), JSON.stringify(settings));
  markLocalChanged('characterSettings');
}

export function deleteCharacterSettings(avatarId: string) {
  localStorage.removeItem(getKey(avatarId));
  markLocalChanged('characterSettings');
}

export function getDefaultSettings(): CharacterSettings {
  return {
    customName: '',
    customPersona: '',
    customTone: '',
    customTraits: '',
    customStyleRules: '',
    worldBackground: '',
    callVoice: '',
  };
}
