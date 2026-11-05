import { statusTextFor, type StrategistState } from './strategistSession.ts';

export const HANDHELD_FIGMA_ASSETS = {
  stripAiChat: './handheld/figma/strip-ai-chat.svg',
  stripSettings: './handheld/figma/strip-settings.svg',
  stripExitGame: './handheld/figma/strip-exit-game.svg',
  stripBattery: './handheld/figma/strip-battery.svg',
  stripSignal: './handheld/figma/strip-signal.svg',
  voiceWaveform: './handheld/figma/voice-waveform.png',
} as const;

export type StripControlKind = 'chat' | 'settings' | 'exitGame';

export type StripControl = {
  kind: StripControlKind;
  label: string;
  icon: string;
};

export type StripTouchAction = {
  label: string;
  mode: 'label' | 'waveform';
  waveform?: string;
};

export type StripBubble = {
  role: 'assistant' | 'user';
  text: string;
  fallback?: boolean;
};

const HANDHELD_STRIP_STATUSBAR_CSS_PX = 32;
const HANDHELD_STRIP_HEIGHT_CSS_PX = 160;

/** 底栏背景 < Live2D < 右侧按钮；模型几何保持原位，不再用 Y 轴位移伪造层级。 */
export function handheldStripLayerLayout() {
  return {
    modelTopPx: 0,
    silhouetteBottomPx: 0,
    statusbarHeightPx: HANDHELD_STRIP_STATUSBAR_CSS_PX,
    rightPanelBottomInsetPx: HANDHELD_STRIP_STATUSBAR_CSS_PX,
    layers: {
      statusbar: 1,
      model: 2,
      controls: 3,
    },
    nativeBottomBar: {
      heightFraction: HANDHELD_STRIP_STATUSBAR_CSS_PX / HANDHELD_STRIP_HEIGHT_CSS_PX,
      // Android Color.parseColor uses #AARRGGBB: opaque #1A1A1A must carry FF alpha.
      color: '#FF1A1A1A',
    },
  } as const;
}

/** 服务端 prompt 强制的兜底开头。前端把它从正文剥掉，改用角标表达。 */
const FALLBACK_PREFIX = '攻略库里没找到，下面是我网上搜到的，不保证对：';

export function stripFallbackPrefix(text: string): { body: string; fallback: boolean } {
  const t = text.trimStart();
  if (t.startsWith(FALLBACK_PREFIX)) {
    return { body: t.slice(FALLBACK_PREFIX.length).trimStart(), fallback: true };
  }
  return { body: text, fallback: false };
}

export function handheldStripControlsForState(): StripControl[] {
  return [
    { kind: 'chat', label: 'AI聊天', icon: HANDHELD_FIGMA_ASSETS.stripAiChat },
    { kind: 'settings', label: '设置', icon: HANDHELD_FIGMA_ASSETS.stripSettings },
    { kind: 'exitGame', label: '退出游戏', icon: HANDHELD_FIGMA_ASSETS.stripExitGame },
  ];
}

export function handheldStripTouchAction(state: StrategistState): StripTouchAction {
  if (state.kind === 'listening') {
    return {
      label: '按住说话...',
      mode: 'waveform',
      waveform: HANDHELD_FIGMA_ASSETS.voiceWaveform,
    };
  }
  return { label: '按住说话...', mode: 'label' };
}

function answerTextOf(state: StrategistState): string {
  return state.kind === 'answering' || state.kind === 'done' ? state.text : '';
}

export function statusBubblesForState(state: StrategistState): StripBubble[] {
  const transcript = 'transcript' in state ? state.transcript : undefined;
  const rawAnswer = answerTextOf(state);
  const bubbles: StripBubble[] = [];

  if (transcript) bubbles.push({ role: 'user', text: transcript });
  if (rawAnswer) {
    const { body, fallback } = stripFallbackPrefix(rawAnswer);
    bubbles.push({ role: 'assistant', text: body, fallback });
    return bubbles;
  }

  const status = statusTextFor(state);
  if (status) bubbles.push({ role: 'assistant', text: status, fallback: false });
  return bubbles;
}
