# Part 9: Connection Lifecycle

Understand the server's internal architecture — how connections are supervised, tracked, and shut down.

## Chapters

### [9.1 Architecture](./01-architecture.md)

How the server is structured internally:
- GenServer per WebSocket connection
- `ConnectionSupervisor` with `simple_one_for_one` strategy
- Temporary restart strategy — crashed connections are cleaned up, not restarted

### [9.2 Connection Registry](./02-registry.md)

Inspect active connections:
- `server.getConnections()` — per-connection metadata
- `server.getStats()` — aggregated server statistics
- `server.connectionCount` and `server.isRunning`

### [9.3 Graceful Shutdown](./03-graceful-shutdown.md)

Stop the server cleanly:
- `server.stop({ gracePeriodMs })` — notify clients and wait
- Shutdown system message sent to all connections
- Subscription cleanup and connection close sequence

## What You'll Learn

By the end of this section, you'll understand:
- How GenServer supervision makes each connection independent and fault-tolerant
- How to inspect connections and server state at runtime
- How graceful shutdown works with client notification

---

Start with: [Architecture](./01-architecture.md)
