# Part 7: Rules Integration

Connect the noex-rules engine to the server and use events, facts, and rule subscriptions over WebSocket.

## Chapters

### [7.1 Setup](./01-setup.md)

Enable the rules engine on the server:
- Installing `@hamicek/noex-rules`
- Passing the engine to `NoexServer.start({ rules })`
- What happens when rules are not configured (`RULES_NOT_AVAILABLE`)

### [7.2 Events and Facts](./02-events-facts.md)

Work with events and facts over the protocol:
- `rules.emit` — emit events into the engine
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` — fact CRUD
- `rules.queryFacts` / `rules.getAllFacts` — fact queries with patterns

### [7.3 Rules Subscriptions](./03-rules-subscriptions.md)

Subscribe to rule engine matches:
- `rules.subscribe` with a pattern
- Push messages on the `event` channel
- `rules.unsubscribe` and cleanup

## What You'll Learn

By the end of this section, you'll be able to:
- Connect a noex-rules engine to the server
- Emit events and manage facts over WebSocket
- Subscribe to rule engine matches and receive push updates

---

Start with: [Setup](./01-setup.md)
