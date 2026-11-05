import { describe, expect, it } from 'vitest';
import { VAD_DEFAULTS, resolveVadConfig } from './vadConfig';

describe('resolveVadConfig', () => {
  it('returns defaults for empty / no relevant params', () => {
    expect(resolveVadConfig('')).toEqual(VAD_DEFAULTS);
    expect(resolveVadConfig('?server=http://x&foo=1')).toEqual(VAD_DEFAULTS);
  });

  it('overrides individual fields from URL params', () => {
    const c = resolveVadConfig('?vad=0.05&silence=1000');
    expect(c.startRms).toBe(0.05);
    expect(c.silenceMs).toBe(1000);
    // untouched fields keep defaults
    expect(c.stopRms).toBe(VAD_DEFAULTS.stopRms);
    expect(c.maxUtterMs).toBe(VAD_DEFAULTS.maxUtterMs);
  });

  it('maps every knob', () => {
    const c = resolveVadConfig('?vad=0.06&vadstop=0.03&frames=5&silence=600&minutter=200&maxutter=8000');
    expect(c).toEqual({
      startRms: 0.06,
      stopRms: 0.03,
      startFrames: 5,
      silenceMs: 600,
      minUtterMs: 200,
      maxUtterMs: 8000,
    });
  });

  it('tolerates a leading "?" or none', () => {
    expect(resolveVadConfig('vad=0.05').startRms).toBe(0.05);
    expect(resolveVadConfig('?vad=0.05').startRms).toBe(0.05);
  });

  it('rejects out-of-range / non-numeric values, falling back per-field', () => {
    expect(resolveVadConfig('?vad=abc').startRms).toBe(VAD_DEFAULTS.startRms);
    expect(resolveVadConfig('?vad=0').startRms).toBe(VAD_DEFAULTS.startRms); // must be >0
    expect(resolveVadConfig('?vad=2').startRms).toBe(VAD_DEFAULTS.startRms); // rms>1 impossible
    expect(resolveVadConfig('?vad=-0.1').startRms).toBe(VAD_DEFAULTS.startRms);
    expect(resolveVadConfig('?silence=50').silenceMs).toBe(VAD_DEFAULTS.silenceMs); // too short
    expect(resolveVadConfig('?silence=999999').silenceMs).toBe(VAD_DEFAULTS.silenceMs); // too long
    expect(resolveVadConfig('?frames=0').startFrames).toBe(VAD_DEFAULTS.startFrames);
    expect(resolveVadConfig('?frames=2.7').startFrames).toBe(2); // integer floor of in-range value
  });
});
