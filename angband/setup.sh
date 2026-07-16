#!/usr/bin/env bash
# ANGBAND v1.4 — one-shot setup script
# Run from wherever you extracted the zip: bash angband-src/setup.sh
set -e

APP=~/angband-app
# setup.sh lives inside angband-src/, right alongside src/, tailwind.config.js,
# etc. — SRC is just "the directory this script is in", not a nested subfolder.
SRC="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ██████╗ ███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ██╗██████╗"
echo "  ██╔══██╗████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗  ██║██╔══██╗"
echo "  ███████║██╔██╗ ██║██║  ███╗██████╔╝███████║██╔██╗ ██║██║  ██║"
echo "  ██╔══██║██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╗██║██║  ██║"
echo "  ██║  ██║██║ ╚████║╚██████╔╝██████╔╝██║  ██║██║ ╚████║██████╔╝"
echo "  ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝"
echo "  Assembly Builder v1.4 — Setup"
echo ""

# ── 1. Kill any existing dev server ──────────────────────────────────────────
echo "[1/5] Stopping any running dev server..."
pkill -f "vite" 2>/dev/null || true
sleep 0.5

# ── 2. Copy all new source files ─────────────────────────────────────────────
echo "[2/5] Copying source files into $APP..."
mkdir -p "$APP/src/types" "$APP/src/lib" "$APP/src/components" "$APP/tests"

cp "$SRC/src/types/index.ts"               "$APP/src/types/"
cp "$SRC/src/lib/store.ts"                 "$APP/src/lib/"
cp "$SRC/src/lib/uiStore.ts"               "$APP/src/lib/"
cp "$SRC/src/lib/builds.ts"                "$APP/src/lib/"
cp "$SRC/src/lib/catalogue.ts"             "$APP/src/lib/"
cp "$SRC/src/lib/geometryResolver.ts"      "$APP/src/lib/"
cp "$SRC/src/components/Viewport3D.tsx"    "$APP/src/components/"
cp "$SRC/src/components/CenterViewport.tsx" "$APP/src/components/"
cp "$SRC/src/components/CataloguePanel.tsx" "$APP/src/components/"
cp "$SRC/src/App.tsx"                      "$APP/src/"
cp "$SRC/src/main.tsx"                     "$APP/src/"
cp "$SRC/src/index.css"                    "$APP/src/"
cp "$SRC/vite.config.ts"                   "$APP/"
cp "$SRC/tailwind.config.js"               "$APP/"
cp "$SRC/postcss.config.js"               "$APP/"
cp -r "$SRC/tests/."                       "$APP/tests/"

# ── 3. Install npm dependencies ───────────────────────────────────────────────
echo "[3/5] Installing npm dependencies..."
cd "$APP"
npm install zustand
npm install three @react-three/fiber @react-three/drei
npm install -D tailwindcss@3 postcss autoprefixer @types/node
npm install -D sucrase   # lets tests/*.ts run directly against src/ — see tests/README.md

# ── 4. Init Tailwind (safe — won't overwrite if files exist) ──────────────────
echo "[4/5] Configuring Tailwind..."
# tailwind.config.js is already copied above, nothing to do

# ── 5. Done ───────────────────────────────────────────────────────────────────
echo "[5/5] Done!  Starting dev server..."
echo ""
echo "  Open http://localhost:5173 in your browser."
echo ""
npm run dev
