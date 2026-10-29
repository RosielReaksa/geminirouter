import React, { useState, useEffect } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { OverviewPage } from './components/OverviewPage';
import { AccountsPage } from './components/AccountsPage';
import { ModelsPage } from './components/ModelsPage';
import { GatewayPage } from './components/GatewayPage';
import { TrafficPage } from './components/TrafficPage';
import { SettingsPage } from './components/SettingsPage';
import { OAuthModal } from './components/OAuthModal';
import { api } from './services/api';
import { authApi } from './services/authApi';
import { navigate } from './router';
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
  const [currentTab, setCurrentTab] = useState<NavTab>('overview');
  const [isOAuthModalOpen, setIsOAuthModalOpen] = useState(false);
  const [isLiveApi, setIsLiveApi] = useState(false);

  // Core Data States
  const [status, setStatus] = useState<GatewayStatus>(INITIAL_MOCK_STATUS);
  const [accounts, setAccounts] = useState<GoogleAccount[]>(INITIAL_MOCK_ACCOUNTS);
  const [config, setConfig] = useState<GatewayConfig>(INITIAL_MOCK_CONFIG);
  const [traffic, setTraffic] = useState<TrafficRecord[]>(INITIAL_MOCK_TRAFFIC);

  // Action loaders
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  // Initial load
  const loadInitialData = async () => {
    try {
      const [statusRes, accRes, configRes, trafficRes] = await Promise.all([
        api.getStatus(),
        api.getAccounts(),
        api.getConfig(),
        api.getTraffic(),
      ]);

      setStatus(statusRes.data);
      setAccounts(accRes.data);
      setConfig(configRes.data);
      setTraffic(trafficRes.data);
      setIsLiveApi(statusRes.isLiveApi);
    } catch (err) {
      console.error('Data load error:', err);
    }
  };

  useEffect(() => {
    loadInitialData();
    // Poll status & traffic every 15 seconds
    const interval = setInterval(() => {
      api.getStatus().then((res) => {
        setStatus(res.data);
        setIsLiveApi(res.isLiveApi);
      });
      api.getTraffic().then((res) => {
        setTraffic(res.data);
      });
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  const handleRefreshQuotas = async () => {
    setIsRefreshing(true);
    try {
      const { data, isLiveApi: live } = await api.refreshAccounts();
      if (data && Array.isArray(data) && data.length > 0) {
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
    const updated = await api.deleteAccount(id);
    setAccounts(updated);
    showNotification('Account removed from rotation pool.');
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

  return (
    <div className="min-h-screen bg-[#FBF9F5] flex flex-col md:flex-row text-[#2A2723]">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
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
        <header className="h-16 border-b border-[#EAE5DE] px-6 sm:px-10 flex items-center justify-between bg-white/70 backdrop-blur-sm sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <span className="font-serif-editorial text-xl font-bold text-[#2A2723] capitalize">
              {currentTab === 'overview'
                ? 'Overview'
                : currentTab === 'accounts'
                ? 'Accounts & Quotas'
                : currentTab === 'models'
                ? 'Available Models'
                : currentTab === 'gateway'
                ? 'API Gateway & Routing'
                : currentTab === 'traffic'
                ? 'Traffic Monitor'
                : 'Settings'}
            </span>
            <span className="text-stone-300">/</span>
            <span className="text-xs text-[#706B65]">geminirouter</span>
          </div>

          <div className="flex items-center gap-3">
            {notification && (
              <div className="text-xs px-3 py-1.5 rounded-xl bg-[#FAF2EF] text-[#C25938] border border-[#F2DDD5] font-medium animate-in fade-in">
                {notification}
              </div>
            )}

            <div className="flex items-center gap-2 text-xs font-mono-code text-[#706B65] bg-[#FAF7F2] border border-[#EAE5DE] px-3 py-1.5 rounded-xl">
              <span className={`w-2 h-2 rounded-full ${status.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'}`}></span>
              <span>127.0.0.1:{status.port || config.port}</span>
            </div>
          </div>
        </header>

        {/* Tab Page Container */}
        <div className="p-6 sm:p-10 max-w-6xl w-full mx-auto pb-20">
          {currentTab === 'overview' && (
            <OverviewPage
              status={status}
              accounts={accounts}
              traffic={traffic}
              onNavigateToAccounts={() => setCurrentTab('accounts')}
              onNavigateToGateway={() => setCurrentTab('gateway')}
              onNavigateToModels={() => setCurrentTab('models')}
              onNavigateToTraffic={() => setCurrentTab('traffic')}
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
            />
          )}

          {currentTab === 'models' && (
            <ModelsPage
              gatewayOnline={status.isRunning}
              onNavigateToGateway={() => setCurrentTab('gateway')}
            />
          )}

          {currentTab === 'gateway' && (
            <GatewayPage
              config={config}
              onUpdateConfig={handleUpdateConfig}
            />
          )}

          {currentTab === 'traffic' && <TrafficPage traffic={traffic} />}

          {currentTab === 'settings' && (
            <SettingsPage
              config={config}
              onUpdateConfig={handleUpdateConfig}
            />
          )}
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
