# Alpha2 graceful-stop and WAL identity recovery

## Failure boundary

An Alpha2 Launcher stop supplied the DSH page URL, including its one-time token
query. The external lifecycle provider required an origin-only URL and rejected
the otherwise valid loopback address. Launcher therefore forced the process
down and the Engine entered recovery instead of the normal drain path.

The interrupted run retained one pending WAL operation. During recovery the
Alpha2 Adapter normalized native events as
`dsh-alpha2:<native-session-id>:<sequence>`. Alpha2 sequence values belong to a
projection run and can be reused after rematerialization, but canonical event
IDs are globally unique. The recovered events therefore collided with events
from an earlier run even though their contents differed.

## Repair

- The lifecycle provider validates HTTP, loopback hostname and absence of URL
  user information, then uses `URL.origin`. Any supplied path, query and
  fragment are deliberately discarded and are never persisted in the handle.
- Alpha2 event identities now include `runId`:
  `dsh-alpha2:<run-id>:<native-session-id>:<sequence>`.
- A retry of the same run and WAL operation remains deterministic. A later run
  receives a different identity even when Alpha2 reuses the native session ID
  and sequence.

The change stays within Maintenance's provider and Alpha2 Adapter. Launcher
keeps its generic lifecycle contract and does not learn recovery or persistence
details.

## Focused breakpoints

- A full loopback runtime URL with path, token query and fragment reaches the
  shutdown endpoint through its origin and does not persist the token.
- Re-normalizing the same append yields the same canonical event ID.
- Normalizing the same native event under a different run yields a different
  canonical event ID.
- The pre-existing pending WAL is recovered only through the formal Engine
  recovery path; it is never deleted or marked committed by hand.
