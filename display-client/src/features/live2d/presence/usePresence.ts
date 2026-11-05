import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPresenceStore, type ComposedPresence, type PresenceStore } from './presenceStore.ts';

/**
 * 持有一个 PresenceStore 实例并把 compose() 结果作为 React 状态暴露。
 * 合成器是模型唯一写入口：调用方只通过返回的 `presence`（四层 API）写入，
 * 渲染侧消费 `composed`（已合成的 expressionMix/parameterOverrides/costumeParamOverrides/nativeTriggers）。
 */
export function usePresence(neutralExpressionId: string): {
  presence: PresenceStore;
  composed: ComposedPresence;
} {
  const storeRef = useRef<PresenceStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createPresenceStore({ neutralExpressionId });
  }
  const store = storeRef.current;

  // compose() 每次返回新对象，useSyncExternalStore 要求 getSnapshot 稳定引用，
  // 故缓存上一次合成结果，仅在变更通知到来时重算并替换。
  const snapshotRef = useRef<ComposedPresence | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = store.compose();
  }

  // ★subscribe 必须是稳定引用，且**建立订阅时要先补一次快照**。
  // 否则会丢通知：React 的 effect 执行顺序是「子组件先、父组件后」，而 store 通常由父组件
  // (usePresence) 持有、由子组件的 effect 写入。子组件 effect 里的 setApparel→emit() 发生时，
  // 本 hook 的订阅 effect 还没跑，那次通知没有任何订阅者接收，snapshotRef 停在挂载时的空合成，
  // 之后若不再有变更就**永远是空的**。
  // 真机症状：holo 白天主题下换装 Param67 在 store 里是 1、传给模型的却是 []，双击切不出 DJ 装，
  // 且全程无报错（compose 正确、setApparel 也调到了，只有 React 侧的快照是旧的）。
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      snapshotRef.current = store.compose();
      onStoreChange();
      return store.subscribe(() => {
        snapshotRef.current = store.compose();
        onStoreChange();
      });
    },
    [store],
  );

  const composed = useSyncExternalStore(
    subscribe,
    () => snapshotRef.current as ComposedPresence,
    () => snapshotRef.current as ComposedPresence,
  );

  return useMemo(() => ({ presence: store, composed }), [store, composed]);
}
