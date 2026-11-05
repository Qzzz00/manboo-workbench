/**
 * 登录流程的纯函数(2026-09-17「手机上也需要有登录」)。
 * 没有账号体系,登录 = 确认电脑端就绪 → 配对 → 引导;这里只钉住那几句话与「电脑」那盏灯。
 */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_OFFLINE_BANNER,
  desktopStatusText,
  foundDesktopLine,
  loggedInLine,
  REVOKED_NOTICE,
  SIGNED_OUT_NOTICE,
  workbenchLabel,
} from '../src/login/loginModel';

describe('登录 · 电脑状态灯', () => {
  it('未配对:还在找 / 找到了 / 没找到', () => {
    expect(desktopStatusText({ kind: 'searching' })).toBe('电脑:还在找…');
    expect(desktopStatusText({ kind: 'found' })).toBe('电脑:找到了');
    expect(desktopStatusText({ kind: 'missing' })).toBe('电脑:没找到');
  });

  it('已配对:直连 / 远程各说各的', () => {
    expect(desktopStatusText({ kind: 'linked', mode: 'direct', connected: true })).toBe('电脑:已连接(直连)');
    expect(desktopStatusText({ kind: 'linked', mode: 'remote', connected: true })).toBe('电脑:已连接(远程)');
  });

  it('已配对但电脑关机:说不在线,不说没登录', () => {
    expect(desktopStatusText({ kind: 'linked', mode: 'direct', connected: false })).toBe('电脑:不在线');
    expect(desktopStatusText({ kind: 'linked', mode: 'offline', connected: false })).toBe('电脑:不在线');
    // 顶部横幅用的是同一句话的短版。
    expect(DESKTOP_OFFLINE_BANNER).toBe('电脑不在线');
  });
});

describe('登录 · 工作台叫什么', () => {
  it('优先用 /state 里的名字(Mac 侧以后补),其次用配对时记下的,最后退回地址', () => {
    expect(workbenchLabel({ host: '10.0.0.9' }, { workbench: { name: '工作台 · air' } })).toBe('工作台 · air');
    expect(workbenchLabel({ host: '10.0.0.9', workbenchName: '工作台 · mini' })).toBe('工作台 · mini');
    expect(workbenchLabel({ host: '10.0.0.9' })).toBe('工作台 · 10.0.0.9');
  });

  it('空字符串不算名字', () => {
    expect(workbenchLabel({ host: '10.0.0.9', workbenchName: '  ' }, { workbench: { name: '' } })).toBe('工作台 · 10.0.0.9');
  });

  it('已登录那一行', () => {
    expect(loggedInLine('工作台 · air')).toBe('已登录:工作台 · air');
  });
});

describe('登录 · 几句人话', () => {
  it('找到电脑之后那一句带名字,并告诉他下一步去电脑上做什么', () => {
    expect(foundDesktopLine('工作台 · air')).toBe('找到「工作台 · air」,去电脑上生成配对码');
  });

  it('退出登录与令牌被撤销说的不是一句话,都不是报错码', () => {
    expect(SIGNED_OUT_NOTICE).toContain('退出登录');
    expect(REVOKED_NOTICE).toContain('重新');
    expect(SIGNED_OUT_NOTICE).not.toBe(REVOKED_NOTICE);
    expect(REVOKED_NOTICE).not.toMatch(/401/);
  });

  it('电脑端获取地址是个可配常量,现在指着仓库说明', () => {
    expect(DESKTOP_DOWNLOAD_URL).toMatch(/^https:\/\//);
    expect(DESKTOP_DOWNLOAD_URL).toContain('github.com');
  });
});
