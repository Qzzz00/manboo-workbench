'use strict';

// 「多人协作区」总开关在中转这一侧的读法。
// 与 workbench-plugin/src/collabFeature.ts 的取值规则**逐字一致**,只是这里是独立进程、CommonJS。
// 默认关:开源版起 relay 不建协作区的 15 张表、也不挂 /v1/* 协作路由。
// 要开就显式设 WORKBENCH_COLLAB_ENABLED=1(与本机工作台同一个变量,两边都设才算整块接上)。

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

function collabEnabledOf(env = process.env) {
  const raw = String(env.WORKBENCH_COLLAB_ENABLED ?? '').trim().toLowerCase();
  if (ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  return false; // 没配 = 关
}

module.exports = { collabEnabledOf };
