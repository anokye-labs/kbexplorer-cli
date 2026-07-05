export const SSE_EVENTS = Object.freeze({
  READY: 'ready',
  GRAPH_UPDATED: 'graph-updated',
  ANCHOR: 'anchor',
});

export function defaultSubscribe(_instanceId, _onEvent) {
  return () => {};
}

export function createEventBus() {
  const listeners = new Map();

  function subscribe(instanceId, onEvent) {
    let set = listeners.get(instanceId);
    if (!set) {
      set = new Set();
      listeners.set(instanceId, set);
    }
    set.add(onEvent);
    return () => {
      set.delete(onEvent);
      if (set.size === 0) listeners.delete(instanceId);
    };
  }

  function emit(instanceId, event, data) {
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
