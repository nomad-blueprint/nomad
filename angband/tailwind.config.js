/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'umb-bgCanvas':  'var(--umb-bg-canvas)',
        'umb-bgPanel':   'var(--umb-bg-panel)',
        'umb-bgCard':    'var(--umb-bg-card)',
        'umb-border':    'var(--umb-border)',
        'umb-text':      'var(--umb-text)',
        'umb-textSec':   'var(--umb-text-sec)',
        'umb-textMuted': 'var(--umb-text-muted)',
        'umb-accent':    'var(--umb-accent)',
      },
    },
  },
  plugins: [],
}
