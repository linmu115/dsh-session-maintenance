# Alpha2 stream batching

## Symptom

An Alpha2 conversation could appear to require two sends. The model had already
started producing events, but each `assistant/chunk` was submitted to the
Maintenance Runtime Broker as an independent append. DSH's durability flush
before a tool call or the next model request then waited for thousands of HTTP,
WAL and canonical commits.

## Change

The plugin now groups all contiguous queued events into one native append while
preserving their exact order and content. Events arriving during an in-flight
append form the next batch.

The batch operation is stored before transport. If transport fails or its
result is uncertain, the same operation ID, native revision, observed time and
payload are retried. Newly observed events remain in the queue for a later
batch, so idempotency is not weakened.

## Focused acceptance breakpoints

1. A failed two-event batch is retried byte-for-byte as the same operation.
2. Two hundred chunks arriving behind one in-flight append become one follow-up
   batch, not two hundred independent durable commits.
3. `session/flush` returns only after both batches receive durable Maintenance
   receipts.

User acceptance remains a single-send live Alpha2 conversation test after the
updated plugin is deployed.
