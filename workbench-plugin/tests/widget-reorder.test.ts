import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { reorderWidget as reorder } from '../src/client/layout.ts'
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fixture = (): WorkbenchLayout => ({
  pureMode: false, butler: { corner: 'br', min: false },
  modules: [
    { id: 'slot', order: 0, row: 0, col: 0, basis_pct: 40, width_pct: 100 },
    { id: 'today', order: 1, row: 1, col: 0, basis_pct: 30, width_pct: 50 },
    { id: 'publish', order: 2, row: 1, col: 1, basis_pct: 20, width_pct: 50 },
    { id: 'notes', order: 3, basis_pct: 10, hidden: true },
  ],
  landscape: { rail_pct: 12, modules: [
    { id: 'slot', order: 0, width_pct: 64 },
    { id: 'projects', order: 1, side_pct: 50 },
    { id: 'today', order: 2, region: 'side', side_pct: 25 },
    { id: 'publish', order: 3, region: 'side', side_pct: 25 },
    { id: 'notes', order: 4, region: 'deck', basis_pct: 24, width_pct: 20 },
    { id: 'quota', order: 5, region: 'deck', basis_pct: 24, hidden: true },
    { id: 'usage', order: 6, region: 'deck', basis_pct: 24, width_pct: 30 },
    { id: 'review', order: 7, region: 'deck', basis_pct: 24, width_pct: 50 },
  ] },
});
const ids = (layout: WorkbenchLayout, region: 'side' | 'deck') => plain(layout.landscape!.modules.filter(m => region === 'side' ? m.id === 'projects' || m.region === region : m.region === region).map(m => m.id));
function freeze<T extends object>(value: T): T { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return value; }

test('deck reorder changes persisted order, skips hidden widgets without losing them', () => {
  const layout = freeze(fixture());
  const next = reorder(layout, 'landscape', 'review', { region: 'deck', id: 'notes', after: false });
  assert.deepEqual(ids(next, 'deck'), ['review', 'notes', 'quota', 'usage']);
  assert.equal(next.landscape!.modules.find(m => m.id === 'quota')!.hidden, true);
  assert.deepEqual(next.modules, layout.modules);
  assert.equal(next.landscape!.rail_pct, 12);
  assert.deepEqual(plain(next.landscape!.modules.map(m => m.order)), [0,1,2,3,4,5,6,7]);
});
test('move from deck into side at a precise insertion position', () => {
  const next = reorder(fixture(), 'landscape', 'usage', { region: 'side', id: 'publish', after: false });
  assert.deepEqual(ids(next, 'side'), ['projects', 'today', 'usage', 'publish']);
  assert.equal(next.landscape!.modules.find(m => m.id === 'usage')!.region, 'side');
});
test('move from side into deck adopts row height and keeps width and content', () => {
  const layout = fixture();
  layout.landscape!.modules.find(m => m.id === 'today')!.basis_pct = 60;
  const next = reorder(layout, 'landscape', 'today', { region: 'deck', id: 'usage', after: true });
  assert.deepEqual(ids(next, 'deck'), ['notes', 'quota', 'usage', 'today', 'review']);
  assert.ok(next.landscape!.modules.filter(m => m.region === 'deck').every(m => m.basis_pct === 24));
});
test('side cannot insert before pinned project; pinned stage and project cannot move', () => {
  const layout = fixture();
  assert.deepEqual(ids(reorder(layout, 'landscape', 'notes', { region: 'side', id: 'projects', after: false }), 'side'), ['projects','notes','today','publish']);
  for (const id of ['slot','projects']) assert.equal(reorder(layout, 'landscape', id, { region: 'deck', id: 'notes' }), layout);
});
test('empty deck accepts a drop; empty side accepts a drop', () => {
  const layout = fixture();
  layout.landscape!.modules = layout.landscape!.modules.filter(m => !['notes','quota','usage','review'].includes(m.id));
  assert.deepEqual(ids(reorder(layout, 'landscape', 'today', { region: 'deck', id: null }), 'deck'), ['today']);
  const other = fixture();
  other.landscape!.modules = other.landscape!.modules.filter(m => !['projects','today','publish'].includes(m.id));
  assert.deepEqual(ids(reorder(other, 'landscape', 'notes', { region: 'side', id: null }), 'side'), ['notes']);
});
test('self drop, invalid target, invalid region and missing source are no-ops', () => {
  const layout = fixture();
  for (const drop of [null, {id:'notes', region:'deck'}, {id:'bad', region:'deck'}, {id:'today', region:'rail'}] as const) assert.equal(reorder(layout, 'landscape', 'notes', drop), layout);
  assert.equal(reorder(layout, 'landscape', 'no-such-widget', {region:'deck',id:'notes'}), layout);
  assert.equal(reorder(layout, 'landscape', 'notes', {region:'deck',id:'quota',after:false}), layout);
});
test('portrait moves between real row/column slots and preserves widget identity', () => {
  const layout = freeze(fixture());
  const next = plain(reorder(layout, 'portrait', 'today', {id:'publish'}));
  assert.deepEqual(next.modules.map(m => m.id), ['slot','publish','today','notes']);
  assert.deepEqual(next.modules[2], {id:'today',order:2,row:1,col:1,basis_pct:20,width_pct:50});
  assert.deepEqual(next.landscape, plain(layout.landscape));
});
test('portrait drop in an ungrouped slot removes obsolete row and column fields', () => {
  const layout = fixture();
  layout.modules[3]!.hidden = false;
  const next = reorder(layout,'portrait','today',{id:'notes'});
  const today = next.modules.find(m => m.id === 'today');
  assert.equal(today!.row, undefined);
  assert.equal(today!.col, undefined);
  assert.deepEqual(plain(reorder(next, 'portrait', 'today', {id:'notes'})), layout);
});
test('hidden widgets and invalid portrait targets cannot be moved', () => {
  const layout = fixture();
  assert.equal(reorder(layout,'portrait','notes',{id:'today'}),layout);
  assert.equal(reorder(layout,'portrait','today',{id:'notes'}),layout);
  assert.equal(reorder(layout,'portrait','today',{id:'missing'}),layout);
});
