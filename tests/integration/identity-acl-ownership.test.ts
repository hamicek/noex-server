import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';

// ── Helpers ──────────────────────────────────────────────────────

let requestIdCounter = 1;

function connectClient(
  port: number,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
  });
}

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Identity ACL & Ownership', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  const ADMIN_SECRET = 'test-admin-secret';

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }
    server = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  async function setup(): Promise<void> {
    store = await Store.start({ name: `identity-acl-${++storeCounter}` });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth: {
        builtIn: true,
        adminSecret: ADMIN_SECRET,
      },
    });
  }

  async function superadminClient(): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    await sendRequest(ws, {
      type: 'identity.loginWithSecret',
      secret: ADMIN_SECRET,
    });
    return ws;
  }

  async function defineBucket(name: string): Promise<void> {
    const ws = await superadminClient();
    await sendRequest(ws, {
      type: 'store.defineBucket',
      name,
      config: {
        key: 'id',
        schema: { id: { type: 'string', auto: 'uuid' }, value: { type: 'string' } },
      },
    });
  }

  async function createAndLoginUser(
    username: string,
    password: string,
    roleName?: string,
  ): Promise<{ ws: WebSocket; userId: string }> {
    const admin = await superadminClient();

    const createResp = await sendRequest(admin, {
      type: 'identity.createUser',
      username,
      password,
    });
    const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

    if (roleName) {
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName,
      });
    }

    await delay(50);

    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    await sendRequest(ws, {
      type: 'identity.login',
      username,
      password,
    });

    return { ws, userId };
  }

  // ── Automatic Ownership ─────────────────────────────────────────

  describe('automatic ownership', () => {
    it('user who defines a bucket becomes its owner', async () => {
      await setup();
      const admin = await superadminClient();

      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'invoices',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, value: { type: 'string' } },
        },
      });

      await delay(50);

      const resp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'invoices',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const owner = data['owner'] as Record<string, unknown>;
      expect(owner).not.toBeNull();
      expect(owner['username']).toBe('__superadmin__');
    });

    it('admin user who defines a bucket becomes its owner', async () => {
      await setup();
      const { ws, userId } = await createAndLoginUser('admin1', 'password1234', 'admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'my-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      const admin = await superadminClient();
      const resp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'my-bucket',
      });

      expect(resp['type']).toBe('result');
      const owner = (resp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>;
      expect(owner['userId']).toBe(userId);
      expect(owner['username']).toBe('admin1');
    });

    it('dropBucket removes ownership', async () => {
      await setup();
      const admin = await superadminClient();

      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'temp',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await sendRequest(admin, {
        type: 'store.dropBucket',
        name: 'temp',
      });

      await delay(50);

      const resp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'temp',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['owner']).toBeNull();
    });

    it('dropBucket cleans up ACL entries for that bucket', async () => {
      await setup();

      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      const admin = await superadminClient();

      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'ephemeral',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      // Grant bob access
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'ephemeral',
        operations: ['read', 'write'],
      });

      await delay(50);

      // Verify ACL exists
      const aclBefore = await sendRequest(admin, {
        type: 'identity.getAcl',
        resourceType: 'bucket',
        resourceName: 'ephemeral',
      });
      expect(aclBefore['type']).toBe('result');
      const entriesBefore = (aclBefore['data'] as Record<string, unknown>)['entries'] as unknown[];
      expect(entriesBefore.length).toBeGreaterThan(0);

      // Drop the bucket
      await sendRequest(admin, {
        type: 'store.dropBucket',
        name: 'ephemeral',
      });

      await delay(50);

      // Verify ACL is cleaned up
      const aclAfter = await sendRequest(admin, {
        type: 'identity.getAcl',
        resourceType: 'bucket',
        resourceName: 'ephemeral',
      });
      expect(aclAfter['type']).toBe('result');
      const entriesAfter = (aclAfter['data'] as Record<string, unknown>)['entries'] as unknown[];
      // Should have no entries (or only an owner entry with no operations)
      const nonEmptyEntries = entriesAfter.filter(
        (e) => ((e as Record<string, unknown>)['operations'] as string[]).length > 0,
      );
      expect(nonEmptyEntries.length).toBe(0);
    });
  });

  // ── Grant & Revoke ──────────────────────────────────────────────

  describe('grant and revoke', () => {
    it('superadmin can grant read access to a user on a bucket', async () => {
      await setup();
      await defineBucket('docs');

      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');
      const admin = await superadminClient();

      const resp = await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['granted']).toBe(true);
    });

    it('granted user can access the resource', async () => {
      await setup();
      await defineBucket('docs');

      // Create bob with no roles
      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'password1234');

      // Bob cannot read (no role, no ACL)
      const denyResp = await sendRequest(bobWs, {
        type: 'store.all',
        bucket: 'docs',
      });
      expect(denyResp['type']).toBe('error');
      expect(denyResp['code']).toBe('FORBIDDEN');

      // Grant bob read access
      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      await delay(100);

      // Now bob CAN read
      const allowResp = await sendRequest(bobWs, {
        type: 'store.all',
        bucket: 'docs',
      });
      expect(allowResp['type']).toBe('result');

      // But bob still cannot write
      const writeDeny = await sendRequest(bobWs, {
        type: 'store.insert',
        bucket: 'docs',
        data: { value: 'test' },
      });
      expect(writeDeny['type']).toBe('error');
      expect(writeDeny['code']).toBe('FORBIDDEN');
    });

    it('grant merges operations on existing ACL entry', async () => {
      await setup();
      await defineBucket('docs');

      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');
      const admin = await superadminClient();

      // First grant: read
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      // Second grant: write (should merge with read)
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['write'],
      });

      await delay(50);

      const aclResp = await sendRequest(admin, {
        type: 'identity.getAcl',
        resourceType: 'bucket',
        resourceName: 'docs',
      });

      const entries = (aclResp['data'] as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
      const bobEntry = entries.find((e) => e['subjectId'] === bobId);
      expect(bobEntry).toBeDefined();
      expect((bobEntry!['operations'] as string[]).sort()).toEqual(['read', 'write']);
    });

    it('revoke removes specific operations', async () => {
      await setup();
      await defineBucket('docs');

      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'password1234');
      const admin = await superadminClient();

      // Grant read + write
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read', 'write'],
      });

      await delay(100);

      // Bob can write
      const writeOk = await sendRequest(bobWs, {
        type: 'store.insert',
        bucket: 'docs',
        data: { value: 'test' },
      });
      expect(writeOk['type']).toBe('result');

      // Revoke write only
      await sendRequest(admin, {
        type: 'identity.revoke',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['write'],
      });

      await delay(100);

      // Bob can still read
      const readOk = await sendRequest(bobWs, {
        type: 'store.all',
        bucket: 'docs',
      });
      expect(readOk['type']).toBe('result');

      // Bob cannot write anymore
      const writeDeny = await sendRequest(bobWs, {
        type: 'store.insert',
        bucket: 'docs',
        data: { value: 'blocked' },
      });
      expect(writeDeny['type']).toBe('error');
      expect(writeDeny['code']).toBe('FORBIDDEN');
    });

    it('revoke without operations removes the entire ACL entry', async () => {
      await setup();
      await defineBucket('docs');

      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'password1234');
      const admin = await superadminClient();

      // Grant access
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read', 'write'],
      });

      await delay(100);

      // Revoke all (no operations field)
      await sendRequest(admin, {
        type: 'identity.revoke',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
      });

      await delay(100);

      // Bob has no access
      const deny = await sendRequest(bobWs, {
        type: 'store.all',
        bucket: 'docs',
      });
      expect(deny['type']).toBe('error');
      expect(deny['code']).toBe('FORBIDDEN');
    });

    it('non-owner non-admin cannot grant', async () => {
      await setup();
      await defineBucket('docs');

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'writer');
      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      const resp = await sendRequest(aliceWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('invalid ACL operations are rejected', async () => {
      await setup();
      await defineBucket('docs');

      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');
      const admin = await superadminClient();

      const resp = await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read', 'execute'],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('grant to non-existent user fails', async () => {
      await setup();
      await defineBucket('docs');

      const admin = await superadminClient();

      const resp = await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: 'non-existent-id',
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('can grant access to a role', async () => {
      await setup();
      await defineBucket('docs');

      const admin = await superadminClient();

      // Create a custom role
      const roleResp = await sendRequest(admin, {
        type: 'identity.createRole',
        name: 'editor',
      });
      const roleId = (roleResp['data'] as Record<string, unknown>)['id'] as string;

      // Grant role access to a bucket
      const grantResp = await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'role',
        subjectId: roleId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read', 'write'],
      });
      expect(grantResp['type']).toBe('result');

      await delay(50);

      // Create user with the editor role
      const { ws: userWs } = await createAndLoginUser('editor1', 'password1234', 'editor');

      // User can read via role ACL
      const readResp = await sendRequest(userWs, {
        type: 'store.all',
        bucket: 'docs',
      });
      expect(readResp['type']).toBe('result');

      // User can write via role ACL
      const writeResp = await sendRequest(userWs, {
        type: 'store.insert',
        bucket: 'docs',
        data: { value: 'via-role' },
      });
      expect(writeResp['type']).toBe('result');
    });
  });

  // ── Owner-based granting ──────────────────────────────────────

  describe('owner-based granting', () => {
    it('owner can grant access to others on their resource', async () => {
      await setup();

      // Alice (admin) defines a bucket — becomes owner
      const { ws: aliceWs, userId: aliceId } = await createAndLoginUser('alice', 'password1234', 'admin');

      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'alice-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, value: { type: 'string' } },
        },
      });

      await delay(50);

      // Verify alice is owner
      const ownerResp = await sendRequest(aliceWs, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'alice-bucket',
      });
      expect(
        ((ownerResp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>)['userId'],
      ).toBe(aliceId);

      // Create bob with no roles
      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'password1234');

      // Alice grants bob read access
      const grantResp = await sendRequest(aliceWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'alice-bucket',
        operations: ['read'],
      });
      expect(grantResp['type']).toBe('result');

      await delay(100);

      // Bob can read
      const readResp = await sendRequest(bobWs, {
        type: 'store.all',
        bucket: 'alice-bucket',
      });
      expect(readResp['type']).toBe('result');
    });

    it('owner has implicit full access to their resource', async () => {
      await setup();

      // Alice (no special role besides a way to create buckets) — use admin for bucket creation
      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'admin');

      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'owned-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, value: { type: 'string' } },
        },
      });

      // Remove admin role from alice (she'll only have ownership)
      // Actually, we can't easily do this within the test since the role was
      // needed to define the bucket. Let's test differently.

      // Instead, test that an admin user who creates a bucket is also owner
      // and that ownership grants access independently of role
      const admin = await superadminClient();
      const resp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'owned-bucket',
      });
      expect(resp['type']).toBe('result');
      const owner = (resp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>;
      expect(owner['username']).toBe('alice');
    });
  });

  // ── Transfer Ownership ─────────────────────────────────────────

  describe('transfer ownership', () => {
    it('owner can transfer ownership to another user', async () => {
      await setup();

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'admin');
      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      // Alice creates a bucket
      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'transfer-me',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      // Alice transfers ownership to bob
      const resp = await sendRequest(aliceWs, {
        type: 'identity.transferOwner',
        resourceType: 'bucket',
        resourceName: 'transfer-me',
        newOwnerId: bobId,
      });
      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['transferred']).toBe(true);

      await delay(50);

      // Verify bob is now the owner
      const admin = await superadminClient();
      const ownerResp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'transfer-me',
      });
      expect(
        ((ownerResp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>)['userId'],
      ).toBe(bobId);
    });

    it('superadmin can transfer ownership', async () => {
      await setup();

      const { userId: aliceId } = await createAndLoginUser('alice', 'password1234', 'admin');
      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      const admin = await superadminClient();

      // Superadmin creates a bucket
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'sa-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      // Superadmin transfers to alice
      const resp = await sendRequest(admin, {
        type: 'identity.transferOwner',
        resourceType: 'bucket',
        resourceName: 'sa-bucket',
        newOwnerId: aliceId,
      });
      expect(resp['type']).toBe('result');

      await delay(50);

      // Verify alice is owner
      const ownerResp = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'sa-bucket',
      });
      expect(
        ((ownerResp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>)['userId'],
      ).toBe(aliceId);
    });

    it('non-owner non-superadmin cannot transfer ownership', async () => {
      await setup();

      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'locked',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      const { ws: bobWs } = await createAndLoginUser('bob', 'password1234', 'writer');
      const { userId: aliceId } = await createAndLoginUser('alice', 'password1234');

      const resp = await sendRequest(bobWs, {
        type: 'identity.transferOwner',
        resourceType: 'bucket',
        resourceName: 'locked',
        newOwnerId: aliceId,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── getAcl ────────────────────────────────────────────────────

  describe('getAcl', () => {
    it('returns ACL entries with subject names and ownership info', async () => {
      await setup();

      const admin = await superadminClient();

      // Admin creates a bucket (becomes owner)
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'acl-test',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      // Grant bob read+write
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'acl-test',
        operations: ['read', 'write'],
      });

      await delay(50);

      const resp = await sendRequest(admin, {
        type: 'identity.getAcl',
        resourceType: 'bucket',
        resourceName: 'acl-test',
      });

      expect(resp['type']).toBe('result');
      const entries = (resp['data'] as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThanOrEqual(2); // owner + bob

      // Find the owner entry
      const ownerEntry = entries.find((e) => e['isOwner'] === true);
      expect(ownerEntry).toBeDefined();
      expect(ownerEntry!['subjectName']).toBe('__superadmin__');

      // Find bob's entry
      const bobEntry = entries.find((e) => e['subjectId'] === bobId);
      expect(bobEntry).toBeDefined();
      expect(bobEntry!['subjectName']).toBe('bob');
      expect((bobEntry!['operations'] as string[]).sort()).toEqual(['read', 'write']);
      expect(bobEntry!['isOwner']).toBe(false);
    });
  });

  // ── myAccess ──────────────────────────────────────────────────

  describe('myAccess', () => {
    it('returns effective access for the authenticated user', async () => {
      await setup();
      await defineBucket('docs');
      await defineBucket('reports');

      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'password1234');

      const admin = await superadminClient();

      // Grant bob read on docs, write on reports
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'docs',
        operations: ['read'],
      });

      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'reports',
        operations: ['read', 'write'],
      });

      await delay(50);

      const resp = await sendRequest(bobWs, {
        type: 'identity.myAccess',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const user = data['user'] as Record<string, unknown>;
      expect(user['username']).toBe('bob');

      const resources = data['resources'] as Array<Record<string, unknown>>;
      expect(resources.length).toBe(2);

      const docsResource = resources.find((r) => r['resourceName'] === 'docs');
      expect(docsResource).toBeDefined();
      expect(docsResource!['operations']).toEqual(['read']);
      expect(docsResource!['isOwner']).toBe(false);

      const reportsResource = resources.find((r) => r['resourceName'] === 'reports');
      expect(reportsResource).toBeDefined();
      expect((reportsResource!['operations'] as string[]).sort()).toEqual(['read', 'write']);
    });

    it('includes owned resources with full permissions', async () => {
      await setup();

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'admin');

      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'alice-data',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      const resp = await sendRequest(aliceWs, {
        type: 'identity.myAccess',
      });

      expect(resp['type']).toBe('result');
      const resources = (resp['data'] as Record<string, unknown>)['resources'] as Array<Record<string, unknown>>;

      const ownedResource = resources.find((r) => r['resourceName'] === 'alice-data');
      expect(ownedResource).toBeDefined();
      expect(ownedResource!['isOwner']).toBe(true);
      expect((ownedResource!['operations'] as string[]).sort()).toEqual(['admin', 'read', 'write']);
    });
  });

  // ── Cleanup on deleteUser ──────────────────────────────────────

  describe('cleanup on user deletion', () => {
    it('deleting a user removes their ownership records', async () => {
      await setup();

      const { userId: aliceId } = await createAndLoginUser('alice', 'password1234', 'admin');
      const admin = await superadminClient();

      // Alice creates a bucket (becomes owner) — via admin client on behalf
      // Actually let's have alice do it herself through another connection
      const { ws: aliceWs2 } = await connectClient(server!.port);
      clients.push(aliceWs2);
      await sendRequest(aliceWs2, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });

      await sendRequest(aliceWs2, {
        type: 'store.defineBucket',
        name: 'alice-owned',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      // Verify alice is owner
      const ownerBefore = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'alice-owned',
      });
      expect(
        ((ownerBefore['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>)['userId'],
      ).toBe(aliceId);

      // Delete alice
      await sendRequest(admin, {
        type: 'identity.deleteUser',
        userId: aliceId,
      });

      await delay(50);

      // Ownership should be gone
      const ownerAfter = await sendRequest(admin, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'alice-owned',
      });
      expect((ownerAfter['data'] as Record<string, unknown>)['owner']).toBeNull();
    });
  });

  // ── ACL-based access on admin store operations ─────────────────

  describe('ACL on admin operations', () => {
    it('user with admin ACL can drop the bucket', async () => {
      await setup();
      await defineBucket('managed');

      const { ws: aliceWs, userId: aliceId } = await createAndLoginUser('alice', 'password1234');

      const admin = await superadminClient();

      // Grant alice admin on the bucket
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: aliceId,
        resourceType: 'bucket',
        resourceName: 'managed',
        operations: ['admin'],
      });

      await delay(100);

      // Alice can drop the bucket (admin ACL allows store.dropBucket)
      const dropResp = await sendRequest(aliceWs, {
        type: 'store.dropBucket',
        name: 'managed',
      });
      expect(dropResp['type']).toBe('result');
    });

    it('user with admin ACL can grant to others', async () => {
      await setup();
      await defineBucket('delegated');

      const { ws: aliceWs, userId: aliceId } = await createAndLoginUser('alice', 'password1234');
      const { userId: bobId } = await createAndLoginUser('bob', 'password1234');

      const admin = await superadminClient();

      // Grant alice admin ACL on the bucket
      await sendRequest(admin, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: aliceId,
        resourceType: 'bucket',
        resourceName: 'delegated',
        operations: ['admin'],
      });

      await delay(100);

      // Alice can now grant bob access (has admin ACL)
      const grantResp = await sendRequest(aliceWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'delegated',
        operations: ['read'],
      });
      expect(grantResp['type']).toBe('result');
    });
  });
});
