# Part 1: Introduction

This section explains why a WebSocket server exists and introduces the core concepts you'll use throughout the framework.

## Chapters

### [1.1 Why a WebSocket Server?](./01-why-websocket-server.md)

Learn why a dedicated WebSocket server makes sense for real-time applications:
- REST polling vs WebSocket push — latency and efficiency comparison
- The case for a protocol-first server with built-in routing
- How GenServer supervision provides reliability per connection

### [1.2 Key Concepts](./02-key-concepts.md)

Get an overview of the fundamental building blocks:
- **Protocol** - JSON-over-WebSocket, version 1.0.0
- **Request/Response** - Correlated messages with `id` field
- **Push** - Server-initiated messages on subscription and event channels
- **Connection Lifecycle** - Welcome, auth, operations, heartbeat, close
- **Glossary** - Key terms used throughout the documentation

## What You'll Learn

By the end of this section, you'll understand:
- Why WebSocket push is superior to REST polling for real-time data
- How the noex-server protocol structures communication
- What each layer of the server does
- The connection lifecycle from connect to disconnect

---

Start with: [Why a WebSocket Server?](./01-why-websocket-server.md)
