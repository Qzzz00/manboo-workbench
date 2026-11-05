import { describe, it, expect } from 'vitest';
import { encodeFrame, encodeWifiFrame, decodeStat, macToDeviceId, OP_SET_BRIGHTNESS, OP_SET_SCREEN, OP_SET_VOLUME, OP_GET_STATE } from './badgeBle.ts';

describe('encodeFrame（对拍固件真机验过的字节）', () => {
  it('SET_BRIGHTNESS 20% = A1 01 01 14', () => {
    expect(encodeFrame(OP_SET_BRIGHTNESS, 20)).toEqual([0xa1, 0x01, 0x01, 0x14]);
  });
  it('SET_SCREEN off = A1 02 01 00', () => {
    expect(encodeFrame(OP_SET_SCREEN, 0)).toEqual([0xa1, 0x02, 0x01, 0x00]);
  });
  it('SET_SCREEN on = A1 02 01 01', () => {
    expect(encodeFrame(OP_SET_SCREEN, 1)).toEqual([0xa1, 0x02, 0x01, 0x01]);
  });
  it('SET_VOLUME 80 = A1 03 01 50', () => {
    expect(encodeFrame(OP_SET_VOLUME, 80)).toEqual([0xa1, 0x03, 0x01, 0x50]);
  });
  it('GET_STATE 无 payload = A1 10 00', () => {
    expect(encodeFrame(OP_GET_STATE)).toEqual([0xa1, 0x10, 0x00]);
  });
});

describe('decodeStat（对拍真机 STAT notify）', () => {
  it('01-01-33-32-00-00-01-00-MAC → 完整对象', () => {
    const bytes = [0x01, 0x01, 0x33, 0x32, 0x00, 0x00, 0x01, 0x00, 0x28, 0x84, 0x85, 0x90, 0x60, 0x3e];
    expect(decodeStat(bytes)).toEqual({
      screenOn: true, connError: false, wifiConnected: false, brightness: 51, volume: 50,
      faceState: 0, lastStatus: 0, fwVer: 1, mac: '28:84:85:90:60:3E', battery: null,
    });
  });
  it('flags bit1=conn_err、bit0=0 灭屏', () => {
    const bytes = [0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
    const s = decodeStat(bytes)!;
    expect(s.screenOn).toBe(false);
    expect(s.connError).toBe(true);
    expect(s.mac).toBe('AA:BB:CC:DD:EE:FF');
  });
  it('fw_ver 小端 02 01 = 0x0102 = 258', () => {
    const bytes = [0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0, 0, 0, 0, 0, 0];
    expect(decodeStat(bytes)!.fwVer).toBe(0x0102);
  });
  it('lastStatus 非0（坏帧回执）', () => {
    const bytes = [0x01, 0x01, 0x33, 0x32, 0x00, 0x04, 0x01, 0x00, 0, 0, 0, 0, 0, 0];
    expect(decodeStat(bytes)!.lastStatus).toBe(4);
  });
  it('长度不符返回 null', () => {
    expect(decodeStat([0x01, 0x01, 0x33])).toBeNull();
    expect(decodeStat([])).toBeNull();
  });
  it('15字节 v2：byte14=电量 77%', () => {
    const bytes = [0x01, 0x01, 0x33, 0x32, 0x00, 0x00, 0x02, 0x00, 0x28, 0x84, 0x85, 0x90, 0x60, 0x3e, 77];
    expect(decodeStat(bytes)!.battery).toBe(77);
  });
  it('15字节 battery=0xFF → null（无电池/未知）', () => {
    const bytes = [0x01, 0x01, 0x33, 0x32, 0x00, 0x00, 0x02, 0x00, 0x28, 0x84, 0x85, 0x90, 0x60, 0x3e, 0xff];
    expect(decodeStat(bytes)!.battery).toBeNull();
  });
  it('14字节旧固件 battery=null（向后兼容）', () => {
    const bytes = [0x01, 0x01, 0x33, 0x32, 0x00, 0x00, 0x01, 0x00, 0x28, 0x84, 0x85, 0x90, 0x60, 0x3e];
    expect(decodeStat(bytes)!.battery).toBeNull();
  });
});

describe('macToDeviceId', () => {
  it('去冒号转小写', () => {
    expect(macToDeviceId('28:84:85:90:60:3E')).toBe('28848590603e');
  });
});

describe('encodeWifiFrame（配网变长帧）', () => {
  it('ssid="Home" pwd="pass1234" → 正确变长帧', () => {
    expect(encodeWifiFrame('Home', 'pass1234')).toEqual([
      0xa1, 0x20, 0x0e, 0x04, 72, 111, 109, 101, 0x08, 112, 97, 115, 115, 49, 50, 51, 52,
    ]);
  });
  it('空密码合法（开放网络）', () => {
    expect(encodeWifiFrame('Wifi', '')).toEqual([0xa1, 0x20, 0x06, 0x04, 87, 105, 102, 105, 0x00]);
  });
  it('UTF-8 中文 SSID 按字节计长', () => {
    // '家'=E5 AE B6 (3字节)，pwd='x'=0x78。payload=[3][E5AEB6][1][78]=6 字节
    const f = encodeWifiFrame('家', 'x');
    expect(f.slice(0, 4)).toEqual([0xa1, 0x20, 6, 3]);
    expect(f.slice(4, 7)).toEqual([0xe5, 0xae, 0xb6]);
    expect(f.slice(7)).toEqual([1, 0x78]);
  });
});

describe('decodeStat wifiConnected（flags bit2）', () => {
  const base = [1, 0x00, 100, 50, 0, 0, 3, 0, 0x28, 0x84, 0x85, 0x90, 0x60, 0x3e, 80];
  it('bit2=0 → false', () => {
    expect(decodeStat(base)!.wifiConnected).toBe(false);
  });
  it('bit2=1 → true', () => {
    const withWifi = [...base];
    withWifi[1] = 0x04;
    expect(decodeStat(withWifi)!.wifiConnected).toBe(true);
  });
});
