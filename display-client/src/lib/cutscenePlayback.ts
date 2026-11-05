// 竖向动态条漫（webtoon）播放的纯核心逻辑。
// 副作用（TTS / 自动滚动 / 计时器 / DOM）留在 CutsceneScene.tsx，本文件只做可单测的纯计算。

export type PanelAspect = 'wide' | 'tall' | 'square' | 'splash';
export type PanelReveal = 'fade' | 'slide-up';

export interface CutsceneDialogue {
  text: string;
  speaker?: string;
  bubble_pos?: string;
}

export interface CutscenePanel {
  panel_index: number;
  image_url: string;
  aspect: PanelAspect;
  reveal: PanelReveal;
  narration: string;
  dialogue: CutsceneDialogue[];
  emotion?: string;
  bgm_cue?: string;
  sfx_cue?: string;
  appearance_change?: Record<string, unknown>;
}

const ASPECTS: PanelAspect[] = ['wide', 'tall', 'square', 'splash'];
const DEFAULT_ASPECT: PanelAspect = 'wide';

// 把烤制产出的（可能不完整/脏）storyboard 归一成稳定的格子数组，供组件安全渲染。
export function normalizeStoryboard(raw: unknown): CutscenePanel[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => {
    const panel = (p ?? {}) as Record<string, unknown>;
    const aspect = ASPECTS.includes(panel.aspect as PanelAspect) ? (panel.aspect as PanelAspect) : DEFAULT_ASPECT;
    const dialogueRaw = Array.isArray(panel.dialogue) ? panel.dialogue : [];
    const dialogue: CutsceneDialogue[] = dialogueRaw
      .filter((d): d is Record<string, unknown> => Boolean(d) && typeof (d as Record<string, unknown>).text === 'string')
      .map((d) => ({ text: String(d.text), speaker: d.speaker as string | undefined, bubble_pos: d.bubble_pos as string | undefined }));
    return {
      panel_index: typeof panel.panel_index === 'number' ? panel.panel_index : i,
      image_url: typeof panel.image_url === 'string' ? panel.image_url : '',
      aspect,
      reveal: panel.reveal === 'fade' ? 'fade' : 'slide-up',
      narration: typeof panel.narration === 'string' ? panel.narration : '',
      dialogue,
      emotion: panel.emotion as string | undefined,
      bgm_cue: panel.bgm_cue as string | undefined,
      sfx_cue: panel.sfx_cue as string | undefined,
      appearance_change: (panel.appearance_change as Record<string, unknown> | undefined) ?? undefined,
    };
  });
}

interface DurationOpts {
  baseMs?: number;
  perCharMs?: number;
  minMs?: number;
  maxMs?: number;
}

// 一格自动停留时长：随该格文字量（旁白 + 台词）增长，让用户读得完；夹在 [min,max]。
export function panelDurationMs(panel: CutscenePanel, opts: DurationOpts = {}): number {
  const { baseMs = 1400, perCharMs = 60, minMs = 1200, maxMs = 8000 } = opts;
  const textLen = (panel.narration?.length || 0) + panel.dialogue.reduce((n, d) => n + (d.text?.length || 0), 0);
  return Math.max(minMs, Math.min(maxMs, baseMs + textLen * perCharMs));
}

export function isLastPanel(index: number, total: number): boolean {
  return index >= total - 1;
}
