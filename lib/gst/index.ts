/**
 * Ordence — GST Foundation, pure logic barrel
 * Version: v0.32.0-alpha
 *
 * ⚠️ NOTHING IN `lib/gst/` IMPORTS `@/db`. These modules are the tax
 * rules themselves — place of supply, rate resolution by date, the
 * arithmetic — and they are needed on the client (the booking form shows
 * the tax before anything is saved) as much as on the server.
 *
 * Type-only imports from `@/db/schema/gst` are the exception and are
 * erased at compile time; they exist so an enum value is spelled the same
 * way in the database and in the engine.
 */

export * from "./constants";
export * from "./gstin";
export * from "./place-of-supply";
export * from "./rates";
export * from "./tax";
export * from "./invoice-fields";
