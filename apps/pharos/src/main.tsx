import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { useAppStore } from './state/app-store';
import { pickInitialUser } from './state/users';
import { createBlotterClient, type WorkerLike } from './transport/client';

const worker = new Worker(new URL('./transport/worker.ts', import.meta.url), { type: 'module' });
const client = createBlotterClient(worker as unknown as WorkerLike);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// sessionStorage can be blocked; the tab then asks for a user on every load.
const storage = ((): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();
useAppStore.getState().setRequestedUser(pickInitialUser(location.search, storage));

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App client={client} wsUrl={wsUrl} storage={storage} />
  </StrictMode>,
);
