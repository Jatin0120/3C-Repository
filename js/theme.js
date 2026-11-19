// Light/dark toggle shared by every page. The page's <head> applies a saved
// choice before first paint; this wires up the button.

const KEY = '3c-theme';

function current() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setupThemeToggle(button) {
  if (!button) return;
  const paint = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    button.textContent = next === 'dark' ? 'Dark' : 'Light';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* private mode: still works for this visit */ }
    paint();
  });
  paint();
}
