import { useState, useMemo } from 'react';
import { CATALOGUE, DOMAINS } from '@/lib/catalogue';
import type { CataloguePart } from '@/lib/catalogue';
import { useBuildStore } from '@/lib/store';

// ── Styles ────────────────────────────────────────────────────────────────────
const FONT = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";

const s = {
  root: {
    width: 280,
    minWidth: 280,
    height: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#ffffff',
    borderRight: '1px solid #e0e0e0',
    fontFamily: FONT,
    overflow: 'hidden',
  },
  header: {
    padding: '14px 16px 12px',
    borderBottom: '1px solid #e0e0e0',
    flexShrink: 0,
  },
  logo: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#000',
    textTransform: 'uppercase' as const,
  },
  subtitle: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
    letterSpacing: '0.04em',
  },
  searchWrap: {
    padding: '10px 12px',
    borderBottom: '1px solid #e0e0e0',
    flexShrink: 0,
  },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: FONT,
    border: '1px solid #ccc',
    borderRadius: 4,
    background: '#fff',
    color: '#000',
    outline: 'none',
  },
  domainPanel: {
    flexShrink: 0,
    borderBottom: '1px solid #e0e0e0',
    maxHeight: 200,
    overflowY: 'auto' as const,
  },
  domainHead: {
    padding: '6px 12px 4px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.10em',
    color: '#888',
    textTransform: 'uppercase' as const,
  },
  domainItem: (active: boolean) => ({
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
    background: active ? '#111' : 'transparent',
    color: active ? '#fff' : '#222',
    userSelect: 'none' as const,
    borderRadius: 3,
    margin: '0 4px',
  }),
  domainCount: (active: boolean) => ({
    fontSize: 10,
    color: active ? 'rgba(255,255,255,0.55)' : '#aaa',
    marginLeft: 4,
    flexShrink: 0,
  }),
  partList: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  partHead: {
    padding: '6px 12px 4px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.10em',
    color: '#888',
    textTransform: 'uppercase' as const,
    borderBottom: '1px solid #f0f0f0',
    background: '#fff',
    position: 'sticky' as const,
    top: 0,
    zIndex: 1,
  },
  partItem: {
    display: 'flex',
    alignItems: 'flex-start' as const,
    padding: '7px 12px 7px 12px',
    borderBottom: '1px solid #f5f5f5',
    gap: 8,
  },
  partBody: {
    flex: 1,
    minWidth: 0,
  },
  partName: {
    fontSize: 13,
    color: '#111',
    fontWeight: 500,
    lineHeight: 1.3,
    wordBreak: 'break-word' as const,
  },
  partSpec: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
    lineHeight: 1.3,
  },
  geoTag: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.07em',
    color: '#999',
    marginTop: 3,
  },
  addBtn: {
    flexShrink: 0,
    width: 24,
    height: 24,
    border: '1px solid #ccc',
    borderRadius: 3,
    background: '#fff',
    color: '#333',
    cursor: 'pointer',
    fontSize: 16,
    fontFamily: FONT,
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    lineHeight: 1,
    marginTop: 1,
  },
  empty: {
    padding: '24px 16px',
    textAlign: 'center' as const,
    color: '#aaa',
    fontSize: 13,
  },
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function CataloguePanel() {
  const addPart = useBuildStore((s) => s.addPart);
  const [search, setSearch] = useState('');
  const [activeDomain, setActiveDomain] = useState<string | null>(null);

  // Domain → count map
  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of CATALOGUE) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, []);

  // Filtered parts
  const visibleParts = useMemo<CataloguePart[]>(() => {
    const q = search.trim().toLowerCase();
    if (q.length >= 2) {
      const results: CataloguePart[] = [];
      for (const p of CATALOGUE) {
        if (
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
        ) {
          results.push(p);
          if (results.length >= 250) break;
        }
      }
      return results;
    }
    if (activeDomain) {
      return CATALOGUE.filter(p => p.category === activeDomain);
    }
    return CATALOGUE.slice(0, 60);
  }, [search, activeDomain]);

  const headingLabel = useMemo(() => {
    const q = search.trim();
    if (q.length >= 2) return `${visibleParts.length} results${visibleParts.length === 250 ? '+' : ''}`;
    if (activeDomain) return `${activeDomain} · ${visibleParts.length}`;
    return `All parts · showing first 60`;
  }, [search, activeDomain, visibleParts.length]);

  const handleAdd = (p: CataloguePart) => {
    addPart({ name: p.name, category: p.category, domain: p.domain, specs: p.specs });
  };

  return (
    <div style={s.root}>

      {/* ── Header ── */}
      <div style={s.header}>
        <div style={s.logo}>ANGBAND</div>
        <div style={s.subtitle}>Assembly Builder · {CATALOGUE.length.toLocaleString()} parts</div>
      </div>

      {/* ── Search ── */}
      <div style={s.searchWrap}>
        <input
          style={s.searchInput}
          placeholder="Search parts…"
          value={search}
          onChange={e => { setSearch(e.target.value); if (e.target.value.length >= 2) setActiveDomain(null); }}
          spellCheck={false}
        />
      </div>

      {/* ── Domain list ── */}
      <div style={s.domainPanel}>
        <div style={s.domainHead}>Domains</div>
        {DOMAINS.map(d => (
          <div
            key={d}
            style={s.domainItem(activeDomain === d)}
            onClick={() => { setActiveDomain(d === activeDomain ? null : d); setSearch(''); }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
            <span style={s.domainCount(activeDomain === d)}>{domainCounts.get(d) ?? 0}</span>
          </div>
        ))}
      </div>

      {/* ── Part list ── */}
      <div style={s.partList}>
        <div style={s.partHead}>{headingLabel}</div>

        {visibleParts.length === 0 && (
          <div style={s.empty}>No parts found</div>
        )}

        {visibleParts.map(p => (
          <div key={p.id} style={s.partItem}>
            <div style={s.partBody}>
              <div style={s.partName}>{p.name}</div>
              {p.description && <div style={s.partSpec}>{p.description}</div>}
              <div style={s.geoTag}>{p.geoLabel} · {p.category}</div>
            </div>
            <button
              style={s.addBtn}
              onClick={() => handleAdd(p)}
              title={`Add ${p.name}`}
            >+</button>
          </div>
        ))}
      </div>

    </div>
  );
}
