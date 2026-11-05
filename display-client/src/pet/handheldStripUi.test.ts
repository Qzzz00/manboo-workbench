import { describe, expect, it } from 'vitest';

import type { StrategistState } from './strategistSession.ts';
import {
  handheldStripControlsForState,
  handheldStripTouchAction,
  statusBubblesForState,
} from './handheldStripUi.ts';
import * as handheldStripUi from './handheldStripUi.ts';

const handheldStripLayerLayout = (
  handheldStripUi as typeof handheldStripUi & {
    handheldStripLayerLayout?: () => {
      modelTopPx: number;
      silhouetteBottomPx: number;
      statusbarHeightPx: number;
      rightPanelBottomInsetPx: number;
      layers: {
        statusbar: number;
        model: number;
        controls: number;
      };
      nativeBottomBar: {
        heightFraction: number;
        color: string;
      };
    };
  }
).handheldStripLayerLayout;

describe('handheldStripControlsForState', () => {
  it('默认游戏中底条显示 Figma 三个真实控制按钮', () => {
    expect(handheldStripControlsForState()).toEqual([
      { kind: 'chat', label: 'AI聊天', icon: './handheld/figma/strip-ai-chat.svg' },
      { kind: 'settings', label: '设置', icon: './handheld/figma/strip-settings.svg' },
      { kind: 'exitGame', label: '退出游戏', icon: './handheld/figma/strip-exit-game.svg' },
    ]);
  });

  it('按住说话时 PTT 切成波形，不再显示普通文字', () => {
    expect(handheldStripTouchAction({ kind: 'listening' })).toEqual({
      label: '按住说话...',
      mode: 'waveform',
      waveform: './handheld/figma/voice-waveform.png',
    });
  });
});

describe('handheldStripLayerLayout', () => {
  it('keeps model geometry unchanged and uses an opaque #1A1A1A bar below model and controls', () => {
    expect(handheldStripLayerLayout?.()).toEqual({
      modelTopPx: 0,
      silhouetteBottomPx: 0,
      statusbarHeightPx: 32,
      rightPanelBottomInsetPx: 32,
      layers: {
        statusbar: 1,
        model: 2,
        controls: 3,
      },
      nativeBottomBar: {
        heightFraction: 0.2,
        color: '#FF1A1A1A',
      },
    });
  });
});

describe('statusBubblesForState', () => {
  it('把一次真实问答映射成右侧聊天气泡：用户问题在右、AI 回答在左', () => {
    const state: StrategistState = {
      kind: 'done',
      transcript: '这里该往哪走？',
      text: '先回到左边门口，再沿着绿色地砖往上走。',
    };

    expect(statusBubblesForState(state)).toEqual([
      { role: 'user', text: '这里该往哪走？' },
      { role: 'assistant', text: '先回到左边门口，再沿着绿色地砖往上走。', fallback: false },
    ]);
  });

  it('待命态没有历史内容时只给一条 AI 状态气泡', () => {
    expect(statusBubblesForState({ kind: 'greeting' })).toEqual([
      { role: 'assistant', text: '怎么啦，需要我帮忙吗？（按住我说话）', fallback: false },
    ]);
  });
});
