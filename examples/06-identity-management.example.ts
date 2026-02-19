/**
 * 06 — Identity Management
 *
 * Demonstrates the built-in identity system: bootstrap login,
 * user creation, role assignment, and session management.
 *
 * Run:
 *   npx tsx examples/06-identity-management.example.ts
 */

import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../src/index.js';
import { NoexClient } from '@hamicek/noex-client';

const ADMIN_SECRET = 'my-super-secret-key';

async function main() {
  // ── 1. Start server with built-in identity ──────────────────────

  const store = await Store.start({ name: 'identity-demo' });
  const server = await NoexServer.start({
    store,
    port: 0,
    host: '127.0.0.1',
    auth: { builtIn: true, adminSecret: ADMIN_SECRET },
  });

  console.log(`Server started on port ${server.port}`);

  // ── 2. Bootstrap: login with admin secret ───────────────────────

  const admin = new NoexClient(`ws://127.0.0.1:${server.port}`);
  await admin.connect();
  await admin.identity.loginWithSecret(ADMIN_SECRET);

  const whoami = await admin.identity.whoami();
  console.log('Logged in as:', whoami);

  // ── 3. Create users ─────────────────────────────────────────────

  const alice = await admin.identity.createUser({
    username: 'alice',
    password: 'AliceSecure1',
    displayName: 'Alice Johnson',
  });
  console.log('Created user:', alice.username, alice.id);

  const bob = await admin.identity.createUser({
    username: 'bob',
    password: 'BobSecure123',
    displayName: 'Bob Smith',
  });
  console.log('Created user:', bob.username, bob.id);

  // ── 4. Assign roles ─────────────────────────────────────────────

  await admin.identity.assignRole(alice.id, 'admin');
  await admin.identity.assignRole(bob.id, 'writer');

  const aliceRoles = await admin.identity.getUserRoles(alice.id);
  console.log('Alice roles:', aliceRoles.map((r) => r.name));

  const bobRoles = await admin.identity.getUserRoles(bob.id);
  console.log('Bob roles:', bobRoles.map((r) => r.name));

  // ── 5. Define a bucket for the application ──────────────────────

  await admin.store.defineBucket('articles', {
    key: 'id',
    schema: {
      id: { type: 'string', auto: 'uuid' },
      title: { type: 'string' },
      author: { type: 'string' },
    },
  });

  // ── 6. Alice logs in on her own connection ──────────────────────

  const aliceClient = new NoexClient(`ws://127.0.0.1:${server.port}`);
  await aliceClient.connect();
  const aliceLogin = await aliceClient.identity.login('alice', 'AliceSecure1');
  console.log('Alice logged in, token:', aliceLogin.token.slice(0, 8) + '...');

  // Alice (admin) can define more buckets
  await aliceClient.store.defineBucket('comments', {
    key: 'id',
    schema: { id: { type: 'string', auto: 'uuid' }, text: { type: 'string' } },
  });
  console.log('Alice defined "comments" bucket');

  // ── 7. Bob logs in and writes data ──────────────────────────────

  const bobClient = new NoexClient(`ws://127.0.0.1:${server.port}`);
  await bobClient.connect();
  await bobClient.identity.login('bob', 'BobSecure123');

  await bobClient.store.insert('articles', {
    title: 'Hello World',
    author: 'bob',
  });
  console.log('Bob inserted an article');

  // Bob cannot define buckets (writer role)
  try {
    await bobClient.store.defineBucket('hacked', {
      key: 'id',
      schema: { id: { type: 'string', auto: 'uuid' } },
    });
  } catch (err) {
    console.log('Bob cannot define buckets:', (err as Error).message);
  }

  // ── 8. Session management ───────────────────────────────────────

  // Refresh Alice's session
  const refreshed = await aliceClient.identity.refreshSession();
  console.log('Alice refreshed session, new token:', refreshed.token.slice(0, 8) + '...');

  // List all users (admin only)
  const users = await aliceClient.identity.listUsers();
  console.log('All users:', users.users.map((u) => u.username));

  // ── 9. Password management ─────────────────────────────────────

  // Bob changes his own password
  await bobClient.identity.changePassword(bob.id, 'BobSecure123', 'NewBobPass1');
  console.log('Bob changed password');

  // Admin resets a password (no current password needed)
  await admin.identity.resetPassword(bob.id, 'ResetByAdmin');
  console.log('Admin reset Bob password');

  // ── 10. User lifecycle: disable / enable ────────────────────────

  await admin.identity.disableUser(bob.id);
  console.log('Bob disabled');

  // Bob's new login attempt would fail
  const bobClient2 = new NoexClient(`ws://127.0.0.1:${server.port}`);
  await bobClient2.connect();
  try {
    await bobClient2.identity.login('bob', 'ResetByAdmin');
  } catch (err) {
    console.log('Disabled Bob cannot login:', (err as Error).message);
  }

  await admin.identity.enableUser(bob.id);
  console.log('Bob re-enabled');

  // ── 11. Logout ──────────────────────────────────────────────────

  await aliceClient.identity.logout();
  console.log('Alice logged out');

  // ── Cleanup ─────────────────────────────────────────────────────

  await admin.disconnect();
  await aliceClient.disconnect();
  await bobClient.disconnect();
  await bobClient2.disconnect();
  await server.stop();
  await store.stop();

  console.log('\nDone.');
}

main().catch(console.error);
