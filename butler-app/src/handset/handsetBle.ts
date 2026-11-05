/**
 * 手机这一侧的 BLE(2026-09-22)。**只有这一份碰蓝牙**;协议在 `provisionProtocol.ts`,
 * 流程在 `provisionMachine.ts`,界面在 `AddHandsetPage.tsx`。
 *
 * ## 为什么用 `@capacitor-community/bluetooth-le` 而不是自己写一件原生插件
 *
 * 这个仓库的老规矩是自己写(`MicPermissionPlugin` / `DeskPhonePlugin` /
 * `MeetingRecorderPlugin` 都是手写的,理由是 C4「往供应链里再加一个 pin 不住的东西」)。
 * 这一次**故意破例**,理由写清楚,好让将来有人能推翻:
 *
 * - 那三件手写的插件各是一两百行、调的都是一两个 Android API(通知、震动、MediaRecorder)。
 *   **BLE central 不是那个量级**:扫描过滤、GATT 连接、服务发现、描述符写入开通知、
 *   MTU 协商、以及「同一时刻只能有一个未完成的 GATT 操作」那条队列 ——
 *   最后一条是所有手写 BLE 客户端翻车的地方,而它只在真机上才暴露。
 * - **这张卡没有手机也没有派**,写出来的原生代码一行都跑不了。
 *   一个几万下载、被多个 Capacitor 大版本带着走的插件,至少那几百行 GATT 队列是被人用过的。
 * - C4 要的是「pin 版本」:`package.json` 里写的是精确的 `8.3.0`,不是 `^8.3.0`。
 *   peerDependency 是 `@capacitor/core >=8.0.0`,与本仓库的 Capacitor 8.5.2 对得上。
 *   体积:dist 612KB + android 96KB(源码,不是打进 APK 的量)。
 *
 * 换掉它的代价也写在这儿:把下面这一份 `HandsetBle` 的四个方法照着重新实现一遍就行,
 * 别处一行都不用动 —— 这正是它只有四个方法的原因。
 *
 * ## Android 的权限(12 及以上)
 *
 * - `BLUETOOTH_SCAN`(`usesPermissionFlags="neverForLocation"`)—— 扫描要;
 * - `BLUETOOTH_CONNECT` —— 连接与读写要;
 * - Android 11 及以下退回 `BLUETOOTH` / `BLUETOOTH_ADMIN` + `ACCESS_FINE_LOCATION`
 *   (那几版上 BLE 扫描被算作定位)。清单里两套都写了,各自带 `maxSdkVersion`。
 *
 * `BleClient.initialize()` 会去要这些权限。**要不到不装作成了**:抛出来的那一句
 * 由界面原样显示,并告诉人去系统设置里开哪一项。
 */
import {
  CHAR_COMMAND, CHAR_NETWORKS, CHAR_STATUS, FrameAssembler, HANDSET_SERVICE, TEXT,
  encodeFrames, handsetLabel, parseNetworks, parseStatus,
  type HandsetCommand, type HandsetNetwork, type HandsetStatus,
} from './provisionProtocol.ts';
import type { FoundHandset } from './provisionMachine.ts';

export interface HandsetBle {
  /** 开始扫。每发现一台(或名字变了)回调一次**全量**列表。 */
  scan(onFound: (devices: readonly FoundHandset[]) => void): Promise<void>;
  stopScan(): Promise<void>;
  /**
   * 连上并开两条通知。`onStatus` / `onNetworks` 之后一直会来,
   * `onLost` 是座机那头断了(或者人走远了)。
   */
  connect(input: {
    deviceId: string;
    onStatus: (status: HandsetStatus) => void;
    onNetworks: (list: readonly HandsetNetwork[]) => void;
    onLost: () => void;
  }): Promise<void>;
  send(deviceId: string, command: HandsetCommand): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  /**
   * 把系统的「位置信息」那一页打开(2026-09-27,卡 RM ③)。
   *
   * 为什么要它:小米(HyperOS)在系统定位开关关着时**蓝牙扫描静默回空** ——
   * 哪怕清单里声明了 `neverForLocation`(AndroidManifest.xml:99)。维护者 09-27 在
   * 小米上扫了半天一台都没有,打开「位置信息」之后立刻就扫到了
   * (docs/交接-0927-座机进错房间.md 第一节第 1 条)。Pixel 按原生 Android 12+ 的规则不受影响。
   *
   * 所以这条路上要的不是一句解释,是**一颗能点的键**。iOS 与老版本插件上这一项缺席
   * (`?`),界面那时只说话、不出键。
   */
  openLocationSettings?(): Promise<void>;
}

/** 抛出来给界面看的那一句。**不带原始异常里的地址与栈**。 */
export class HandsetBleError extends Error {}

function saidBy(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : '';
  const low = raw.toLowerCase();
  // 这几句是插件/系统层的英文原话,翻成"下一步做什么"。认不得的一律用 fallback ——
  // 把一句英文栈摆给人看,他照着什么也做不了。
  if (low.includes('permission') || low.includes('denied')) return TEXT.noPermission;
  if (low.includes('not enabled') || low.includes('bluetooth is disabled') || low.includes('poweredoff')) {
    return TEXT.bluetoothOff;
  }
  if (low.includes('unavailable') || low.includes('not available') || low.includes('unimplemented')) {
    return '这台手机上用不了蓝牙(或者装的是旧版 App):换一台手机,或者重装一次手机包';
  }
  return fallback;
}

