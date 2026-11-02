import React, { useState, useEffect, useRef } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { OverviewPage } from './components/OverviewPage';
import { AccountsPage } from './components/AccountsPage';
import { ModelsPage } from './components/ModelsPage';
import { PlaygroundPage } from './components/PlaygroundPage';
import { GatewayPage } from './components/GatewayPage';
import { TrafficPage } from './components/TrafficPage';
import { SettingsPage } from './components/SettingsPage';
import { OAuthModal } from './components/OAuthModal';
import { LoadingScreen } from './components/LoadingScreen';
import { api } from './services/api';
import { authApi } from './services/authApi';
import { navigate, usePathname } from './router';
import {
  GatewayStatus,
  GoogleAccount,
  GatewayConfig,
  TrafficRecord,
} from './types';
import {
  INITIAL_MOCK_ACCOUNTS,
  INITIAL_MOCK_CONFIG,
  INITIAL_MOCK_STATUS,
  INITIAL_MOCK_TRAFFIC,
} from './services/mockData';

/** The authenticated dashboard application (served at /app). */
export const DashboardApp: React.FC = () => {
  const pathname = usePathname();
  const tabSegment = pathname.split('/')[2] as NavTab | undefined;
  const currentTab: NavTab = tabSegment && [
    'overview', 'accounts', 'models', 'playground', 'gateway', 'traffic', 'settings',
  ].includes(tabSegment) ? tabSegment : 'overview';
  const previousTab = useRef(currentTab);
  const [isPageSwitchLoading, setIsPageSwitchLoading] = useState(false);
  const pageName = currentTab === 'accounts' ? 'Accounts & Quotas'
    : currentTab === 'models' ? 'Available Models'
    : currentTab === 'playground' ? 'Playground'
    : currentTab === 'gateway' ? 'API Gateway & Routing'
    : currentTab === 'traffic' ? 'Traffic Monitor'
    : currentTab === 'settings' ? 'Settings'
    : 'Overview';
  const trafficQuery = new URLSearchParams(window.location.search);
  const hasSelectedTrafficRange = currentTab === 'traffic'
    && trafficQuery.has('from')
    && trafficQuery.has('to')
    && Number.isFinite(Number(trafficQuery.get('from')))
    && Number.isFinite(Number(trafficQuery.get('to')))
    && Number(trafficQuery.get('to')) > Number(trafficQuery.get('from'));
  const navigateToTab = (tab: NavTab) => {
    navigate(tab === 'overview' ? '/app' : `/app/${tab}`);
  };
  const [isOAuthModalOpen, setIsOAuthModalOpen] = useState(false);
  const [isLiveApi, setIsLiveApi] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [playgroundEverOpened, setPlaygroundEverOpened] = useState(currentTab === 'playground');

  // Keep the Playground mounted after its first visit so uploads, progress and
  // results survive switching to another dashboard page.
  useEffect(() => {
    if (currentTab === 'playground') setPlaygroundEverOpened(true);
  }, [currentTab]);

  // Core Data States
  const [status, setStatus] = useState<GatewayStatus>(INITIAL_MOCK_STATUS);
  const [accounts, setAccounts] = useState<GoogleAccount[]>(INITIAL_MOCK_ACCOUNTS);
  const [config, setConfig] = useState<GatewayConfig>(INITIAL_MOCK_CONFIG);
  const [traffic, setTraffic] = useState<TrafficRecord[]>(INITIAL_MOCK_TRAFFIC);

  // Action loaders
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimer = useRef<number | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    if (notificationTimer.current !== null) {
      window.clearTimeout(notificationTimer.current);
    }
    notificationTimer.current = window.setTimeout(() => {
      notificationTimer.current = null;
      setNotification(null);
    }, 3000);
  };

  // Initial load is cancellable so quick route changes and StrictMode cleanup
  // do not update an unmounted dashboard.
  useEffect(() => {
    let active = true;
    const loadInitialData = async () => {
      try {
        const [statusRes, accRes, configRes, trafficRes] = await Promise.all([
          api.getStatus(),
          api.getAccounts(),
          api.getConfig(),
          api.getTraffic(),
        ]);
        if (!active) return;
        setStatus(statusRes.data);
        setAccounts(accRes.data);
        setConfig(configRes.data);
        setTraffic(trafficRes.data);
        setIsLiveApi(statusRes.isLiveApi);
      } catch (err) {
        if (active) console.error('Data load error:', err);
      } finally {
        if (active) setIsInitialLoading(false);
      }
    };
    void loadInitialData();
    return () => { active = false; };
  }, []);

  // Refresh without overlapping requests, and pause polling while the browser
  // tab is hidden so background tabs do not keep waking the gateway.
  useEffect(() => {
    let active = true;
    let polling = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (active && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => void refresh(), 15000);
      }
    };

    const refresh = async () => {
      if (!active || polling) return;
      if (document.visibilityState !== 'visible') return;

      polling = true;
      try {
        const [statusRes, accRes, trafficRes] = await Promise.all([
          api.getStatus(),
          api.getAccounts(),
          api.getTraffic(),
        ]);
        if (!active) return;
        setStatus(statusRes.data);
        setAccounts(accRes.data);
        setIsLiveApi(statusRes.isLiveApi);
        setTraffic(trafficRes.data);
      } catch (err) {
        if (active) console.warn('Dashboard refresh failed:', err);
      } finally {
        polling = false;
        scheduleNext();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void refresh();
    };

    if (document.visibilityState === 'visible') {
      timer = window.setTimeout(() => void refresh(), 15000);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => () => {
    if (notificationTimer.current !== null) {
      window.clearTimeout(notificationTimer.current);
      notificationTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (previousTab.current === currentTab) return;
    previousTab.current = currentTab;
    setIsPageSwitchLoading(true);
    // These pages use data already loaded into the dashboard shell. The
    // overview and model tools fetch their own live catalog and clear the
    // overlay from their request's finally handler.
    if (!['overview', 'models', 'playground'].includes(currentTab) && !hasSelectedTrafficRange) {
      setIsPageSwitchLoading(false);
      return;
    }

    // Show the mascot while the page warms up, then reveal its local skeleton
    // if a slow API call is still running. The whole app should never stay blocked.
    const failsafe = window.setTimeout(() => setIsPageSwitchLoading(false), 8000);
    return () => window.clearTimeout(failsafe);
  }, [currentTab, hasSelectedTrafficRange]);

  const handlePageReady = (tab: NavTab) => {
    const segment = window.location.pathname.split('/')[2] as NavTab | undefined;
    const activeTab: NavTab = segment && [
      'overview', 'accounts', 'models', 'playground', 'gateway', 'traffic', 'settings',
    ].includes(segment) ? segment : 'overview';
    if (activeTab === tab) setIsPageSwitchLoading(false);
  };

  const handleRefreshQuotas = async () => {
    setIsRefreshing(true);
    try {
      const { data, isLiveApi: live } = await api.refreshAccounts();
      if (Array.isArray(data)) {
        setAccounts(data);
      }
      setIsLiveApi(live);
      showNotification('Google account quotas updated successfully.');
    } catch {
      showNotification('Error refreshing account quotas.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleUpdateConfig = async (partial: Partial<GatewayConfig>) => {
    try {
      const { data, isLiveApi: live } = await api.updateConfig(partial);
      setConfig(data);
      setIsLiveApi(live);
      showNotification('Gateway settings saved.');
    } catch {
      showNotification('Failed to update config.');
    }
  };

  const handleDeleteAccount = async (id: string) => {
    try {
      const updated = await api.deleteAccount(id);
      setAccounts(updated);
      showNotification('Account removed from rotation pool.');
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Failed to remove account.');
    }
  };

  const handleSetDefaultAccount = async (id: string) => {
    const updated = await api.setDefaultAccount(id);
    setAccounts(updated);
    showNotification('Primary routing account updated.');
  };

  const handleAccountAdded = (newAccount: GoogleAccount) => {
    setAccounts((prev) => [...prev, newAccount]);
    showNotification(`Added ${newAccount.email} to quota pool.`);
  };

  if (isInitialLoading) {
    return <LoadingScreen detail="Connecting your accounts and models…" />;
  }

  return (
    <div className="min-h-screen bg-[#FBF9F5] flex flex-col md:flex-row text-[#2A2723]">
      {isPageSwitchLoading && (
        <LoadingScreen title={`Opening ${pageName}`} detail="Getting this page ready…" />
      )}
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={navigateToTab}
        isRunning={status.isRunning}
        isLiveApi={isLiveApi}
        activeAccountsCount={accounts.filter((a) => a.status === 'active').length}
        onSignOut={async () => {
          // logout() clears the token and records the explicit sign-out so the
          // router does not immediately re-authenticate in open mode.
          await authApi.logout();
          navigate('/login', { replace: true });
        }}
      />

      {/* Main Content Pane */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Floating App Bar */}
        <header className="h-16 border-b border-[#EAE5DE] px-4 sm:px-10 flex items-center justify-between bg-white/70 backdrop-blur-sm md:sticky md:top-0 md:z-20">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span key={currentTab} className="truncate whitespace-nowrap font-serif-editorial text-base font-bold text-[#2A2723] capitalize dashboard-title-enter sm:text-xl">
              {currentTab === 'overview'
                ? 'Overview'
                : currentTab === 'accounts'
                ? 'Accounts & Quotas'
                : currentTab === 'models'
                ? 'Available Models'
                : currentTab === 'playground'
                ? 'Playground'
                : currentTab === 'gateway'
                ? 'API Gateway & Routing'
                : currentTab === 'traffic'
                ? 'Traffic Monitor'
                : 'Settings'}
            </span>
            <span className="hidden text-stone-300 sm:inline">/</span>
            <span className="hidden text-xs text-[#706B65] sm:inline">geminirouter</span>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {notification && (
              <div className="text-xs px-3 py-1.5 rounded-xl bg-[#FAF2EF] text-[#C25938] border border-[#F2DDD5] font-medium animate-in fade-in">
                {notification}
              </div>
            )}

            <div className="flex items-center gap-1.5 text-[10px] font-mono-code text-[#706B65] bg-[#FAF7F2] border border-[#EAE5DE] px-2 py-1.5 rounded-xl sm:gap-2 sm:px-3 sm:text-xs">
              <span className={`w-2 h-2 rounded-full ${status.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'}`}></span>
              <span>127.0.0.1:{status.port || config.port}</span>
            </div>
          </div>
        </header>

        {/* Tab Page Container */}
        <div className="p-6 sm:p-10 max-w-6xl w-full mx-auto pb-20">
          <div className="dashboard-page-enter">
          {currentTab === 'overview' && (
            <OverviewPage
              status={status}
              accounts={accounts}
              traffic={traffic}
              onReady={() => handlePageReady('overview')}
              onNavigateToAccounts={() => navigateToTab('accounts')}
              onNavigateToGateway={() => navigateToTab('gateway')}
              onNavigateToModels={() => navigateToTab('models')}
              onNavigateToTraffic={(range) => {
                if (range) {
                  navigate(`/app/traffic?from=${range.from}&to=${range.to}`);
                } else {
                  navigateToTab('traffic');
                }
              }}
            />
          )}

          {currentTab === 'accounts' && (
            <AccountsPage
              accounts={accounts}
              inFlightPerAccount={status.inFlightPerAccount}
              maxCap={status.maxConcurrentRequestsPerAccount}
              onOpenOAuthModal={() => setIsOAuthModalOpen(true)}
              onRefreshQuotas={handleRefreshQuotas}
              onDeleteAccount={handleDeleteAccount}
              onSetDefaultAccount={handleSetDefaultAccount}
              onUpdateAccounts={setAccounts}
              onShowNotification={showNotification}
              isRefreshing={isRefreshing}
              oauthBlocked={status?.coreCredentials?.clientHealth?.state === 'blocked'}
            />
          )}

          {currentTab === 'models' && (
            <ModelsPage
              onReady={() => handlePageReady('models')}
              onNavigateToGateway={() => navigateToTab('gateway')}
            />
          )}

          {(currentTab === 'playground' || playgroundEverOpened) && (
            <div
              className={currentTab === 'playground' ? '' : 'hidden'}
              aria-hidden={currentTab !== 'playground'}
            >
              <PlaygroundPage
                onReady={() => handlePageReady('playground')}
                isActive={currentTab === 'playground'}
              />
            </div>
          )}

          {currentTab === 'gateway' && (
            <GatewayPage
              config={config}
              onUpdateConfig={handleUpdateConfig}
            />
          )}

          {currentTab === 'traffic' && (
            <TrafficPage traffic={traffic} onReady={() => handlePageReady('traffic')} />
          )}

          {currentTab === 'settings' && (
            <SettingsPage
              config={config}
              onUpdateConfig={handleUpdateConfig}
            />
          )}
          </div>
        </div>
      </main>

      {/* Interactive OAuth Modal Flow */}
      <OAuthModal
        isOpen={isOAuthModalOpen}
        onClose={() => setIsOAuthModalOpen(false)}
        onAccountAdded={handleAccountAdded}
      />
    </div>
  );
};

export default DashboardApp;
