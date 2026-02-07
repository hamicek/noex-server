import { describe, it, expect } from 'vitest';
import { isBackpressured } from '../../../src/lifecycle/backpressure.js';
import type { BackpressureConfig } from '../../../src/config.js';
import type { WebSocket } from 'ws';

function mockWs(bufferedAmount: number): WebSocket {
  return { bufferedAmount } as unknown as WebSocket;
}

describe('isBackpressured', () => {
  const config: BackpressureConfig = {
    maxBufferedBytes: 1_048_576, // 1 MB
    highWaterMark: 0.8,
  };

  it('returns false when buffer is empty', () => {
    expect(isBackpressured(mockWs(0), config)).toBe(false);
  });

  it('returns false when buffer is well below high water mark', () => {
    expect(isBackpressured(mockWs(100_000), config)).toBe(false);
  });

  it('returns false when buffer is just below the threshold', () => {
    // threshold = 1_048_576 * 0.8 = 838860.8
    expect(isBackpressured(mockWs(838_860), config)).toBe(false);
  });

  it('returns true when buffer reaches the threshold', () => {
    // 838861 >= 838860.8
    expect(isBackpressured(mockWs(838_861), config)).toBe(true);
  });

  it('returns true when buffer exceeds max', () => {
    expect(isBackpressured(mockWs(2_000_000), config)).toBe(true);
  });

  it('respects custom config values', () => {
    const custom: BackpressureConfig = {
      maxBufferedBytes: 100,
      highWaterMark: 0.5,
    };
    // threshold = 100 * 0.5 = 50
    expect(isBackpressured(mockWs(49), custom)).toBe(false);
    expect(isBackpressured(mockWs(50), custom)).toBe(true);
    expect(isBackpressured(mockWs(51), custom)).toBe(true);
  });

  it('handles highWaterMark of 1.0 (full buffer only)', () => {
    const full: BackpressureConfig = {
      maxBufferedBytes: 1000,
      highWaterMark: 1.0,
    };
    expect(isBackpressured(mockWs(999), full)).toBe(false);
    expect(isBackpressured(mockWs(1000), full)).toBe(true);
  });
});
