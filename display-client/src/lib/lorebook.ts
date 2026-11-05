import type { ManifestLorebook, ManifestLorebookEntry } from '../features/live2d/types.ts';

export function effectiveScanDepth(
  entry: { scan_depth?: number },
  manifest: { default_scan_depth: number },
): number {
  return entry.scan_depth ?? manifest.default_scan_depth;
}

export function estimateTokens(text: string): number {
  // TODO: 替换为真正的 token 估算工具
  return Math.ceil(text.length / 2.5);
}

export type MessageLike = { role: 'user' | 'assistant'; content: string };

export function selectLorebookEntries(
  manifest: { lorebook?: ManifestLorebook },
  recentMessages: MessageLike[],
): { before_char: string[]; after_char: string[] } {
  const cfg = manifest.lorebook;
  if (!cfg?.enabled) return { before_char: [], after_char: [] };

  const candidates: ManifestLorebookEntry[] = [];
  for (const e of cfg.entries) {
    if (e.constant) {
      candidates.push(e);
      continue;
    }
    const depth = effectiveScanDepth(e, cfg);
    const window = recentMessages.slice(-depth);
    const text = window.map((m) => m.content).join('\n').toLowerCase();
    if (e.keys.some((k) => text.includes(k.toLowerCase()))) {
      candidates.push(e);
    }
  }

  candidates.sort((a, b) =>
    b.priority - a.priority || a.insertion_order - b.insertion_order
  );

  const picked: ManifestLorebookEntry[] = [];
  let tokens = 0;
  for (const c of candidates) {
    const t = estimateTokens(c.content);
    if (tokens + t > cfg.token_budget) continue;
    picked.push(c);
    tokens += t;
  }

  return {
    before_char: picked.filter((p) => p.position === 'before_char').map((p) => p.content),
    after_char: picked.filter((p) => p.position === 'after_char').map((p) => p.content),
  };
}
