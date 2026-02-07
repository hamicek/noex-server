export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Starts a periodic heartbeat timer that calls the given `tick` function
 * at the configured interval.
 *
 * The tick function is typically a closure that casts a `heartbeat_tick`
 * message to the ConnectionServer GenServer. If the tick function throws
 * (e.g. because the GenServer has already stopped), the interval is
 * automatically cleared.
 *
 * Returns a handle whose `stop()` method clears the interval.
 */
export function startHeartbeat(
  tick: () => void,
  intervalMs: number,
): HeartbeatHandle {
  const id = setInterval(() => {
    try {
      tick();
    } catch {
      clearInterval(id);
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(id);
    },
  };
}
