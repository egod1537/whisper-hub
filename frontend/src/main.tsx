import React from 'react';
import { createRoot } from 'react-dom/client';
import 'normalize.css/normalize.css';
import '@blueprintjs/icons/lib/css/blueprint-icons.css';
import '@blueprintjs/core/lib/css/blueprint.css';
import './styles.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing.');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
