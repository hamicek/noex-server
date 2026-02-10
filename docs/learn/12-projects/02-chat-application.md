# Chat Application

Build a multi-room chat system where messages are persisted in Store, typing indicators and read receipts flow through Rules, and all participants see updates in real time via push messages. This project combines Store CRUD, reactive subscriptions, rules integration, transactions, and multi-client push.

## What You'll Learn

- Multi-bucket design: rooms, messages, and participants
- Reactive queries scoped by room (parameterized subscriptions)
- Rules engine for ephemeral events (typing indicators, read receipts)
- Multi-client push: one user sends a message, all room participants see it
- Transactions for consistent state updates (create room + add first participant atomically)
- Combining Store subscriptions (persistent data) with Rules subscriptions (ephemeral events)

## Architecture Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│                       Chat Server                                   │
│                                                                     │
│  Store (persistent)               Rules (ephemeral)                │
│  ┌────────────────────┐           ┌────────────────────────┐       │
│  │ rooms              │           │ Events:                │       │
│  │   name, createdAt  │           │   chat.typing          │       │
│  │                    │           │   chat.read            │       │
│  │ messages           │           │   chat.presence        │       │
│  │   roomId, sender,  │           │                        │       │
│  │   content, sentAt  │           │ Facts:                 │       │
│  │                    │           │   user:<id>:status     │       │
│  │ participants       │           │   room:<id>:userCount  │       │
│  │   roomId, userId,  │           └────────────────────────┘       │
│  │   joinedAt         │                                            │
│  └────────────────────┘                                            │
│                                                                     │
│  Queries                          Subscriptions                    │
│  ┌────────────────────┐           ┌────────────────────────┐       │
│  │ room-messages(id)  │           │ Store: room-messages   │       │
│  │ room-list          │           │   → push on new msg    │       │
│  │ message-count(id)  │           │                        │       │
│  │ room-participants  │           │ Rules: chat.*          │       │
│  └────────────────────┘           │   → push on typing,   │       │
│                                   │     read receipts      │       │
│                                   └────────────────────────┘       │
│                                                                     │
│  Clients                                                           │
│  ┌──────┐  ┌──────┐  ┌──────┐                                     │
│  │ Alice│  │ Bob  │  │ Carol│                                     │
│  │ send │  │ recv │  │ recv │                                     │
│  │ type │  │ push │  │ push │                                     │
│  └──────┘  └──────┘  └──────┘                                     │
└────────────────────────────────────────────────────────────────────┘
```

## Complete Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'chat' });
  const engine = await RuleEngine.start({ name: 'chat-rules' });

  // ── Buckets ─────────────────────────────────────────────────────

  await store.defineBucket('rooms', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      name:      { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
    },
  });

  await store.defineBucket('messages', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      roomId:  { type: 'string', required: true },
      sender:  { type: 'string', required: true },
      content: { type: 'string', required: true },
      sentAt:  { type: 'number', required: true },
    },
  });

  await store.defineBucket('participants', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      roomId:   { type: 'string', required: true },
      userId:   { type: 'string', required: true },
      joinedAt: { type: 'number', required: true },
    },
  });

  // ── Queries ─────────────────────────────────────────────────────

  store.defineQuery('room-messages', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('messages').where({ roomId: params.roomId });
  });

  store.defineQuery('room-list', async (ctx) => {
    return ctx.bucket('rooms').all();
  });

  store.defineQuery('message-count', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('messages').count({ roomId: params.roomId });
  });

  store.defineQuery('room-participants', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('participants').where({ roomId: params.roomId });
  });

  // ── Server ──────────────────────────────────────────────────────

  const server = await NoexServer.start({
    port: 8080,
    store,
    rules: engine,
  });

  console.log(`Chat server listening on ws://localhost:${server.port}`);
}

main();
```

## Client Interaction: Multi-User Chat Flow

### Step 1: Create a Room with Transaction

Alice creates a room and joins it atomically:

```jsonc
// Alice → Server
{ "id": 1, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "rooms", "data": {
        "name": "General", "createdAt": 1706745600000
      }
    },
    { "op": "insert", "bucket": "participants", "data": {
        "roomId": "will-be-set-after", "userId": "alice", "joinedAt": 1706745600000
      }
    }
  ]
}

// Server → Alice
{ "id": 1, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "room-1", "name": "General",
        "createdAt": 1706745600000, "_version": 1 } },
    { "index": 1, "data": { "id": "p-1", "roomId": "will-be-set-after",
        "userId": "alice", "joinedAt": 1706745600000, "_version": 1 } }
  ] }
}
```

> **Note:** In a real application, you'd first insert the room to get its ID, then insert the participant with the correct `roomId`. Alternatively, use a client-generated UUID as the room ID.

A more practical approach — insert room first, then join:

```jsonc
// Alice → Server (create room)
{ "id": 1, "type": "store.insert", "bucket": "rooms", "data": {
    "name": "General", "createdAt": 1706745600000
  }
}

