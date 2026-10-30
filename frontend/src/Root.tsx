import React, { useEffect, useState } from 'react';
import { usePathname, navigate } from './router';
import { PublicNav, PublicFooter } from './components/marketing/Chrome';
import { LandingPage } from './components/marketing/LandingPage';
import { ModelsPage } from './components/marketing/ModelsPage';
import { PricingPage } from './components/marketing/PricingPage';
import { DocsPage } from './components/marketing/DocsPage';
import { LegalPage } from './components/marketing/LegalPage';
import { LoginPage } from './components/marketing/LoginPage';
import { NotFoundPage } from './components/marketing/NotFoundPage';
import { LoadingScreen } from './components/LoadingScreen';
import DashboardApp from './App';
import { authApi } from './services/authApi';

type AuthState = 'checking' | 'authed' | 'anon';

/** Marketing pages share the public nav + footer. */
const PublicShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mkt-body min-h-screen flex flex-col">
    <PublicNav />
    <main className="flex-1">{children}</main>
    <PublicFooter />
  </div>
);

const PublicRoutes: React.FC<{ pathname: string }> = ({ pathname }) => {
  const page = (() => {
    if (pathname === '/' || pathname === '') return <LandingPage />;
    if (pathname === '/models') return <ModelsPage />;
    if (pathname === '/pricing') return <PricingPage />;
    if (pathname === '/docs') return <DocsPage />;
    if (pathname === '/privacy') return <LegalPage kind="privacy" />;
    if (pathname === '/terms') return <LegalPage kind="terms" />;
    return <NotFoundPage />;
  })();

  return <PublicShell>{page}</PublicShell>;
};

export const Root: React.FC = () => {
  const pathname = usePathname();
  const [auth, setAuth] = useState<AuthState>('checking');

  // Verify the session whenever we enter the app area.
  useEffect(() => {
    let cancelled = false;
    if (!pathname.startsWith('/app') && pathname !== '/login') return;

    authApi.check().then((res) => {
      if (cancelled) return;
      setAuth(res.authenticated ? 'authed' : 'anon');
      if (!res.authenticated && pathname.startsWith('/app')) {
        navigate('/login', { replace: true });
      }
      // Only bounce /login -> /app on a real session. After an explicit sign-out
      // the server may still report "authenticated" (open mode), so this must
      // not fight the sign-out flag in authApi.check().
      if (res.authenticated && pathname === '/login' && !authApi.isSignedOut()) {
        navigate('/app', { replace: true });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // A 401 from any dashboard call drops us back to the login page.
  useEffect(() => {
    const onUnauthorized = () => {
      authApi.clearToken();
      setAuth('anon');
      if (window.location.pathname.startsWith('/app')) {
        navigate('/login', { replace: true });
      }
    };
    window.addEventListener('geminirouter:unauthorized', onUnauthorized);
    return () => window.removeEventListener('geminirouter:unauthorized', onUnauthorized);
  }, []);

  if (pathname === '/login') {
    return (
      <LoginPage
        onSuccess={() => {
          setAuth('authed');
        }}
      />
    );
  }

  if (pathname.startsWith('/app')) {
    if (auth === 'checking') {
      return <LoadingScreen title="Checking your session" detail="Warming up your private gateway…" />;
    }
    if (auth === 'anon') {
      // The redirect effect will move us to /login; render nothing meanwhile.
      return <div className="mkt-body min-h-screen" />;
    }
    return <DashboardApp />;
  }

  return <PublicRoutes pathname={pathname} />;
};

export default Root;
