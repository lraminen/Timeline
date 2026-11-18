import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import './index.css';

function Root() {
  const [offlineReady, setOfflineReady] = useState(false);
  useEffect(() => {
    // Service worker precaches the app shell (production builds only).
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      registerSW({
        immediate: true,
        onOfflineReady: () => {
          setOfflineReady(true);
        },
      });
    }
  }, []);
  return <App offlineReady={offlineReady} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
