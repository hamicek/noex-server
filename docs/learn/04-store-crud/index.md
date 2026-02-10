# Part 4: Store CRUD Operations

Work with records through the WebSocket protocol — insert, read, update, delete, query, and aggregate.

## Chapters

### [4.1 Basic CRUD](./01-basic-crud.md)

The fundamental record lifecycle:
- `store.insert` — create new records with schema validation
- `store.get` — retrieve by primary key
- `store.update` — modify existing records with version tracking
- `store.delete` — remove records

### [4.2 Queries and Filtering](./02-queries-filtering.md)

Find records matching criteria:
- `store.all` — retrieve all records from a bucket
- `store.where` — filter with conditions
- `store.findOne` — get the first match
- `store.count` — count matching records

### [4.3 Pagination and Aggregations](./03-pagination-aggregations.md)

Work with large datasets and computed values:
- `store.first` / `store.last` — N records from start or end
- `store.paginate` — cursor-based pagination
- `store.sum` / `store.avg` / `store.min` / `store.max` — numeric aggregations

### [4.4 Metadata and Stats](./04-metadata-stats.md)

Inspect and manage the store:
- `store.buckets` — list defined buckets
- `store.stats` — store statistics
- `store.clear` — remove all records from a bucket

## What You'll Learn

By the end of this section, you'll be able to:
- Perform full CRUD operations over WebSocket
- Query and filter records with various operators
- Paginate through large result sets
- Compute aggregations and inspect store metadata

---

Start with: [Basic CRUD](./01-basic-crud.md)
