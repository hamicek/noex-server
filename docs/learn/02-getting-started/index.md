# Part 2: Getting Started

Set up your first noex-server, connect a WebSocket client, and explore the configuration options.

## Chapters

### [2.1 Your First Server](./01-first-server.md)

Get a server running in under a minute:
- Installing `@hamicek/noex-server` and peer dependencies
- Creating a Store with buckets and queries
- Starting the server with `NoexServer.start()`

### [2.2 Connecting a Client](./02-connecting-client.md)

Connect from any WebSocket client and send your first request:
- Opening a WebSocket connection
- Receiving the `welcome` message
- Building a `sendRequest` helper for request/response correlation

### [2.3 Configuration](./03-configuration.md)

Understand every configuration field:
- `ServerConfig` interface with defaults
- Port, host, path, payload limits
- Feature toggles: auth, rate limiting, heartbeat, backpressure

## What You'll Learn

By the end of this section, you'll be able to:
- Start a noex-server with a configured Store
- Connect a WebSocket client and exchange JSON messages
- Customize server behavior through configuration

---

Start with: [Your First Server](./01-first-server.md)
