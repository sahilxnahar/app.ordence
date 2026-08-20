/**
 * Ordence — the migration contract, one entry point.
 * Version: v1.84.0-alpha · Track M1
 *
 * ⚠️ THIS IS NOT A REGISTRY. Nothing here enumerates entities.
 * `ALL_IMPORT_ENTITIES` in `lib/import/entities.ts` remains the single
 * allowlist on the write path, and `isImportEntityKey` remains membership
 * in it. Everything exported here takes that map as an argument.
 */

export { resolveImportOrder, softAdvice } from "./graph";
export type { ImportOrderStep, ImportOrderResult } from "./graph";
export { checkImportContract } from "./check";
export type { ContractProblem, ContractCheckResult } from "./check";
export { OPENING_CONTRACTS } from "./opening-policies";
export { CONTACTS_WORKED_EXAMPLE } from "./worked-example";
