# Deploy: v1.84.0-alpha, the import contract

Target repo **`app.ordence`**.

## SQL

**None.** Nothing to run in Neon, before or after. Block 0196 to 0199 is
reserved but deliberately unwritten , Phase 2 writes the provenance table
together with the code that writes to it.

## Order

Push the code. That is the whole deploy.

## What changed

Track M1, the import contract. Six new members on every entity the write
path can reach: `dependsOn`, `reversal`, `provenance`, `requiredness`,
`duplicateDecision`.

New CI gate 29, `npm run check:import-contract`.

**No behaviour change for any existing import.** The two shipped entities
and the four opening-balance entities behave identically; the contract
describes what they already do.

## Verify after the build goes green

```
npm run check:import-contract
```

Expected:

```
✅ check:import-contract
   6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
```
