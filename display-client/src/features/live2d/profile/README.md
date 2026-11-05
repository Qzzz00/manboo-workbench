# v1 Profile 数据层与触发调度器

本目录存放 Aiboo v1 角色打标规则的数据层实现：

- `types.ts` —— Profile 类型定义
- `loader.ts` —— JSON 加载与运行时校验
- `triggerScheduler.ts` —— 三通道触发调度器（纯逻辑，不碰引擎）
- `triggerScheduler.test.ts` —— 单测
- `../../../model/profiles/<role>.v1.json` —— 5 份角色 profile 数据文件

下一批要写渲染接入的 Agent，请重点看「如何接入调度器」一节。

---

## 1. v1 Profile 是什么

每份 profile 描述一个角色的可用动作/表情/装扮文件，以及被剔除的文件清单。

文件位置：`Aiboo/model/profiles/<role>.v1.json`  
当前角色：`shuangsheng`、`shuangsheng-dj`、`yumi`、`rattan`、`estella`。

### Schema

```jsonc
{
  "role": string,                        // 角色 ID
  "schemaVersion": "v1",
  "idleStrategy"?: "virtual_empty",      // 仅 yumi；表示没有真实 idle motion，播完动作后回空
  "motions": Array<MotionEntry>,         // .motion3 文件
  "expressions": Array<ExpressionEntry>, // .exp3 文件（expr + costume 都在这里）
  "excluded": Array<{ file: string; reason: string }>
}
```

条目类型：

```ts
type MotionEntry =
  | { file: string; kind: 'idle' }
  | { file: string; kind: 'motion'; intensity: 'light' | 'strong' };

type ExpressionEntry =
  | { file: string; kind: 'expr'; intensity: 'light' | 'strong' }
  | { file: string; kind: 'costume'; slot: CostumeSlot };

// CostumeSlot: hair | headwear | earwear | eyewear | mouth_cover | outerwear | outfit | legwear | handheld | accessory
```

规则来源：上级 issue `[ALL-264]` 定稿的 v1 打标规则。

---

## 2. 三通道并行规则

调度器维护三个互不影响的通道：

| 通道 | 资源 | 规则 |
|---|---|---|
| **动作通道** | `.motion3` | `idle` 与 `motion` 互斥；`motion` 播完自动回 `idle`；新 `motion` 打断旧 `motion` |
| **表情通道** | `.exp3` 中的 `expr` | 触发后挂起，TTS 结束 + 0.5s 缓冲后自动清；期间新 `expr` 覆盖并重新计时 |
| **装扮通道** | `.exp3` 中的 `costume` | 长效状态；同 `slot` 互斥，不同 `slot` 并存 |

- 动作与表情并行，互不清除。
- 装扮不打断动作/表情。
- 未知文件触发会抛错。

---

## 3. 如何加载

```ts
import { readFileSync } from 'node:fs';
import { loadProfileFromJson } from './loader';

const json = readFileSync('model/profiles/shuangsheng.v1.json', 'utf-8');
const profile = loadProfileFromJson(json);
```

`loadProfileFromJson` 内部会 `JSON.parse` 并走 `parseProfile` 做运行时校验：

- `schemaVersion === 'v1'`
- `role` 非空
- 每个 entry 的 `kind` 合法
- `motion` / `expr` 必须有 `intensity`
- `costume` 必须有合法 `slot`

校验失败抛 `Error`，消息带出错路径。

---

## 4. 如何接入调度器

调度器只输出**描述性 action**，不直接调用 `live2dEngine`。

```ts
import { TriggerScheduler } from './triggerScheduler';

const scheduler = new TriggerScheduler(profile, () => Date.now());

// 触发某个文件
const actions = scheduler.trigger('dance.motion3', { ttsEndsAtMs: 5000 });
// => [{ type: 'play_motion', file: 'dance.motion3' }]

// motion 播放完成后由外部回调
scheduler.onMotionEnded();
// => [{ type: 'return_to_idle', file: 'idle.motion3' }]

// 每帧或定时检查 expr 是否到期
scheduler.tick();
// => [{ type: 'clear_expr' }]  或 []
```

### Action 类型

```ts
type TriggerAction =
  | { type: 'play_motion'; file: string }
  | { type: 'return_to_idle'; file: string | null } // null = virtual_empty
  | { type: 'set_expr'; file: string; clearAtMs: number }
  | { type: 'clear_expr' }
  | { type: 'set_costume'; slot: CostumeSlot; file: string; replaced: string | null };
```

### 接入渲染管线的建议

1. 启动时按当前角色 `loadProfileFromJson`。
2. 用 `new TriggerScheduler(profile, () => Date.now())` 创建调度器实例。
3. 当 LLM/调用方决定触发某个文件时，调用 `scheduler.trigger(file, { ttsEndsAtMs })`。
4. 根据返回的 `TriggerAction[]` 驱动引擎：
   - `play_motion` → 调用 `live2dEngine.playMotion(file)`
   - `return_to_idle` → `file` 为 `null` 时切到 virtual_empty，否则播对应 idle
   - `set_expr` → 调用 `live2dEngine.setExpression(file)`，并在外部 TTS 结束后或 `clearAtMs` 时调用 `tick()`
   - `clear_expr` → 调用 `live2dEngine.setExpression('neutral')` 或等价清除
   - `set_costume` → 按 slot 切换 expression/costume，注意 `replaced` 是旧件
5. 不要把 `ttsEndsAtMs` 计算逻辑塞进调度器；调用方根据 TTS 事件自己算。

---

## 5. 测试

```bash
pnpm vitest run src/features/live2d/profile
```

当前包含 12 个用例，覆盖 motion/expr/costume/错误处理。

---

## 6. 约束

- 本层**不接入** `live2dEngine.ts` 渲染管线。
- 本层**不订阅** TTS 事件；只接收 `ttsEndsAtMs` 参数。
- 不引入新 npm 依赖。
- 5 份 JSON 文件与任务包清单字段一致，请勿手动改动。

---

## 真机测试（v2 profile 接入）

前置：
- 已切到分支 `agent/k/96c0bd9c`，本地 `pnpm i && pnpm dev`。
- 手机与开发机同一 Wi-Fi，浏览器访问 dev server（或按项目现有真机联调方式）。

步骤：
1. 选中角色 shuangsheng，打开浏览器 devtools。
2. 在 console 里执行：
   ```js
   window.debugTriggerProfile('dance.motion3')
   ```
   预期：人物播 dance 动画，结束后自动回 idle.motion3。
3. 让 App 触发一次 TTS（正常聊天让 AI 说话），播放中执行：
   ```js
   window.debugTriggerProfile('爱心眼.exp3')
   ```
   预期：TTS 结束后大约 0.5s 表情自动消失。
4. 执行：
   ```js
   window.debugTriggerProfile('机器人耳朵.exp3')   // 期望换 headwear
   window.debugTriggerProfile('猫爪手套.exp3')     // 期望不同 slot 并存
   window.debugTriggerProfile('机器人耳朵.exp3')   // 期望 headwear 已在，按覆盖策略走
   ```
   预期：可见装扮切换且不冲突。
5. 切换到角色 yumi，重复步骤 2 —— 由于 idleStrategy=virtual_empty，动作结束后不应尝试播 idle 文件。

> 当前 v2 profile 触发通道与 DJ/legacy 的 `playAction` / `Live2DStage.action` 通道独立；若 profile 加载失败，人物仍按老路径正常显示。
