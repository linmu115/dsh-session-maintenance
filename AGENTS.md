# Session Maintenance contributor rules

- The phase-one runtime is read-only. Never write to real Codex or DSH homes.
- Use synthetic fixtures and marked temporary directories for tests.
- Keep platform format knowledge inside adapters and orchestration inside Engine.
- Keep shared DTOs in `packages/contracts`; do not create parallel contract types.
- Every planned task includes focused tests, a Markdown change report, and one commit.
- Do not add EAC or `dsh-codex-session-sync` runtime compatibility.
