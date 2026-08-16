# Track 7 Review: Batch 31 Edge Limits & Migrations Status

## Findings

| Severity | File | Finding | Fix |
|----------|------|---------|-----|
| High | `lib/edge/limits.ts` | The rate limiter degradation warning was only logged once per process. It should be logged loudly on startup AND per-violation-adjacent. | Added `announceDegraded` call on startup if Redis is not configured. |
| Medium | `lib/edge/body-limit.ts` | The `checkDeclaredBodySize` function did not handle `Content-Length: 0` correctly. | Updated `checkDeclaredBodySize` to handle `0` correctly. |
| Low | `middleware.ts` | The `edgeLimitGate` did not correctly handle the `observe` mode for the `platform` surface. | Updated `edgeLimitGate` to handle `observe` mode correctly. |

## Migrations Status
Implemented the migrations-status read-only module in `lib/migrations/status.ts` and exposed it as a platform-staff-only endpoint in `server/actions/migrations.ts`. Added tests in `tests/ui/migrations-status.test.ts`.
