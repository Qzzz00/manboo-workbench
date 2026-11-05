import { describe, expect, it } from 'vitest';
import { initialPairing, reducePairing, type DiscoveredWorkbench } from '../src/pairing/pairingMachine';

const wb: DiscoveredWorkbench = { name: '工作台 · Bens-Mac', host: '10.0.0.2', port: 8791 };

describe('配对状态机', () => {
  it('初始在首屏(discovering),列表为空', () => {
    expect(initialPairing()).toEqual({ phase: 'discovering', found: [] });
  });

  it('发现一台就列出来;同一台(host:port)重复上报不重复列', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'discovered', workbench: { ...wb, name: '改名了' } });
    expect(s.phase).toBe('discovering');
    expect(s.found).toHaveLength(1);
    expect(s.found[0].name).toBe('改名了');
  });

  it('发现超时且一台都没有 → 仍留在首屏(扫码为主,不弹说明、不跳手输)', () => {
    const s = reducePairing(initialPairing(), { type: 'discovery_done' });
    expect(s).toEqual({ phase: 'discovering', found: [], done: true });
  });

  it('发现超时但已有结果 → 停留在首屏(done 态),列表还在', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'discovery_done' });
    expect(s).toEqual({ phase: 'discovering', found: [wb], done: true });
  });

  it('mDNS 不可用(网页 / 插件报错)→ 仍留在首屏,扫码照常', () => {
    const s = reducePairing(initialPairing(), { type: 'discovery_unavailable' });
    expect(s).toEqual({ phase: 'discovering', found: [], done: true });
  });

  it('扫码中 / 输码页收到发现结果也记进列表,阶段不变', () => {
    const scanning = reducePairing(initialPairing(), { type: 'scan_start' });
    const s = reducePairing(scanning, { type: 'discovered', workbench: wb });
    expect(s.phase).toBe('scanning');
    expect(s.found).toEqual([wb]);
    expect(reducePairing(s, { type: 'discovery_done' })).toBe(s);
  });

  it('首屏点「扫码配对」→ scanning;取消 → 回首屏,列表保留', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'scan_start' });
    expect(s).toEqual({ phase: 'scanning', found: [wb] });
    expect(reducePairing(s, { type: 'scan_cancel' })).toEqual({ phase: 'discovering', found: [wb], done: true });
  });

  it('相机权限被拒 / 打不开 → 留在扫码屏并带原因(同屏给手输路径)', () => {
    const s = reducePairing(reducePairing(initialPairing(), { type: 'scan_start' }), { type: 'scan_failed', error: '需要相机权限才能扫码' });
    expect(s).toEqual({ phase: 'scanning', found: [], error: '需要相机权限才能扫码' });
    // 不在扫码屏时的 scan_failed 不理会
    expect(reducePairing(initialPairing(), { type: 'scan_failed', error: 'x' })).toEqual(initialPairing());
  });

  it('扫码屏上点局域网里找到的那台 → 输码页;点手输地址 → manual', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'scan_start' });
    s = reducePairing(s, { type: 'scan_failed', error: '打不开相机' });
    expect(reducePairing(s, { type: 'pick', target: { host: wb.host, port: wb.port } }))
      .toEqual({ phase: 'code', found: [wb], target: { host: '10.0.0.2', port: 8791 } });
    expect(reducePairing(s, { type: 'manual' })).toEqual({ phase: 'manual', found: [wb] });
  });

  it('选中一台 → 输码页,带着目标', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'pick', target: { host: wb.host, port: wb.port } });
    expect(s).toEqual({ phase: 'code', found: [wb], target: { host: '10.0.0.2', port: 8791 } });
  });

  it('扫码 / 深链带了 code → 直接进 claiming;只带地址 → 输码页', () => {
    const scanning = reducePairing(initialPairing(), { type: 'scan_start' });
    const withCode = reducePairing(scanning, { type: 'scanned', target: { host: '1.2.3.4', port: 8791, code: '123456' } });
    expect(withCode).toEqual({ phase: 'claiming', found: [], target: { host: '1.2.3.4', port: 8791 }, code: '123456' });
    const noCode = reducePairing(scanning, { type: 'scanned', target: { host: '1.2.3.4', port: 8791 } });
    expect(noCode.phase).toBe('code');
    // 深链不经过 scanning 也一样
    expect(reducePairing(initialPairing(), { type: 'scanned', target: { host: '1.2.3.4', port: 8791, code: '123456' } }).phase).toBe('claiming');
  });

  it('输码页提交 6 位码 → claiming;不是 6 位 → 留在原地并提示', () => {
    const base = reducePairing(initialPairing(), { type: 'pick', target: { host: 'h', port: 1 } });
    const bad = reducePairing(base, { type: 'submit', code: '12' });
    expect(bad.phase).toBe('code');
    if (bad.phase === 'code') expect(bad.error).toBe('配对码是 6 位数字');
    const good = reducePairing(base, { type: 'submit', code: ' 123456 ' });
    expect(good).toEqual({ phase: 'claiming', found: [], target: { host: 'h', port: 1 }, code: '123456' });
  });

  it('claim 成功 → paired;失败 → 回输码页并原样带服务端的话(含锁定时刻)', () => {
    const claiming = reducePairing(initialPairing(), { type: 'scanned', target: { host: 'h', port: 1, code: '123456' } });
    const pairing = { token: 't', host: 'h', port: 1, deviceId: 'd' };
    expect(reducePairing(claiming, { type: 'claim_ok', pairing })).toEqual({ phase: 'paired', found: [], pairing });
    const failed = reducePairing(claiming, { type: 'claim_failed', error: '配对码不对或已失效', lockedUntil: '2026-09-14T08:00:00Z' });
    expect(failed).toEqual({ phase: 'code', found: [], target: { host: 'h', port: 1 }, error: '配对码不对或已失效', lockedUntil: '2026-09-14T08:00:00Z' });
  });

  it('手输页填地址 → 输码页;地址不合法 → 提示', () => {
    const manual = reducePairing(initialPairing(), { type: 'manual' });
    const bad = reducePairing(manual, { type: 'manual_target', raw: '' });
    expect(bad.phase).toBe('manual');
    if (bad.phase === 'manual') expect(bad.error).toBe('请填工作台的局域网地址,如 192.168.1.8:8791');
    const good = reducePairing(manual, { type: 'manual_target', raw: '192.168.1.8' });
    expect(good).toEqual({ phase: 'code', found: [], target: { host: '192.168.1.8', port: 8791 } });
  });

  it('输码页 / 手输页 / 扫码屏都能「重新扫码」(scan_start),列表保留', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    const code = reducePairing(s, { type: 'pick', target: { host: wb.host, port: wb.port } });
    expect(reducePairing(code, { type: 'scan_start' })).toEqual({ phase: 'scanning', found: [wb] });
    const manual = reducePairing(s, { type: 'manual' });
    expect(reducePairing(manual, { type: 'scan_start' })).toEqual({ phase: 'scanning', found: [wb] });
  });

  it('任何页都能「重新找」回到首屏,列表清空', () => {
    const manual = reducePairing(initialPairing(), { type: 'manual' });
    expect(reducePairing(manual, { type: 'rediscover' })).toEqual({ phase: 'discovering', found: [] });
  });

  it('输码页「返回」:有列表回首屏,没列表回手输;手输页「返回」回首屏', () => {
    let s = reducePairing(initialPairing(), { type: 'discovered', workbench: wb });
    s = reducePairing(s, { type: 'pick', target: { host: wb.host, port: wb.port } });
    const back = reducePairing(s, { type: 'back' });
    expect(back).toEqual({ phase: 'discovering', found: [wb], done: true });
    const fromManual = reducePairing(reducePairing(initialPairing(), { type: 'manual' }), { type: 'pick', target: { host: 'h', port: 1 } });
    expect(reducePairing(fromManual, { type: 'back' })).toEqual({ phase: 'manual', found: [] });
    expect(reducePairing(reducePairing(initialPairing(), { type: 'manual' }), { type: 'back' })).toEqual({ phase: 'discovering', found: [], done: true });
  });
});
