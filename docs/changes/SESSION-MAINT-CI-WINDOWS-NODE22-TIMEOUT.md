# Windows Node 22 packaged-acceptance timeout

Date: 2026-09-05

## Problem

The isolated Phase 2 packaged-acceptance test completed successfully on Node 24
and locally, but GitHub's Windows Node 22 runner twice exceeded the test's fixed
60-second budget while packaging and loading the complete plugin workspace.
Both failed runs reached 338 passing tests before the acceptance test timed out;
no runtime assertion failed.

## Change

- Increase only the isolated packaged-acceptance test timeout from 60 seconds to
  120 seconds.
- Do not change Session Maintenance runtime behavior, the RC1 adapter, canonical
  data, projection lifecycle, or Launcher integration.

## Verification

- Re-run the focused isolated packaged-acceptance test.
- Re-run the GitHub Node 22 and Node 24 verification matrix from a clean checkout.
