# Compatibility boundaries

This is an additive adapter, not a rename of `dsh-rc2` (the old 0.1.1-rc.2 implementation). Only host 0.1.5-rc.2 with the verified package closure is admitted. RC1, future releases and mixed package sets fail probe.

New V3 appends require Broker-bound instance identity, immutable V3 header and exact inherited cut. Broker supplies those from its authenticated run/projection, and rejects contradictory client values. The numeric native revision is a logical prefix length. A stat revision is only compared for equality inside one read.

No general V3-to-old downgrade is promised. Retain the old checkpoint and old native space. Unknown semantic events, malformed current generations, conflicting encodings, future generations, missing evidence and unverifiable prefix changes are refusals, not successful partial imports.
