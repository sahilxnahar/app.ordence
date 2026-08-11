/**
 * Ordence — Application version
 * Version: v0.85.0-alpha
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The landing page used to print a hardcoded `v0.1.0-alpha`. It stayed there
 * while the app shipped through v0.84.0, so anyone verifying a deployment saw a
 * version string from eighty releases ago and reasonably concluded the deploy
 * had failed. It had not. The string was simply a literal nobody updated.
 *
 * A version string that can drift from the artefact it labels is worse than no
 * version string at all: it is a check that reports "wrong" when things are
 * right, and people learn to ignore it.
 *
 * So the single source of truth is `package.json`, read at build time. There is
 * now no way for the displayed version and the released version to disagree.
 *
 * Safe to import anywhere. This module has no side effects, touches no database
 * and reads no environment — it is deliberately NOT `server-only`, so both the
 * marketing page and any future client component can render the same value.
 */

import pkg from "@/package.json";

/** The raw semver from package.json, e.g. `0.85.0-alpha`. */
export const APP_VERSION: string = pkg.version;

/** Display form, e.g. `v0.85.0-alpha`. Use this in UI. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
