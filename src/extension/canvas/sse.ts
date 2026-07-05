export const SSE_EVENTS = Object.freeze({
  READY: 'ready',
  GRAPH_UPDATED: 'graph-updated',
  ANCHOR: 'anchor',
});

export interface CanvasEvent {
  event: string;
  data?: unknown;
}

export type CanvasEventListener = (event: CanvasEvent) => void;
export type CanvasSubscribe = (instanceId: string, onEvent: CanvasEventListener) => () => void;

export interface CanvasEventBus {
  subscribe: CanvasSubscribe;
  emit: (instanceId: string, event: string, data?: unknown) => boolean;
}

export function defaultSubscribe(_instanceId: string, _onEvent: CanvasEventListener) {
  return () => {};
}

export function createEventBus(): CanvasEventBus {
  const listeners = new Map<string, Set<CanvasEventListener>>();

  function subscribe(instanceId: string, onEvent: CanvasEventListener) {
    let set = listeners.get(instanceId);
    if (!set) {
      set = new Set<CanvasEventListener>();
      listeners.set(instanceId, set);
    }
    set.add(onEvent);
    return () => {
      set.delete(onEvent);
      if (set.size === 0) listeners.delete(instanceId);
    };
  }

  function emit(instanceId: string, event: string, data?: unknown) {
    const set = listeners.get(instanceId);
    if (!set || set.size === 0) return false;
    let delivered = false;
    for (const onEvent of [...set]) {
      try {
        onEvent({ event, data });
        delivered = true;
      } catch {
        // ignore failing listeners
      }
    }
    return delivered;
  }

  return { subscribe, emit };
}
