import { describe, it, expect, vi, afterEach } from 'vitest';
import { startHeartbeat } from '../../../src/lifecycle/heartbeat.js';

describe('startHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls tick at the configured interval', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const handle = startHeartbeat(tick, 100);

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it('does not call tick before the interval elapses', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const handle = startHeartbeat(tick, 100);

    vi.advanceTimersByTime(99);
    expect(tick).not.toHaveBeenCalled();

    handle.stop();
  });

  it('stops calling tick after stop()', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const handle = startHeartbeat(tick, 100);

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);

    handle.stop();

    vi.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('clears interval when tick throws', () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => {
      throw new Error('stopped');
    });
    const handle = startHeartbeat(tick, 100);

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);

    // After throwing, the interval is cleared — no more calls
    vi.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('stop() is idempotent', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const handle = startHeartbeat(tick, 100);

    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
});