/**
 * 真的那一份。**懒加载插件**:`import` 放在方法里而不是文件顶上,
 * 好让这一份在 jsdom 的用例里 import 得进来(用例注入的是假的 transport)。
 */
export function createHandsetBle(): HandsetBle {
  /** 每台设备一对帧拼装器。两条通知各拼各的,**不能共用** —— 共用会把两条消息拼串。 */
  const boxes = new Map<string, { status: FrameAssembler; networks: FrameAssembler }>();
  /** 协商到的 MTU。拿不到就按 23 发(那是一定发得出去的那一档)。 */
  const mtus = new Map<string, number>();
  const found = new Map<string, FoundHandset>();

  async function client() {
    const mod = await import('@capacitor-community/bluetooth-le');
    return mod.BleClient;
  }

  return {
    async scan(onFound) {
      found.clear();
      let ble;
      try {
        ble = await client();
        await ble.initialize({ androidNeverForLocation: true });
      } catch (error) {
        throw new HandsetBleError(saidBy(error, TEXT.noPermission));
      }
      try {
        if (!(await ble.isEnabled())) throw new HandsetBleError(TEXT.bluetoothOff);
      } catch (error) {
        if (error instanceof HandsetBleError) throw error;
        // isEnabled 在某些实现上直接抛。抛了就当"不知道",继续扫 —— 扫不到自然会说。
      }
      /**
       * **系统定位关着就先说**(2026-09-27,卡 RM ③)。小米(HyperOS)在这种状态下
       * 蓝牙扫描**静默回空**,于是屏上转十秒然后说「附近没找到座机」—— 一句完全指错方向的话,
       * 维护者照着它把座机搬来搬去。现在当场说清是哪个开关,并给一颗键去开。
       *
       * `isLocationEnabled` 在 iOS 与老插件上不存在或直接抛:那时**什么都不做**,照旧扫
       * (iOS 压根没这条规矩,编一句「去开定位」只会把人带到一个不存在的开关前)。
       */
      try {
        if ((await ble.isLocationEnabled()) === false) throw new HandsetBleError(TEXT.locationOff);
      } catch (error) {
        if (error instanceof HandsetBleError) throw error;
        // 见上:问不出来就当没这条规矩。
      }
      try {
        await ble.requestLEScan({ services: [HANDSET_SERVICE] }, (result) => {
          // **按 service UUID 找,按名字显示**:名字在扫描响应包里,可能迟到甚至不来,
          // 那时先用一个占位名,下一条扫描结果带上名字再覆盖。
          const name = handsetLabel(result.localName ?? result.device.name);
          found.set(result.device.deviceId, {
            id: result.device.deviceId,
            name,
            ...(typeof result.rssi === 'number' ? { rssi: result.rssi } : {}),
          });
          onFound([...found.values()]);
        });
      } catch (error) {
        throw new HandsetBleError(saidBy(error, TEXT.noPermission));
      }
    },

    async stopScan() {
      try {
        await (await client()).stopLEScan();
      } catch { /* 停不掉不影响任何事,下一次扫会重来 */ }
    },

    async openLocationSettings() {
      // 打不开就算了:上面那句话里已经写清了去哪儿开。
      try { await (await client()).openLocationSettings(); } catch { /* 见上 */ }
    },

    async connect({ deviceId, onStatus, onNetworks, onLost }) {
      let ble;
      try {
        ble = await client();
        await ble.connect(deviceId, () => onLost());
      } catch (error) {
        throw new HandsetBleError(saidBy(error, TEXT.connectFailed));
      }
      boxes.set(deviceId, { status: new FrameAssembler(), networks: new FrameAssembler() });
      try {
        // 能协商到多少就发多少。拿不到不当错 —— 23 那一档一定发得出去,只是慢。
        mtus.set(deviceId, await ble.getMtu(deviceId));
      } catch {
        mtus.set(deviceId, 23);
      }
      const box = boxes.get(deviceId)!;
      const listen = async (characteristic: string, assembler: FrameAssembler, hand: (value: unknown) => void) => {
        await ble.startNotifications(deviceId, HANDSET_SERVICE, characteristic, (value) => {
          const frame = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          const whole = assembler.feed(frame);
          if (whole !== null) hand(whole);
        });
      };
      try {
        await listen(CHAR_STATUS, box.status, (raw) => {
          const one = parseStatus(raw);
          if (one !== null) onStatus(one);
        });
        await listen(CHAR_NETWORKS, box.networks, (raw) => {
          const list = parseNetworks(raw);
          if (list !== null) onNetworks(list);
        });
      } catch (error) {
        throw new HandsetBleError(saidBy(error, TEXT.connectFailed));
      }
    },

    async send(deviceId, command) {
      const ble = await client();
      const mtu = mtus.get(deviceId) ?? 23;
      // **一帧一帧顺序写**:BLE 同一时刻只能有一个未完成的 GATT 操作,
      // 并发写出去的后果是后面那几帧被静默丢掉,而两头都看不出来。
      for (const frame of encodeFrames(command, mtu)) {
        await ble.write(deviceId, HANDSET_SERVICE, CHAR_COMMAND,
          new DataView(frame.buffer, frame.byteOffset, frame.byteLength));
      }
    },

    async disconnect(deviceId) {
      boxes.delete(deviceId);
      mtus.delete(deviceId);
      try {
        await (await client()).disconnect(deviceId);
      } catch { /* 断不掉也就那样:连接迟早会超时掉 */ }
    },
  };
}
