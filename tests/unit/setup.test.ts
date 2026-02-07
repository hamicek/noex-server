import { describe, it, expect } from 'vitest';

describe('project setup', () => {
  it('vitest runs correctly', () => {
    expect(1 + 1).toBe(2);
  });

  it('can import @hamicek/noex', async () => {
    const noex = await import('@hamicek/noex');
    expect(noex.GenServer).toBeDefined();
    expect(noex.Supervisor).toBeDefined();
    expect(noex.RateLimiter).toBeDefined();
    expect(noex.EventBus).toBeDefined();
  });

  it('can import @hamicek/noex-store', async () => {
    const store = await import('@hamicek/noex-store');
    expect(store.Store).toBeDefined();
  });

  it('can import @hamicek/noex-rules', async () => {
    const rules = await import('@hamicek/noex-rules');
    expect(rules.RuleEngine).toBeDefined();
  });

  it('can import ws', async () => {
    const ws = await import('ws');
    expect(ws.WebSocketServer).toBeDefined();
  });
});
