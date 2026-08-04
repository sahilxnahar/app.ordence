/**
 * Ordence — ⭐ Receivables (Phase 38)
 * Version: v0.38.0-alpha
 *
 * The pure decision layer for demands, interest, ageing, receipts,
 * dunning and the statement of account. Nothing here imports `@/db` for
 * anything but a type, so every rule in this phase is testable without a
 * database — the rule this project has held since Phase 22's
 * `lib/sales/pipeline.ts` said why.
 *
 * The write paths are in `server/receivables/`; the guarantees that must
 * hold whatever writes them are in
 * `SQL-FILES/0027_phase38_receivables.sql`.
 *
 * ⚠️ `templates/` IS NOT RE-EXPORTED FROM HERE. Its module graph pulls in
 * six full language packs — tens of kilobytes of notice bodies — and a
 * barrel that dragged them into every import of `formatPaise` would put
 * every Kannada demand template into a bundle that only wanted to format
 * a number. Import `@/lib/receivables/templates` directly.
 */

export * from "./numbers";
export * from "./interest";
export * from "./ageing";
export * from "./allocation";
export * from "./dunning";
export * from "./demand";
export * from "./statement";
export * from "./render";
