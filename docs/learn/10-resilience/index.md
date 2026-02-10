# Part 10: Resilience

Production-ready patterns for rate limiting, connection health monitoring, and write-buffer management.

## Chapters

### [10.1 Rate Limiting](./01-rate-limiting.md)

Protect the server from excessive requests:
- Sliding window algorithm
- `RATE_LIMITED` error with `retryAfterMs`
- Key: userId for authenticated, IP for anonymous

### [10.2 Heartbeat](./02-heartbeat.md)

Detect dead connections:
- Server-initiated ping/pong protocol
- Configurable interval and timeout
- Close code `4001` for unresponsive clients

### [10.3 Backpressure](./03-backpressure.md)

Handle slow clients without running out of memory:
- `maxBufferedBytes` — write buffer limit
- `highWaterMark` — pause push at percentage threshold
- What happens to push messages when backpressure kicks in

## What You'll Learn

By the end of this section, you'll understand:
- How rate limiting protects against abuse
- How heartbeat detects and cleans up dead connections
- How backpressure prevents memory exhaustion from slow consumers

---

Start with: [Rate Limiting](./01-rate-limiting.md)
