# Learning noex-server

A comprehensive guide for Node.js developers who want to build real-time applications with WebSocket servers. This guide teaches you the protocol, store operations, reactive subscriptions, and production-ready patterns — all backed by GenServer supervision.

## Who Is This For?

- Node.js / TypeScript developers (intermediate+)
- You know async/await and basic WebSocket concepts
- Familiarity with [@hamicek/noex-store](https://github.com/hamicek/noex-store) is helpful but not required
- You want a structured WebSocket server with CRUD, subscriptions, transactions, and auth

## Learning Path

### Part 1: Introduction

Understand why a WebSocket server and what problems it solves.

| Chapter | Description |
|---------|-------------|
| [1.1 Why a WebSocket Server?](./01-introduction/01-why-websocket-server.md) | Comparison with REST, real-time push, and the case for a protocol-first server |
| [1.2 Key Concepts](./01-introduction/02-key-concepts.md) | Protocol, request/response/push model, connection lifecycle, glossary |

### Part 2: Getting Started

Set up your first server and connect a client.

| Chapter | Description |
|---------|-------------|
| [2.1 Your First Server](./02-getting-started/01-first-server.md) | Installation, creating a Store, `NoexServer.start()`, ServerConfig |
| [2.2 Connecting a Client](./02-getting-started/02-connecting-client.md) | WebSocket client, welcome message, sendRequest helper |
| [2.3 Configuration](./02-getting-started/03-configuration.md) | All ServerConfig fields with default values |

### Part 3: The Protocol

Master the JSON-over-WebSocket protocol.

| Chapter | Description |
|---------|-------------|
| [3.1 Message Format](./03-protocol/01-message-format.md) | JSON-over-WebSocket, message types, protocol version |
| [3.2 Request and Response](./03-protocol/02-request-response.md) | Correlation via `id`, routing `store.*`/`rules.*`/`auth.*` |
| [3.3 Push Messages](./03-protocol/03-push-messages.md) | Push channels (subscription, event), subscriptionId |
| [3.4 Error Handling](./03-protocol/04-error-handling.md) | All 15 error codes with recovery actions |

### Part 4: Store CRUD Operations

Work with records through the WebSocket protocol.

| Chapter | Description |
|---------|-------------|
| [4.1 Basic CRUD](./04-store-crud/01-basic-crud.md) | insert, get, update, delete lifecycle |
| [4.2 Queries and Filtering](./04-store-crud/02-queries-filtering.md) | all, where, findOne, count |
| [4.3 Pagination and Aggregations](./04-store-crud/03-pagination-aggregations.md) | first, last, paginate, sum/avg/min/max |
| [4.4 Metadata and Stats](./04-store-crud/04-metadata-stats.md) | buckets, stats, clear |

### Part 5: Reactive Subscriptions

Subscribe to live query results pushed by the server.

| Chapter | Description |
|---------|-------------|
| [5.1 Subscribing to Queries](./05-subscriptions/01-subscribing.md) | defineQuery, store.subscribe, initial data |
| [5.2 Push Updates](./05-subscriptions/02-push-updates.md) | Mutations triggering push, settle(), scalar vs array |
| [5.3 Parameterized Queries](./05-subscriptions/03-parameterized-queries.md) | Queries with parameters |
| [5.4 Managing Subscriptions](./05-subscriptions/04-managing-subscriptions.md) | unsubscribe, limits, cleanup on disconnect |

### Part 6: Store Transactions

Execute multiple operations atomically.

| Chapter | Description |
|---------|-------------|
| [6.1 Atomic Operations](./06-transactions/01-atomic-operations.md) | store.transaction, operations array, all-or-nothing |
| [6.2 Transaction Patterns](./06-transactions/02-transaction-patterns.md) | Cross-bucket, read-modify-write, error handling |

### Part 7: Rules Integration

Connect the noex-rules engine to the server.

| Chapter | Description |
|---------|-------------|
| [7.1 Setup](./07-rules/01-setup.md) | Installing noex-rules, `NoexServer.start({ rules })` |
| [7.2 Events and Facts](./07-rules/02-events-facts.md) | emit, setFact, getFact, deleteFact, queryFacts |
| [7.3 Rules Subscriptions](./07-rules/03-rules-subscriptions.md) | subscribe with pattern, event push channel |

### Part 8: Authentication

Secure your server with token-based auth and permissions.

| Chapter | Description |
|---------|-------------|
| [8.1 Token Authentication](./08-authentication/01-token-auth.md) | AuthConfig, validate, auth.login flow |
| [8.2 Permissions](./08-authentication/02-permissions.md) | PermissionConfig.check, FORBIDDEN, role-based access |
| [8.3 Session Lifecycle](./08-authentication/03-session-lifecycle.md) | whoami, logout, expiration, re-auth |

### Part 9: Connection Lifecycle

Understand the server's internal architecture.

| Chapter | Description |
|---------|-------------|
| [9.1 Architecture](./09-connection-lifecycle/01-architecture.md) | GenServer per WebSocket, ConnectionSupervisor tree |
| [9.2 Connection Registry](./09-connection-lifecycle/02-registry.md) | ConnectionInfo, getConnections, stats |
| [9.3 Graceful Shutdown](./09-connection-lifecycle/03-graceful-shutdown.md) | server.stop(), shutdown sequence, system message |

### Part 10: Resilience

Production-ready patterns for reliability.

| Chapter | Description |
|---------|-------------|
| [10.1 Rate Limiting](./10-resilience/01-rate-limiting.md) | Sliding window, RATE_LIMITED, retryAfterMs |
| [10.2 Heartbeat](./10-resilience/02-heartbeat.md) | Ping/pong, timeout, close code 4001 |
| [10.3 Backpressure](./10-resilience/03-backpressure.md) | maxBufferedBytes, highWaterMark, dropped pushes |

### Part 11: Testing

Test strategies for WebSocket servers.

| Chapter | Description |
|---------|-------------|
| [11.1 Test Setup](./11-testing/01-test-setup.md) | port:0, helpers, cleanup, Vitest |
| [11.2 Testing Subscriptions and Auth](./11-testing/02-testing-subscriptions-auth.md) | waitForPush, settle(), multi-client tests |

### Part 12: Projects

Apply everything in real-world projects.

| Chapter | Description |
|---------|-------------|
| [12.1 Real-time Dashboard](./12-projects/01-realtime-dashboard.md) | Live metrics, reactive queries, permissions |
| [12.2 Chat Application](./12-projects/02-chat-application.md) | Store + rules, multi-client push, transactions |
| [12.3 E-Commerce Backend](./12-projects/03-ecommerce-backend.md) | All features together, production config |

## Chapter Format

Each chapter includes:

1. **What You'll Learn** - Key takeaways upfront
2. **Theory** - Concept explanation with diagrams and comparison tables
3. **Working Examples** - Complete runnable code (server setup + WebSocket JSON messages)
4. **Exercise** - Practical task with solution
5. **Summary** - Key takeaways
6. **Next Steps** - Link to next chapter

---

Ready to start? Begin with [Why a WebSocket Server?](./01-introduction/01-why-websocket-server.md)
