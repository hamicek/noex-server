import type { Store } from '@hamicek/noex-store';
import type { BucketDefinition } from '@hamicek/noex-store';
import { SYSTEM_BUCKET_NAMES } from './identity-types.js';

// ── Bucket Definitions ───────────────────────────────────────────

export const USERS_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:           { type: 'string', generated: 'uuid' },
    username:     { type: 'string', required: true, unique: true, minLength: 3, maxLength: 64 },
    passwordHash: { type: 'string', required: true },
    displayName:  { type: 'string' },
    email:        { type: 'string', format: 'email' },
    enabled:      { type: 'boolean', default: true },
    metadata:     { type: 'object' },
  },
  indexes: ['username', 'email'],
};

export const ROLES_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:          { type: 'string', generated: 'uuid' },
    name:        { type: 'string', required: true, unique: true, minLength: 1, maxLength: 64 },
    description: { type: 'string' },
    system:      { type: 'boolean', default: false },
    permissions: { type: 'array' },
  },
  indexes: ['name'],
};

export const USER_ROLES_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    userId:    { type: 'string', required: true, ref: '_users' },
    roleId:    { type: 'string', required: true, ref: '_roles' },
    grantedBy: { type: 'string', ref: '_users' },
    grantedAt: { type: 'number', generated: 'timestamp' },
  },
  indexes: ['userId', 'roleId'],
};

export const ACL_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:           { type: 'string', generated: 'uuid' },
    subjectType:  { type: 'string', required: true, enum: ['user', 'role'] },
    subjectId:    { type: 'string', required: true },
    resourceType: { type: 'string', required: true, enum: ['bucket', 'topic', 'procedure', 'query'] },
    resourceName: { type: 'string', required: true },
    operations:   { type: 'array', required: true },
    grantedBy:    { type: 'string', ref: '_users' },
    grantedAt:    { type: 'number', generated: 'timestamp' },
  },
  indexes: ['subjectId', 'resourceName'],
};

export const SESSIONS_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    userId:    { type: 'string', required: true, ref: '_users' },
    expiresAt: { type: 'number', required: true },
    createdAt: { type: 'number', generated: 'timestamp' },
    ip:        { type: 'string' },
    userAgent: { type: 'string' },
  },
  indexes: ['userId'],
  ttl: '24h',
};

export const RESOURCE_OWNERS_BUCKET: BucketDefinition = {
  key: 'id',
  schema: {
    id:           { type: 'string', generated: 'uuid' },
    userId:       { type: 'string', required: true, ref: '_users' },
    resourceType: { type: 'string', required: true, enum: ['bucket', 'topic', 'procedure', 'query'] },
    resourceName: { type: 'string', required: true },
    createdAt:    { type: 'number', generated: 'timestamp' },
  },
  indexes: ['userId', 'resourceName'],
};

const BUCKET_MAP: Record<string, BucketDefinition> = {
  '_users':           USERS_BUCKET,
  '_roles':           ROLES_BUCKET,
  '_user_roles':      USER_ROLES_BUCKET,
  '_acl':             ACL_BUCKET,
  '_sessions':        SESSIONS_BUCKET,
  '_resource_owners': RESOURCE_OWNERS_BUCKET,
};

// ── ensureSystemBuckets ──────────────────────────────────────────

/**
 * Creates all system buckets if they don't already exist.
 * Idempotent — safe to call on every server start.
 */
export async function ensureSystemBuckets(store: Store): Promise<void> {
  for (const name of SYSTEM_BUCKET_NAMES) {
    if (!store.hasBucket(name)) {
      await store.defineBucket(name, BUCKET_MAP[name]!);
    }
  }
}
