import { describe, expect, it } from 'vitest';
import { parsePairUrl, isSixDigitCode, normalizeHostPort } from '../src/pairing/pairUrl';

describe('parsePairUrl:二维码 / 深链 workbench://pair?host=&port=&code=', () => {
  it('完整三项都在时解析出 host / port / code', () => {
    expect(parsePairUrl('workbench://pair?host=10.86.37.27&port=8791&code=123456')).toEqual({
      host: '10.86.37.27', port: 8791, code: '123456',
    });
  });
  it('port 缺省为 8791,code 可以没有(只带地址,让用户再输码)', () => {
    expect(parsePairUrl('workbench://pair?host=192.168.1.5')).toEqual({ host: '192.168.1.5', port: 8791 });
  });
  it('不是 workbench://pair 的一律 null,不猜', () => {
    expect(parsePairUrl('https://example.com/?host=1.2.3.4&code=123456')).toBeNull();
    expect(parsePairUrl('workbench://other?host=1.2.3.4')).toBeNull();
    expect(parsePairUrl('')).toBeNull();
    expect(parsePairUrl('乱码')).toBeNull();
  });
  it('host 为空、port 不是数字 → null', () => {
    expect(parsePairUrl('workbench://pair?port=8791&code=123456')).toBeNull();
    expect(parsePairUrl('workbench://pair?host=1.2.3.4&port=abc')).toBeNull();
  });
  it('code 不是 6 位数字时丢掉 code、保留地址', () => {
    expect(parsePairUrl('workbench://pair?host=1.2.3.4&code=12')).toEqual({ host: '1.2.3.4', port: 8791 });
  });
});

describe('isSixDigitCode', () => {
  it('只认 6 位数字,前后空白容忍', () => {
    expect(isSixDigitCode('123456')).toBe(true);
    expect(isSixDigitCode(' 123456 ')).toBe(true);
    expect(isSixDigitCode('12345')).toBe(false);
    expect(isSixDigitCode('1234567')).toBe(false);
    expect(isSixDigitCode('12345a')).toBe(false);
  });
});

describe('normalizeHostPort:手输地址', () => {
  it('接受 host、host:port、http://host:port/', () => {
    expect(normalizeHostPort('10.0.0.2')).toEqual({ host: '10.0.0.2', port: 8791 });
    expect(normalizeHostPort('10.0.0.2:8799')).toEqual({ host: '10.0.0.2', port: 8799 });
    expect(normalizeHostPort('http://mac.local:8791/')).toEqual({ host: 'mac.local', port: 8791 });
  });
  it('空的或端口非法 → null', () => {
    expect(normalizeHostPort('')).toBeNull();
    expect(normalizeHostPort('10.0.0.2:99999')).toBeNull();
  });
});
