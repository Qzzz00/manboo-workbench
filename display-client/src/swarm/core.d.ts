export type Tuning = Record<string, number>
export interface TuningField { key: string; group: string; label: string; value: number; min: number; max: number; step: number; unit: string }
export interface TuningPreset { kind: 'butler-swarm-v4'; version: 1; settings: Tuning; svg: string; fill: boolean }
export interface Glyph extends Float32Array { ranges?: { start: number; count: number; closed: boolean }[]; scatter?: boolean; solid?: unknown }
export interface Sample { glyph: Glyph; svg: string; warnings: string[] }
export interface BuiltinIcon { id: string; label: string; category: string; tags: readonly string[]; style: 'filled' | 'outline'; svg: string }
export const TUNING_FIELDS: readonly TuningField[]
export const TUNING_DEFAULTS: Readonly<Tuning>
export const TUNING_STORAGE_KEY: string
export function normalizeTuning(input?: Tuning, base?: Tuning): Tuning
export function parseTuningPreset(text: string): TuningPreset
export function readTuningPreset(): TuningPreset | null
export function sanitizeParticleSVG(text: string): string
export function sampleImportedSVG(text: string, options?: { fill?: boolean }): Promise<Sample>
export function listBuiltinIcons(query?: string, category?: string): readonly Pick<BuiltinIcon, 'id' | 'label' | 'category' | 'tags'>[]
export function getBuiltinIcon(id: string): BuiltinIcon | null
export class BuiltinGlyphCache { constructor(limit?: number); readonly size: number; get(id: string): Promise<Sample> }
export class SwarmV4 {
  constructor(count?: number, glyphs?: Record<string, Glyph>)
  glyphs: Record<string, Glyph>; mode: string; activeIcon: Glyph | null
  configure(settings: Tuning): void
  setMode(mode: string): void
  step(dt: number, snap?: boolean): void
}
export class LightCloud {
  canvas: HTMLCanvasElement; gl: WebGLRenderingContext | null; kind: 'webgl' | 'canvas'; readonly size: number
  setResolution(size: number): void
  paint(time: number, work: number, rgb: number[], settings?: Tuning, activity?: number): HTMLCanvasElement
}
export class SwarmRenderer {
  constructor(canvas: HTMLCanvasElement, swarm: SwarmV4)
  setColor(theme: 'dark' | 'light', notice: string): void
  resize(): void
  paint(dt?: number, snap?: boolean): void
  cloud: LightCloud
  /** Device pixel ratio captured at the last resize, capped at 2. */
  readonly dpr: number
  /** Quality tier hook: multiplies the light texture resolution (1 full, .5 halved). */
  cloudScale: number
}
export function alignSquare(px: number, py: number, size: number, dpr: number): { x: number; y: number; size: number; coverage: number }
export function cloudResolutionFor(deviceDiameter: number, scale?: number): number
