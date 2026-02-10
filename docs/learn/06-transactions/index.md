# Part 6: Store Transactions

Execute multiple store operations atomically — all succeed or all fail.

## Chapters

### [6.1 Atomic Operations](./01-atomic-operations.md)

Learn how transactions work:
- `store.transaction` message with operations array
- Supported ops: get, insert, update, delete, where, findOne, count
- All-or-nothing execution semantics
- Result array matching operation order

### [6.2 Transaction Patterns](./02-transaction-patterns.md)

Common patterns for real-world use:
- Cross-bucket operations (e.g., transfer between accounts)
- Read-modify-write within a single transaction
- Error handling and version conflict recovery

## What You'll Learn

By the end of this section, you'll be able to:
- Execute atomic multi-operation transactions over WebSocket
- Apply cross-bucket transaction patterns
- Handle conflicts and errors in transactions

---

Start with: [Atomic Operations](./01-atomic-operations.md)