// Server → Alice
{ "id": 1, "type": "result", "data": { "id": "room-1", "name": "General",
    "createdAt": 1706745600000, "_version": 1 }
}

// Alice → Server (join the room)
{ "id": 2, "type": "store.insert", "bucket": "participants", "data": {
    "roomId": "room-1", "userId": "alice", "joinedAt": 1706745600000
  }
}

// Server → Alice
{ "id": 2, "type": "result", "data": { "id": "p-1", "roomId": "room-1",
    "userId": "alice", "joinedAt": 1706745600000, "_version": 1 }
}
```

### Step 2: Subscribe to Room Messages

Both Alice and Bob subscribe to messages in the "General" room:

```jsonc
// Alice → Server
{ "id": 3, "type": "store.subscribe", "query": "room-messages",
  "params": { "roomId": "room-1" } }

// Server → Alice (empty room, no messages yet)
{ "id": 3, "type": "result", "data": { "subscriptionId": "sub-1", "data": [] } }
```

```jsonc
// Bob → Server
{ "id": 1, "type": "store.subscribe", "query": "room-messages",
  "params": { "roomId": "room-1" } }

// Server → Bob
{ "id": 1, "type": "result", "data": { "subscriptionId": "sub-2", "data": [] } }
```

### Step 3: Subscribe to Typing Indicators (Rules)

Both clients subscribe to chat events for the room:

```jsonc
// Alice → Server
{ "id": 4, "type": "rules.subscribe", "pattern": "chat.*" }

// Server → Alice
{ "id": 4, "type": "result", "data": { "subscriptionId": "sub-3" } }
```

```jsonc
// Bob → Server
{ "id": 2, "type": "rules.subscribe", "pattern": "chat.*" }

// Server → Bob
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-4" } }
```

### Step 4: Alice Types — Typing Indicator

Alice emits a typing event through the rules engine:

```jsonc
// Alice → Server
{ "id": 5, "type": "rules.emit", "topic": "chat.typing", "data": {
    "roomId": "room-1", "userId": "alice", "isTyping": true
  }
}

// Server → Alice (emit result)
{ "id": 5, "type": "result", "data": {
    "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
    "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
  }
}
```

Both Alice and Bob receive the typing event as a push:

```jsonc
// Server → Alice (push on rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "chat.typing",
    "event": {
      "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
      "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
    }
  }
}

// Server → Bob (push on rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-4", "data": {
    "topic": "chat.typing",
    "event": {
      "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
      "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
    }
  }
}
```

### Step 5: Alice Sends a Message

```jsonc
// Alice → Server
{ "id": 6, "type": "store.insert", "bucket": "messages", "data": {
    "roomId": "room-1", "sender": "alice", "content": "Hello everyone!", "sentAt": 1706745615000
  }
}

// Server → Alice (insert result)
{ "id": 6, "type": "result", "data": {
    "id": "msg-1", "roomId": "room-1", "sender": "alice",
    "content": "Hello everyone!", "sentAt": 1706745615000, "_version": 1
  }
}
```

After `store.settle()`, both subscribers receive the updated message list:

```jsonc
// Server → Alice (push on room-messages subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "msg-1", "roomId": "room-1", "sender": "alice",
      "content": "Hello everyone!", "sentAt": 1706745615000, "_version": 1 }
  ]
}

// Server → Bob (push on room-messages subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "msg-1", "roomId": "room-1", "sender": "alice",
      "content": "Hello everyone!", "sentAt": 1706745615000, "_version": 1 }
  ]
}
```

### Step 6: Bob Reads — Read Receipt

Bob emits a read receipt through rules:

```jsonc
// Bob → Server
{ "id": 3, "type": "rules.emit", "topic": "chat.read", "data": {
    "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1"
  }
}

// Server → Bob
{ "id": 3, "type": "result", "data": {
    "id": "evt-2", "topic": "chat.read", "timestamp": 1706745620000,
    "data": { "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1" }
  }
}
```

Alice receives the read receipt:

```jsonc
// Server → Alice (push on rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "chat.read",
    "event": {
      "id": "evt-2", "topic": "chat.read", "timestamp": 1706745620000,
      "data": { "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1" }
    }
  }
}
```

### Step 7: Track Presence with Facts

Use rules facts to track online/offline status:

```jsonc
// Alice → Server (set online status)
{ "id": 7, "type": "rules.setFact", "key": "user:alice:status", "value": "online" }

// Server → Alice
{ "id": 7, "type": "result", "data": { "key": "user:alice:status", "value": "online" } }
```

Any client can query who is online:

```jsonc
// Bob → Server
{ "id": 4, "type": "rules.queryFacts", "pattern": "user:*:status" }

