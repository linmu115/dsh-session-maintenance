# Compatibility

This Adapter is intentionally exact-versioned. It supports only the published
DeepSeek Harness `0.1.2-rc.1` session format family.

| DSH environment | Adapter result | Evidence |
|---|---|---|
| `@deepseek-ai/dsh`, `dsh-session`, and `dsh-session-persistence` all at `0.1.2-rc.1` with `sessionPersistence` | verified | Official npm types, implementation, fixtures, and synthetic contract tests |
| Any other package version set | failed | A different native format family requires a separate Adapter package |
| Runtime without `sessionPersistence` | failed | Required persistence seam is absent |

The manifest declares the exact range `0.1.2-rc.1`. No semver fallback or
capability-only compatibility claim is made. This keeps future Harness format
changes outside this Adapter instead of adding compatibility branches.

Unknown source semantics are normalized into the MCSF `other` class and
projected as ignorable Maintenance evidence. They cannot become user,
assistant, or model-visible tool-result messages.

Portable conversations additionally require `mcsf.conversationTopology.v1`.
The Adapter maps its dense zero-based ordinals to the one-based turn and step
coordinates required by RC1. Native RC1 conversation envelopes and portable
conversation rows cannot be mixed in the same Canonical version; controlled
recomposition belongs to the M06 migration boundary.
