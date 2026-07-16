@tailwind base;
@tailwind components;
@tailwind utilities;

/* ── CSS custom properties for umb-* design tokens ──────────────────────────
 * Referenced by Tailwind bg-umb-*, text-umb-*, border-umb-* utilities.
 * These are declared here so they work even if Tailwind JIT misses them.
 */
:root {
  --umb-bg-canvas:  #080c14;
  --umb-bg-panel:   #090d18;
  --umb-bg-card:    rgba(255,255,255,0.03);
  --umb-border:     rgba(255,255,255,0.07);
  --umb-text:       rgba(255,255,255,0.88);
  --umb-text-sec:   rgba(255,255,255,0.55);
  --umb-text-muted: rgba(255,255,255,0.28);
  --umb-accent:     #3b82f6;
}

/* ── Reset / base ────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #080c14;
  color: rgba(255,255,255,0.85);
  font-family: monospace;
  -webkit-font-smoothing: antialiased;
}

/* ── Scrollbar styling ───────────────────────────────────────────────────── */
::-webkit-scrollbar       { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

button { user-select: none; }