// Server → Bob
{ "id": 4, "type": "result", "data": [
    { "key": "user:alice:status", "value": "online" }
  ]
}
```

## Detailed Breakdown

### Two Push Channels

The chat app uses both push channels simultaneously:

| Channel | Source | Use Case | Data Shape |
|---------|--------|----------|------------|
| `subscription` | Store queries | Message lists, room lists, participant lists | Full query result (array or scalar) |
| `event` | Rules engine | Typing indicators, read receipts, presence | `{ topic, event }` |

Store subscriptions deliver the **complete current state** of a query (the full message list). Rules subscriptions deliver **individual events** as they happen (each typing indicator separately). This distinction is fundamental:

- **Store push**: "Here are all messages in the room right now" (replaces previous state)
- **Rules push**: "Alice just started typing" (additive event)

### Parameterized Queries

The `room-messages` query takes a `roomId` parameter. Each subscription is independent — subscribing to `room-messages({ roomId: 'room-1' })` and `room-messages({ roomId: 'room-2' })` creates two separate subscriptions with different data. A message inserted into room-1 only triggers a push for the room-1 subscription.

### Why Rules for Typing Indicators?

Typing indicators are ephemeral — they don't need to be persisted. Using `rules.emit` broadcasts the event to all subscribers without writing to the Store. If you stored typing status in a bucket, every keystroke would trigger a write + query re-evaluation + push, which is unnecessarily expensive.

Rules facts (`user:alice:status`) are appropriate for semi-persistent state like presence because they can be queried on demand but don't clutter the Store.

### Transaction Patterns

For operations that must be consistent, use transactions:

```jsonc
// Delete a room: remove all messages, participants, and the room itself
{ "id": 10, "type": "store.transaction", "operations": [
    { "op": "where", "bucket": "messages", "filter": { "roomId": "room-1" } },
    { "op": "where", "bucket": "participants", "filter": { "roomId": "room-1" } },
    { "op": "delete", "bucket": "rooms", "key": "room-1" }
  ]
}
```

The `where` operations within the transaction read the data, and the `delete` removes the room — all atomically. To delete the messages and participants too, you'd need individual delete operations for each record (transactions don't support bulk delete).

## Exercise

Extend the chat system with:

1. A `message-count` subscription per room — display "42 messages" in the room list
2. An "unread count" feature using rules facts: when Alice sends a message, set `room:room-1:unread:bob` fact; when Bob reads, delete the fact
3. A `chat.presence` event emitted when a user connects or disconnects

<details>
<summary>Solution</summary>

**Message count subscription (already defined in the server setup):**

```jsonc
// Bob → Server
{ "id": 5, "type": "store.subscribe", "query": "message-count",
  "params": { "roomId": "room-1" } }

// Server → Bob (initial count)
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-5", "data": 3 } }

// After Alice sends a new message:
// Server → Bob (push with updated count)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-5", "data": 4 }
```

**Unread count with facts:**

When Alice sends a message, she also sets unread facts for other participants:

```jsonc
// Alice → Server (mark unread for Bob)
{ "id": 8, "type": "rules.setFact", "key": "room:room-1:unread:bob", "value": 1 }
```

Bob queries his unread rooms:

```jsonc
// Bob → Server
{ "id": 6, "type": "rules.queryFacts", "pattern": "room:*:unread:bob" }

// Server → Bob
{ "id": 6, "type": "result", "data": [
    { "key": "room:room-1:unread:bob", "value": 1 }
  ]
}
```

When Bob reads, clear the unread fact:

```jsonc
// Bob → Server
{ "id": 7, "type": "rules.deleteFact", "key": "room:room-1:unread:bob" }

// Server → Bob
{ "id": 7, "type": "result", "data": { "deleted": true } }
```

**Presence events:**

```jsonc
// When user connects:
{ "id": 1, "type": "rules.emit", "topic": "chat.presence", "data": {
    "userId": "bob", "status": "online"
  }
}

// When user is about to disconnect:
{ "id": 99, "type": "rules.emit", "topic": "chat.presence", "data": {
    "userId": "bob", "status": "offline"
  }
}
```

All clients subscribed to `chat.*` receive presence pushes on the `event` channel.

</details>

## Summary

- **Two push channels**: Store subscriptions for persistent data (messages, rooms), Rules subscriptions for ephemeral events (typing, read receipts)
- **Parameterized queries**: `room-messages({ roomId })` scopes each subscription to a single room
- **Rules for ephemeral data**: `rules.emit` broadcasts without Store writes — ideal for typing indicators
- **Rules facts for presence**: `user:<id>:status` can be set, queried, and deleted without a bucket
- **Transactions**: Atomic multi-operation updates for consistent room creation and teardown
- **Multi-client push**: Any client's mutation triggers pushes to all other clients with matching subscriptions

---

Next: [E-Commerce Backend](./03-ecommerce-backend.md)
