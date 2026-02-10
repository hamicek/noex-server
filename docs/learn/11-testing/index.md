# Part 11: Testing

Strategies and helpers for testing WebSocket server applications.

## Chapters

### [11.1 Test Setup](./01-test-setup.md)

Set up a reliable test environment:
- `port: 0` for random port assignment
- `host: '127.0.0.1'` for local-only binding
- `sendRequest` and `waitForPush` helpers
- Proper cleanup with `server.stop()` in `afterEach`

### [11.2 Testing Subscriptions and Auth](./02-testing-subscriptions-auth.md)

Test complex scenarios:
- Subscription setup and `waitForPush` patterns
- `store.settle()` — wait for query re-evaluation before asserting
- Multi-client tests with auth tokens
- Push listener ordering: always set up BEFORE the triggering mutation

## What You'll Learn

By the end of this section, you'll be able to:
- Set up isolated, non-flaky test environments
- Write reliable tests for subscriptions and push messages
- Test authentication and permission flows with multiple clients

---

Start with: [Test Setup](./01-test-setup.md)
