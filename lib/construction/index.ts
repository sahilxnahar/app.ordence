/**
 * Ordence — ⭐ Construction Delivery (Phases 42–43)
 * Version: v0.43.0-alpha
 *
 * The pure decision layer for bills of quantities, rate analysis,
 * variations, the measurement book and running account bills. Nothing
 * here imports `@/db` for anything but a type, so every rule in these two
 * phases is testable without a database — and, more importantly, a site
 * engineer's screen can show the ceiling, the cumulative position and the
 * deduction waterfall BEFORE anything is written.
 *
 * ⚠️ THE GUARANTEES ARE NOT HERE. The cumulative arithmetic, the
 * measurement ceiling, the monotonicity of certified quantities, the
 * retention ledger and the segregation of duties are constraints and
 * triggers in `SQL-FILES/0028_phase42_construction.sql`, because this
 * layer is one of several write paths — a back-fill of a contract's
 * history and a support fix at a psql prompt are the others, and a rule
 * enforced in one place is a rule the others bypass.
 *
 * ⚠️ AND NOTHING HERE RESTATES PHASE 32 OR PHASE 36. The GST on a
 * contractor's bill is `lib/gst/`; the Section 194C deduction — with
 * 206AA, 206AB, the annual threshold and any Section 197 certificate —
 * is `lib/tds/`. A TDS figure computed twice is a TDS figure that differs
 * by a rupee between the bill and the quarterly return.
 */

export * from "./quantities";
export * from "./boq";
export * from "./rate-analysis";
export * from "./variations";
export * from "./measurement";
export * from "./deductions";
export * from "./ra-bill";
export * from "./retention";
export * from "./certification";
