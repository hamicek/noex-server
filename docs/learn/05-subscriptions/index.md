# Part 5: Reactive Subscriptions

Subscribe to live query results that the server pushes automatically when data changes.

## Chapters

### [5.1 Subscribing to Queries](./01-subscribing.md)

Set up reactive subscriptions:
- Defining queries with `store.defineQuery()`
- Subscribing via `store.subscribe` message
- Receiving initial data and the `subscriptionId`

### [5.2 Push Updates](./02-push-updates.md)

Understand how mutations trigger push messages:
- Insert/update/delete causing re-evaluation
- `store.settle()` and when push messages arrive
- Scalar vs array query results in pushes

### [5.3 Parameterized Queries](./03-parameterized-queries.md)

Pass parameters to queries at subscription time:
- Defining queries with `params` argument
- Subscribing with `params` field
- Multiple clients with different parameters on the same query

### [5.4 Managing Subscriptions](./04-managing-subscriptions.md)

Control subscription lifecycle:
- Unsubscribing with `store.unsubscribe`
- Subscription limits per connection
- Automatic cleanup when a client disconnects

## What You'll Learn

By the end of this section, you'll be able to:
- Subscribe to live query results over WebSocket
- Understand when and why push messages arrive
- Use parameterized queries for personalized data streams
- Manage subscription lifecycle and cleanup

---

Start with: [Subscribing to Queries](./01-subscribing.md)
