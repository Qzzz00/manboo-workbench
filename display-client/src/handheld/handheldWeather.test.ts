import { describe, it, expect } from 'vitest';
import { parseIpApi, parseIpWhois, parseOpenMeteo } from './handheldWeather.ts';

describe('parseIpApi', () => {
  it('成功响应 → 中文城市 + 坐标（真机实测形状）', () => {
    expect(parseIpApi({ status: 'success', regionName: '广东', city: '深圳', lat: 22.5455, lon: 114.0683 })).toEqual({
      lat: 22.5455,
      lon: 114.0683,
      city: '深圳',
    });
  });

  it('无 city 时回落 regionName', () => {
    expect(parseIpApi({ status: 'success', regionName: '广东', lat: 1, lon: 2 })?.city).toBe('广东');
  });

  it('status 非 success / 缺坐标 → null', () => {
    expect(parseIpApi({ status: 'fail' })).toBeNull();
    expect(parseIpApi({ status: 'success', city: '深圳' })).toBeNull();
    expect(parseIpApi(null)).toBeNull();
  });
});

describe('parseIpWhois', () => {
  it('成功响应 → 坐标 + 城市（真机实测形状）', () => {
    expect(parseIpWhois({ success: true, city: 'Shenzhen', latitude: 22.5455, longitude: 114.0683 })).toEqual({
      lat: 22.5455,
      lon: 114.0683,
      city: 'Shenzhen',
    });
  });

  it('success!=true / 缺坐标 → null', () => {
    expect(parseIpWhois({ success: false })).toBeNull();
    expect(parseIpWhois({ success: true, city: 'X' })).toBeNull();
  });
});

describe('parseOpenMeteo', () => {
  it('current → 温度取整 + 中文状况 + emoji', () => {
    expect(parseOpenMeteo({ current: { temperature_2m: 26.7, weather_code: 51 } }, '深圳')).toEqual({
      tempC: 27,
      condition: '小毛毛雨',
      icon: '🌦️',
      city: '深圳',
    });
  });

  it('温度缺失 → tempC=null 但仍出状况', () => {
    const w = parseOpenMeteo({ current: { weather_code: 0 } }, '深圳');
    expect(w?.tempC).toBeNull();
    expect(w?.condition).toBe('晴');
  });

  it('无 current → null', () => {
    expect(parseOpenMeteo({}, '深圳')).toBeNull();
  });
});
