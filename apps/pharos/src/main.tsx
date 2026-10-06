import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { createBlotterClient, type WorkerLike } from './transport/client';

const worker = new Worker(new URL('./transport/worker.ts', import.meta.url), { type: 'module' });
const client = createBlotterClient(worker as unknown as WorkerLike);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App client={client} wsUrl={wsUrl} />
  </StrictMode>,
);
