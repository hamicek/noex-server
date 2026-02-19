/**
 * 07 — Dynamic Permissions
 *
 * Demonstrates the dynamic permission system: custom roles,
 * per-resource ACL, ownership, and grant delegation.
 *
 * Run:
 *   npx tsx examples/07-dynamic-permissions.example.ts
 */

import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../src/index.js';
import { NoexClient } from '@hamicek/noex-client';

const ADMIN_SECRET = 'dynamic-perms-secret';

async function main() {
  // ── 1. Start server ─────────────────────────────────────────────

  const store = await Store.start({ name: 'permissions-demo' });
  const server = await NoexServer.start({
    store,
    port: 0,
    host: '127.0.0.1',
    auth: { builtIn: true, adminSecret: ADMIN_SECRET },
  });

  const url = `ws://127.0.0.1:${server.port}`;
  console.log(`Server started on port ${server.port}`);

  // ── 2. Bootstrap ────────────────────────────────────────────────

  const admin = new NoexClient(url);
  await admin.connect();
  await admin.identity.loginWithSecret(ADMIN_SECRET);

  // ── 3. Create a custom role with bucket constraints ─────────────

  const accountantRole = await admin.identity.createRole({
    name: 'accountant',
    description: 'Can read all buckets but write only to invoices',
    permissions: [
      { allow: ['store.get', 'store.all', 'store.where', 'store.findOne', 'store.count', 'store.buckets'] },
      { allow: ['store.insert', 'store.update', 'store.delete'], buckets: ['invoices'] },
    ],
  });
  console.log('Created custom role:', accountantRole.name);

  // ── 4. Define buckets ───────────────────────────────────────────

  await admin.store.defineBucket('invoices', {
    key: 'id',
    schema: {
      id: { type: 'string', auto: 'uuid' },
      amount: { type: 'number' },
      client: { type: 'string' },
    },
  });

  await admin.store.defineBucket('secrets', {
    key: 'id',
    schema: {
      id: { type: 'string', auto: 'uuid' },
      data: { type: 'string' },
    },
  });

  // ── 5. Create users with different roles ────────────────────────

  const alice = await admin.identity.createUser({ username: 'alice', password: 'AlicePass12' });
  await admin.identity.assignRole(alice.id, 'accountant');

  const bob = await admin.identity.createUser({ username: 'bob', password: 'BobPass1234' });
  // Bob has NO role — will rely on ACL grants

  // Small delay for cache
  await delay(50);

  // ── 6. Verify role-based constraints ────────────────────────────

  const aliceClient = new NoexClient(url);
  await aliceClient.connect();
  await aliceClient.identity.login('alice', 'AlicePass12');

  // Alice (accountant) can insert into invoices
  await aliceClient.store.insert('invoices', { amount: 1500, client: 'Acme Corp' });
  console.log('Alice inserted into invoices');

  // Alice can READ secrets (read is unrestricted)
  const secretsRead = await aliceClient.store.all('secrets');
  console.log('Alice read secrets (empty):', secretsRead);

  // Alice CANNOT write to secrets (bucket constraint)
  try {
    await aliceClient.store.insert('secrets', { data: 'stolen' });
  } catch (err) {
    console.log('Alice cannot write to secrets:', (err as Error).message);
  }

  // ── 7. Ownership: superadmin is owner of both buckets ───────────

  const invoiceOwner = await admin.identity.getOwner('bucket', 'invoices');
  console.log('Invoice bucket owner:', invoiceOwner?.username);

  // ── 8. Per-resource ACL: grant Bob read on invoices only ────────

  const bobClient = new NoexClient(url);
  await bobClient.connect();
  await bobClient.identity.login('bob', 'BobPass1234');

  // Bob cannot read anything (no role)
  try {
    await bobClient.store.all('invoices');
  } catch (err) {
    console.log('Bob denied (no role):', (err as Error).message);
  }

  // Superadmin grants Bob read access to invoices
  await admin.identity.grant({
    subjectType: 'user',
    subjectId: bob.id,
    resourceType: 'bucket',
    resourceName: 'invoices',
    operations: ['read'],
  });

  await delay(100);

  // Now Bob can read invoices
  const bobInvoices = await bobClient.store.all('invoices');
  console.log('Bob reads invoices:', bobInvoices.length, 'records');

  // But Bob still cannot write
  try {
    await bobClient.store.insert('invoices', { amount: 0, client: 'hack' });
  } catch (err) {
    console.log('Bob cannot write to invoices:', (err as Error).message);
  }

  // Bob still cannot read secrets (no ACL for secrets)
  try {
    await bobClient.store.all('secrets');
  } catch (err) {
    console.log('Bob cannot read secrets:', (err as Error).message);
  }

  // ── 9. Ownership transfer and delegation ────────────────────────

  // Transfer invoice bucket ownership to Alice
  await admin.identity.transferOwner('bucket', 'invoices', alice.id);
  console.log('Transferred invoices ownership to Alice');

  await delay(50);

  // Alice (new owner) can now grant Bob write access
  await aliceClient.identity.grant({
    subjectType: 'user',
    subjectId: bob.id,
    resourceType: 'bucket',
    resourceName: 'invoices',
    operations: ['write'],
  });
  console.log('Alice granted Bob write on invoices');

  await delay(100);

  // Bob can now write
  await bobClient.store.insert('invoices', { amount: 200, client: 'Bob Co' });
  console.log('Bob inserted into invoices');

  // ── 10. Revoke access ───────────────────────────────────────────

  await aliceClient.identity.revoke({
    subjectType: 'user',
    subjectId: bob.id,
    resourceType: 'bucket',
    resourceName: 'invoices',
    operations: ['write'],
  });
  console.log('Alice revoked Bob write');

  await delay(100);

  // Bob can still read (only write was revoked)
  const bobReadAfter = await bobClient.store.all('invoices');
  console.log('Bob reads after revoke:', bobReadAfter.length, 'records');

  // But cannot write
  try {
    await bobClient.store.insert('invoices', { amount: 0, client: 'denied' });
  } catch (err) {
    console.log('Bob write denied after revoke:', (err as Error).message);
  }

  // ── 11. Effective access check ──────────────────────────────────

  const aliceAccess = await aliceClient.identity.myAccess();
  console.log('\nAlice effective access:');
  for (const r of aliceAccess.resources) {
    console.log(`  ${r.resourceType}:${r.resourceName} → [${r.operations.join(', ')}] owner=${r.isOwner}`);
  }

  const bobAccess = await bobClient.identity.myAccess();
  console.log('\nBob effective access:');
  for (const r of bobAccess.resources) {
    console.log(`  ${r.resourceType}:${r.resourceName} → [${r.operations.join(', ')}] owner=${r.isOwner}`);
  }

  // ── 12. Role-based ACL (grant to a role, not individual user) ──

  // Grant reader role read on secrets
  const roles = await admin.identity.listRoles();
  const readerRole = roles.find((r) => r.name === 'reader');
  if (readerRole) {
    await admin.identity.grant({
      subjectType: 'role',
      subjectId: readerRole.id,
      resourceType: 'bucket',
      resourceName: 'secrets',
      operations: ['read'],
    });
    console.log('\nGranted reader role read on secrets');

    // Create a user with reader role
    const charlie = await admin.identity.createUser({ username: 'charlie', password: 'CharlieP12' });
    await admin.identity.assignRole(charlie.id, 'reader');

    await delay(100);

    const charlieClient = new NoexClient(url);
    await charlieClient.connect();
    await charlieClient.identity.login('charlie', 'CharlieP12');

    const charlieSecrets = await charlieClient.store.all('secrets');
    console.log('Charlie (reader) reads secrets via role ACL:', charlieSecrets.length, 'records');

    await charlieClient.disconnect();
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  await admin.disconnect();
  await aliceClient.disconnect();
  await bobClient.disconnect();
  await server.stop();
  await store.stop();

  console.log('\nDone.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
