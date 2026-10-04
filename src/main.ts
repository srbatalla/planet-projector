import './style.css';
import { initializeApp } from './app';

initializeApp();

// Offline + install-to-home-screen in production builds (the dev server stays uncached).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Unsupported context (e.g. plain http on a LAN address): the app works the same without it.
    });
  });
}
