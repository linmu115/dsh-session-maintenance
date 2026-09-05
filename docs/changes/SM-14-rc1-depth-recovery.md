# Release blocker: RC1's persisted default delegation depth

During activation of Engine 0.1.15, Launcher correctly refused a new writer
because the previous run remained recovery-required. The original native file
and committed projection agreed on ID, creation time, cwd, preset and seed state.
Only the native file included `delegationDepth: 0`; the public header omitted it.

The installed official RC1 JSONL writer (`lib/index.js`, line 51) explicitly
persists `header.delegationDepth ?? 0`. Its SessionHeader contract permits the
field to be omitted. The embedded RC1 reader normalizes this default for comparison.
Other header values and every committed prefix event remain strictly checked.
The private adapter's 0.1.2 projection/cache identity is unchanged because no
materialization format changed; Engine 0.1.15's new source digest identifies the
reader fix. Existing recovery/cache identity checks remain enabled.

Five regressions cover real-tail preservation, nonzero depth, creation-time and
preset changes, and a rewritten committed prefix. The release reruns the RC1
adapter and broker/lifecycle checks before repackaging. Live recovery must use
the existing Provider/Runtime Broker protocol and produce its own final receipt;
there is no direct state update, forged receipt or native file rewrite.

The stopped run, WAL, native artifacts, database and previous binaries are saved
in the protected release rollback directory before any recovery attempt. This
small compatibility fix is necessary to activate the completed release and does
not resume the paused import, Launcher or retention construction tasks.

Final verification: workspace typecheck and build passed; all 20 selected files
and 98 RC1/broker/lifecycle tests passed. The built reader also checked the stopped
run read-only: all 340 mappings and durable committed prefixes were accepted,
with zero uncommitted native tails. This read-only check did not release the
lease or remove any recovery evidence; activation records the subsequent receipt.
