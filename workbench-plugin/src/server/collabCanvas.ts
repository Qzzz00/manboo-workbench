/**
 * **板的布局文件:`<工作目录>/协作区/板.canvas`**(2026-10-21 协作区,设计稿第四节第 9 条)。
 *
 * 格式是 JSON Canvas(Obsidian 开出来的开放格式,MIT;节点 / 连线 / 分组三样):目标 = `group` 节点,
 * 便签 = `text` 节点(`text` 写标题,Obsidian 直接打开也看得懂);我们自己的那一格放在节点的扩展键 `wb` 下。
 *
 * **只存位置与分组,内容以任务账为真**:标题每次写盘时从账上现抄(只为 Obsidian 好看),读回来只认坐标。
 * 这个文件丢了能从账重排(界面按创建先后自动摆,见 `client/collab/collabLayout.ts`)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface GoalBox { x: number, y: number, w: number, h: number }
export interface NotePos { x: number, y: number }

/** 板上的摆法:哪个目标区在哪、多大,哪张便签在哪。 */
export interface BoardLayout {
  goals: Record<string, GoalBox>
  notes: Record<string, NotePos>
}

export interface CanvasNode {
  id: string
  type: 'group' | 'text'
  x: number
  y: number
  width: number
  height: number
  label?: string
  text?: string
  wb?: { kind: 'goal' | 'note' }
}

export interface CanvasFile {
  nodes: CanvasNode[]
  edges: never[]
}

/** 便签节点在文件里写多大(只给 Obsidian 看;板上的便签大小由界面定)。 */
const NOTE_W = 220
const NOTE_H = 96

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function canvasFileOf(
  layout: BoardLayout,
  titles: { goals: readonly { id: string, title: string }[], notes: readonly { id: string, title: string }[] },
): CanvasFile {
  const goalTitle = new Map(titles.goals.map(one => [one.id, one.title]))
  const noteTitle = new Map(titles.notes.map(one => [one.id, one.title]))
  const nodes: CanvasNode[] = []
  for (const [id, box] of Object.entries(layout.goals)) {
    nodes.push({ id, type: 'group', x: box.x, y: box.y, width: box.w, height: box.h, label: goalTitle.get(id) ?? id, wb: { kind: 'goal' } })
  }
  for (const [id, pos] of Object.entries(layout.notes)) {
    nodes.push({ id, type: 'text', x: pos.x, y: pos.y, width: NOTE_W, height: NOTE_H, text: noteTitle.get(id) ?? id, wb: { kind: 'note' } })
  }
  return { nodes, edges: [] }
}

/** 文件 → 摆法。只认数字坐标;认不出的节点挑掉(一个坏节点不连累整张板)。 */
export function layoutOfCanvas(file: unknown): BoardLayout {
  const layout: BoardLayout = { goals: {}, notes: {} }
  if (typeof file !== 'object' || file === null) return layout
  const nodes = (file as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return layout
  for (const one of nodes) {
    if (typeof one !== 'object' || one === null) continue
    const raw = one as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id === '' || !num(raw.x) || !num(raw.y)) continue
    if (raw.type === 'group' && num(raw.width) && num(raw.height)) layout.goals[raw.id] = { x: raw.x, y: raw.y, w: raw.width, h: raw.height }
    else if (raw.type === 'text') layout.notes[raw.id] = { x: raw.x, y: raw.y }
  }
  return layout
}

/** 界面发上来的摆法过一道体检(同样只认数字)。 */
export function parseLayout(value: unknown): BoardLayout {
  const layout: BoardLayout = { goals: {}, notes: {} }
  if (typeof value !== 'object' || value === null) return layout
  const raw = value as Record<string, unknown>
  for (const [id, one] of Object.entries(typeof raw.goals === 'object' && raw.goals !== null ? raw.goals as Record<string, unknown> : {})) {
    const box = one as Record<string, unknown> | null
    if (box !== null && typeof box === 'object' && num(box.x) && num(box.y) && num(box.w) && num(box.h) && box.w > 0 && box.h > 0) {
      layout.goals[id] = { x: box.x, y: box.y, w: box.w, h: box.h }
    }
  }
  for (const [id, one] of Object.entries(typeof raw.notes === 'object' && raw.notes !== null ? raw.notes as Record<string, unknown> : {})) {
    const pos = one as Record<string, unknown> | null
    if (pos !== null && typeof pos === 'object' && num(pos.x) && num(pos.y)) layout.notes[id] = { x: pos.x, y: pos.y }
  }
  return layout
}

/** 读盘:没有文件 / 读坏了都是空摆法(界面自动重排),不抛。 */
export async function readBoardLayout(file: string): Promise<BoardLayout> {
  try { return layoutOfCanvas(JSON.parse(await readFile(file, 'utf8'))) }
  catch { return { goals: {}, notes: {} } }
}

export async function writeBoardLayout(file: string, canvas: CanvasFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(canvas, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 板的文件在哪:`<工作目录>/协作区/板.canvas`。 */
export function boardCanvasFile(workdir: string): string {
  return `${workdir.replace(/\/+$/, '')}/协作区/板.canvas`
}
