import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { applyTheme, resolveInitialTheme } from '@/lib/theme';

// Se aplica antes del primer render para no mostrar un destello del tema opuesto.
applyTheme(resolveInitialTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
