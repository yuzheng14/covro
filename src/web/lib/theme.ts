import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const key = 'covro.theme';
const query = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
let preference: Theme = 'system';
try {
  const saved = localStorage.getItem(key);
  if (saved === 'light' || saved === 'dark') preference = saved;
} catch {
  /* Storage may be disabled. */
}

function apply() {
  const dark = preference === 'dark' || (preference === 'system' && query.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#1e2024' : '#f7f8fa');
  listeners.forEach((listener) => listener());
}
export function setTheme(value: Theme) {
  preference = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Keep the session preference. */
  }
  apply();
}
query.addEventListener('change', apply);
window.addEventListener('storage', (event) => {
  if (event.key !== key && event.key !== null) return;
  preference = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'system';
  apply();
});
apply();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useTheme() {
  return useSyncExternalStore(subscribe, () => preference);
}
export function useDarkTheme() {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme === 'dark');
}
