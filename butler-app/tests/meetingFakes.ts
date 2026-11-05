/**
 * 会议页用例共用(2026-10-09):用生产那份接法(meetingSetup.ts)建一个会议控制器,
 * 只把录音器、权限、手机上的文件读写换成假的;账记在内存里的 Preferences。
 */
import type { ApiClient } from '../src/api/client';
import type { MicPermissionDeps } from '../src/call/micPermission';
import type { WbchMode } from '../src/channel/channelProtocol';
import type { MeetingController } from '../src/meeting/meetingController';
import { createMeetingControllerFor } from '../src/meeting/meetingSetup';
import type { MeetingRecorderDeps } from '../src/meeting/recorder';
import { memoryStore } from './wbchFakes';

export const MIC_GRANTED: MicPermissionDeps = {
  native: { check: async () => ({ granted: true, state: 'granted' }), request: async () => ({ granted: true, state: 'granted' }), openSettings: async () => {} },
};

export function testMeetingController(input: {
  direct: ApiClient;
  routed?: ApiClient & { mode?: () => WbchMode };
  recorderDeps: MeetingRecorderDeps;
  micDeps?: MicPermissionDeps;
  kv?: ReturnType<typeof memoryStore>;
  segmentMs?: number;
}): MeetingController {
  return createMeetingControllerFor({
    kv: input.kv ?? memoryStore(),
    direct: input.direct,
    routed: input.routed ?? input.direct,
    recorderDeps: input.recorderDeps,
    micDeps: input.micDeps ?? MIC_GRANTED,
    retryEveryMs: 0,
    ...(input.segmentMs === undefined ? {} : { segmentMs: input.segmentMs }),
    overrides: {
      readSegment: async () => new Uint8Array([1, 2, 3, 4]),
      saveSegment: async (key, segment) => `/data/${key}/${segment.seq}`,
      listDir: async () => [],
    },
  });
}
