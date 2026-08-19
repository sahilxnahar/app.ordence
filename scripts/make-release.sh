#!/usr/bin/env bash
#
# Ordence — Build a verified, deployable release archive
# Version: v0.84.0-alpha
#
# ══════════════════════════════════════════════════════════════════════
# WHAT THIS PRODUCES
# ══════════════════════════════════════════════════════════════════════
#   ~/Downloads/ORDENCE ERP - APP.ORDENCE.COM/
#     ordence-<version>-<timestamp>.zip     the deployable tree
#     ordence-<version>-<timestamp>.sha256  its checksum
#     RELEASE-NOTES-<version>.txt           what is in it, and what to run
#
# ══════════════════════════════════════════════════════════════════════
# ⚠️ IT REFUSES TO BUILD A RELEASE THAT WOULD NOT DEPLOY
# ══════════════════════════════════════════════════════════════════════
# `npm run preflight` runs first and a failure aborts. A zip built from a
# tree that does not compile is worse than no zip: it looks like a
# deliverable, gets copied somewhere, and fails on Railway instead of on
# the machine that made it.
#
# Run from the project root:
#     bash scripts/make-release.sh
#
# Skip the gates only if you know why:
#     SKIP_PREFLIGHT=1 bash scripts/make-release.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION=$(node -p "require('./package.json').version")
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$HOME/Downloads/ORDENCE ERP - APP.ORDENCE.COM"
BASE="ordence-v${VERSION}-${STAMP}"
ZIP="$DEST/$BASE.zip"

echo "════════════════════════════════════════════════════════════"
echo "  ORDENCE RELEASE BUILD — v$VERSION"
echo "════════════════════════════════════════════════════════════"

# ── 1. Gates ─────────────────────────────────────────────────────────
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  echo "→ Running preflight…"
  npm run preflight
else
  echo "⚠️  PREFLIGHT SKIPPED by request — this archive is unverified."
fi

# ── 2. Clean stale artefacts ─────────────────────────────────────────
# `dot_clean` merges macOS AppleDouble sidecars back into their files.
# Over a thousand of them were once sitting in this tree, invisible in
# Finder and ordinary files on Linux.
command -v dot_clean >/dev/null 2>&1 && dot_clean -m "$ROOT" 2>/dev/null || true
find . -name '._*' -not -path './node_modules/*' -delete 2>/dev/null || true
find . -name '.DS_Store' -not -path './node_modules/*' -delete 2>/dev/null || true
rm -f tsconfig.tsbuildinfo

mkdir -p "$DEST"

# ── 3. Archive ───────────────────────────────────────────────────────
#
# ⚠️ `node_modules` IS EXCLUDED ON PURPOSE. Railway runs `npm ci` from
# `package-lock.json`, which is included. Shipping node_modules would add
# ~400 MB of the WRONG platform's binaries — this Mac builds darwin-arm64
# and Railway runs linux. That mismatch is exactly why `next build` could
# not be run inside a Linux sandbox against this tree.
echo "→ Archiving…"
rm -f "$ZIP"
zip -rq "$ZIP" . \
  -x "node_modules/*" \
     ".next/*" \
     ".git/*" \
     ".open-next/*" \
     ".wrangler/*" \
     "test-results/*" \
     "coverage/*" \
     "*.log" \
     ".DS_Store" \
     "._*" \
     ".env" \
     ".env.local" \
     ".env.production" \
     ".env.test" \
     "tsconfig.tsbuildinfo" \
     "ordence-full-backup-*.zip"

# ── 4. Verify the archive is actually readable ───────────────────────
#
# ⚠️ NOT OPTIONAL. A truncated zip lists its entries happily right up
# until the central directory is read. `unzip -t` is the only thing that
# proves the bytes survived the write.
echo "→ Verifying integrity…"
unzip -tq "$ZIP" >/dev/null || { echo "❌ Archive is corrupt — do not ship it."; exit 1; }

# ── 5. Verify no real secrets went in ────────────────────────────────
#
# ⚠️ ANCHORED WITH `grep -x`, NOT A SUBSTRING MATCH. An unanchored
# pattern flags `.env.test.example` — a committed template with no real
# values — and a check that cries wolf on a safe file is a check people
# start ignoring.
echo "→ Scanning for secrets…"
LEAKED=$(unzip -l "$ZIP" | awk '{print $NF}' | grep -Ex '\.env|\.env\.local|\.env\.test|\.env\.production' || true)
if [ -n "$LEAKED" ]; then
  echo "❌ An environment file is inside the archive:"; echo "$LEAKED"
  rm -f "$ZIP"; exit 1
fi
if unzip -p "$ZIP" '*.ts' '*.tsx' 2>/dev/null | grep -qE 'sk_live_[A-Za-z0-9]{20,}'; then
  echo "❌ A live Clerk secret key appears in the source."; rm -f "$ZIP"; exit 1
fi

shasum -a 256 "$ZIP" > "$DEST/$BASE.sha256"

# ── 6. Release notes ─────────────────────────────────────────────────
cat > "$DEST/RELEASE-NOTES-v$VERSION.txt" <<EOF
ORDENCE — v$VERSION
Built $(date)
Commit $(git rev-parse --short HEAD 2>/dev/null || echo "not a git repo")

ARCHIVE
  $BASE.zip
  $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') files

  node_modules is NOT included. Railway installs from package-lock.json.

DEPLOY (Railway, from GitHub)
  1. git push            — CI must be green before merging to main
  2. Railway builds:     npm run build     (railway.json)
  3. Railway starts:     npm run start
  4. Health check:       /api/health       (120s timeout)

DATABASE — run BEFORE the first deploy of this version
  Check what is already applied:
      DATABASE_URL="postgres://…" npm run db:status

  Then apply anything it lists, in numeric order:
      psql "\$DATABASE_URL" -v ON_ERROR_STOP=1 -f SQL-FILES/<file>

  Verify afterwards:
      npm run db:verify
      DATABASE_URL="postgres://…" npm run check:rls

  ⚠️ NEVER run \`drizzle-kit push\` against production. It drops RLS
     policies on every table — measured: 25 tables with RLS before,
     0 after. The app keeps working; tenants can read each other's data.

ENVIRONMENT
  See ENVIRONMENT-VARIABLES.md. No .env file is in this archive.
EOF

echo "════════════════════════════════════════════════════════════"
echo "  ✅ RELEASE READY"
echo "  $ZIP"
echo "  $(du -h "$ZIP" | cut -f1) · $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') files · integrity verified · no secrets"
echo "════════════════════════════════════════════════════════════"
