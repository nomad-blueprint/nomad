import CataloguePanel from './components/CataloguePanel';
import CenterViewport from './components/CenterViewport';

export default function App() {
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: '#ffffff' }}>
      <CataloguePanel />
      <CenterViewport />
    </div>
  );
}
