/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { routeTouch } from './touchRouter.ts';
const base = { id: 'p1', avatarId: 'a1', content: 'hi' } as const;
const ctx = (o = {}) => ({ flagEnabled: true, currentAvatarId: 'a1', inCall: false, callEnabled: true, ...o });
const cases: Array<[string, any, any, string]> = [
  ['flag关+当前角色消息=perform(与现状一致)', { ...base, kind: 'message', tier: 'daily' }, ctx({ flagEnabled: false }), 'perform'],
  ['flag关+画外消息=silent(与现状一致)', { ...base, kind: 'message', tier: 'daily', avatarId: 'a2' }, ctx({ flagEnabled: false }), 'silent'],
  ['flag关+来电=silent(现状无来电)', { ...base, kind: 'call', tier: 'heavy' }, ctx({ flagEnabled: false }), 'silent'],
  ['silent档一律silent', { ...base, kind: 'message', tier: 'silent' }, ctx(), 'silent'],
  ['通话中一律silent(消息)', { ...base, kind: 'message', tier: 'daily' }, ctx({ inCall: true }), 'silent'],
  ['通话中的来电=report-missed', { ...base, kind: 'call', tier: 'heavy' }, ctx({ inCall: true }), 'report-missed'],
  ['当前角色daily消息=perform', { ...base, kind: 'message', tier: 'daily' }, ctx(), 'perform'],
  ['画外daily消息=banner', { ...base, kind: 'message', tier: 'daily', avatarId: 'a2' }, ctx(), 'banner'],
  ['当前角色来电=call-inplace', { ...base, kind: 'call', tier: 'heavy' }, ctx(), 'call-inplace'],
  ['画外来电=call-fullscreen', { ...base, kind: 'call', tier: 'heavy', avatarId: 'a2' }, ctx(), 'call-fullscreen'],
  ['通话功能未启用的来电=report-missed', { ...base, kind: 'call', tier: 'heavy' }, ctx({ callEnabled: false }), 'report-missed'],
  ['heavy消息按消息路由(当前=perform)', { ...base, kind: 'message', tier: 'heavy' }, ctx(), 'perform'],
  ['flag关+silent档+当前角色消息=perform(flag关完全等价现状)', { ...base, kind: 'message', tier: 'silent' }, ctx({ flagEnabled: false }), 'perform'],
];
describe('routeTouch', () => {
  for (const [name, e, c, expected] of cases) it(name, () => expect(routeTouch(e, c).type).toBe(expected));
});
