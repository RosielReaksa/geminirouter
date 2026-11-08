import { useEffect, useState } from 'react';

/**
 * Minimal history-based routing primitives. The app is a single Vite bundle
 * served by the bridge, so we only need pathname matching plus a way to
 * push/replace and to respond to the browser back button.
 *
 * This module deliberately exports no components: that keeps the React
 * Fast Refresh boundary intact. `<Link>` lives in `RouterLink.tsx`.
 */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return pathname;
}

export function navigate(to: string, options?: { replace?: boolean }): void {
  if (options?.replace) {
    window.history.replaceState({}, '', to);
  } else {
    window.history.pushState({}, '', to);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (window.scrollY > 0) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'instant' as ScrollBehavior : 'smooth' });
  }
}
