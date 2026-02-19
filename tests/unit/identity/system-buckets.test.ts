import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { ensureSystemBuckets } from '../../../src/identity/system-buckets.js';
import { SYSTEM_BUCKET_NAMES } from '../../../src/identity/identity-types.js';

describe('system-buckets', () => {
  let store: Store;
  let storeCounter = 0;

  beforeEach(async () => {
    store = await Store.start({ name: `sys-buckets-test-${++storeCounter}` });
  });

  afterEach(async () => {
    if (store) {
      await store.stop();
    }
  });

  it('creates all 6 system buckets', async () => {
    await ensureSystemBuckets(store);

    for (const name of SYSTEM_BUCKET_NAMES) {
      expect(store.hasBucket(name)).toBe(true);
    }
  });

  it('is idempotent — calling twice does not throw', async () => {
    await ensureSystemBuckets(store);
    await ensureSystemBuckets(store);

    for (const name of SYSTEM_BUCKET_NAMES) {
      expect(store.hasBucket(name)).toBe(true);
    }
  });

  it('preserves data across idempotent calls', async () => {
    await ensureSystemBuckets(store);

    // Insert a record into _roles
    const inserted = await store.bucket('_roles').insert({
      name: 'test-role',
      system: false,
      permissions: [],
    });

    // Call ensureSystemBuckets again
    await ensureSystemBuckets(store);

    // Data should still be there
    const record = await store.bucket('_roles').get(inserted['id']);
    expect(record).toBeDefined();
    expect(record!['name']).toBe('test-role');
  });

  it('creates _users bucket with correct schema', async () => {
    await ensureSystemBuckets(store);

    const schema = store.getBucketSchema('_users');
    expect(schema).toBeDefined();
    expect(schema!.key).toBe('id');
    expect(schema!.schema['username']!.unique).toBe(true);
    expect(schema!.schema['username']!.required).toBe(true);
    expect(schema!.schema['passwordHash']!.required).toBe(true);
    expect(schema!.schema['id']!.generated).toBe('uuid');
  });

  it('creates _sessions bucket with TTL', async () => {
    await ensureSystemBuckets(store);

    const schema = store.getBucketSchema('_sessions');
    expect(schema).toBeDefined();
    expect(schema!.ttl).toBe('24h');
  });

  it('does not fail when some buckets already exist', async () => {
    // Manually create one bucket first
    await store.defineBucket('_roles', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true, unique: true, minLength: 1, maxLength: 64 },
        description: { type: 'string' },
        system:      { type: 'boolean', default: false },
        permissions: { type: 'array' },
      },
      indexes: ['name'],
    });

    // ensureSystemBuckets should skip _roles and create the rest
    await ensureSystemBuckets(store);

    for (const name of SYSTEM_BUCKET_NAMES) {
      expect(store.hasBucket(name)).toBe(true);
    }
  });
});
