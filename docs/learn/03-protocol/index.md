# Part 3: The Protocol

Master the JSON-over-WebSocket protocol that powers all communication between clients and the server.

## Chapters

### [3.1 Message Format](./01-message-format.md)

Understand the structure of every message:
- JSON text frames over WebSocket
- Protocol version 1.0.0
- Four message categories: request, response, push, system

### [3.2 Request and Response](./02-request-response.md)

Learn how request/response correlation works:
- The `id` field for matching responses to requests
- Operation routing: `store.*`, `rules.*`, `auth.*`
- Result vs error responses

### [3.3 Push Messages](./03-push-messages.md)

Understand server-initiated messages:
- The `subscription` channel for store query updates
- The `event` channel for rules engine matches
- `subscriptionId` for demultiplexing pushes

### [3.4 Error Handling](./04-error-handling.md)

Handle every error the server can return:
- All 15 error codes with descriptions
- Recovery strategies for each error
- Client-side error handling patterns

## What You'll Learn

By the end of this section, you'll understand:
- How every message is structured and routed
- How to correlate requests with responses using `id`
- How push messages arrive and how to demultiplex them
- How to handle every error code the server can return

---

Start with: [Message Format](./01-message-format.md)
