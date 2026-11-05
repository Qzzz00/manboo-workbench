/**
 * ★ **展示台 ↔ 手机壳那一条 postMessage 的类型字不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 同一件事「壳 → iframe 这条消息的 type 信封」两份 —— 基准在展示台
 * `display-client/src/display/hostFeed.ts` 的 `HOST_MESSAGE_TYPE`,抄本在手机壳
 * `butler-app/src/display/displayUrl.ts` 的 `HOST_MESSAGE_TYPE`(注释「与
 * display-client/src/display/hostFeed.ts 的 HOST_MESSAGE_TYPE 同一个字」)。
 * 拼错一个字,壳递进来的状态展示台一条都认不得 —— 这一条守的就是那个字。
 *
 * 直接读展示台源码取字面量比对(顶层子目录互不 import,只能读文本;范本
 * `butler-app/tests/remoteParity.test.ts`)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_MESSAGE_TYPE } from '../src/display/displayUrl';

const DISPLAY_HOST_FEED = resolve(__dirname, '../../display-client/src/display/hostFeed.ts');

describe('★ HOST_MESSAGE_TYPE:展示台那份是基准,手机壳这份同一个字', () => {
  it('读得到展示台那一份(扫描本身没坏)', () => {
    const source = readFileSync(DISPLAY_HOST_FEED, 'utf8');
    const hit = source.match(/export const HOST_MESSAGE_TYPE = '([^']+)'/);
    expect(hit, '展示台 hostFeed.ts 里找不到 `HOST_MESSAGE_TYPE = …` —— 它改名了?这一条要跟着改').not.toBeNull();
    expect(hit?.[1]).toBe('butler-display');
  });

  it('★ 手机壳 HOST_MESSAGE_TYPE 与展示台那份同一个字(漂了就把两边收成一样)', () => {
    const source = readFileSync(DISPLAY_HOST_FEED, 'utf8');
    const hit = source.match(/export const HOST_MESSAGE_TYPE = '([^']+)'/);
    expect(hit?.[1]).toBe(HOST_MESSAGE_TYPE);
  });
});
