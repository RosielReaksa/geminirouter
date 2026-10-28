import React from 'react';
import {
  LayoutDashboard,
  Users,
  Boxes,
  Network,
  Activity,
  Sliders,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';

export type NavTab = 'overview' | 'accounts' | 'models' | 'gateway' | 'traffic' | 'settings';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  isRunning: boolean;
  isLiveApi: boolean;
  activeAccountsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  isRunning,
  isLiveApi,
  activeAccountsCount,
}) => {
  const navItems = [
    {
      id: 'overview' as NavTab,
      label: 'Overview',
      icon: LayoutDashboard,
      desc: 'System health & summary',
    },
    {
      id: 'accounts' as NavTab,
      label: 'Accounts & Quotas',
      icon: Users,
      badge: activeAccountsCount.toString(),
      desc: 'Connected Google profiles',
    },
    {
      id: 'models' as NavTab,
      label: 'Available Models',
      icon: Boxes,
      desc: 'Real model catalog & live test calls',
    },
    {
      id: 'gateway' as NavTab,
      label: 'API Gateway & Routing',
      icon: Network,
      desc: 'OpenRouter proxy & SDKs',
    },
    {
      id: 'traffic' as NavTab,
      label: 'Traffic Monitor',
      icon: Activity,
      desc: 'Live telemetry & requests',
    },
    {
      id: 'settings' as NavTab,
      label: 'Settings',
      icon: Sliders,
      desc: 'Port, rotation & auth',
    },
  ];

  return (
    <aside className="w-64 h-screen sticky top-0 shrink-0 flex flex-col bg-[#FAF7F2] border-r border-[#EAE5DE]/80">
      <div className="px-4 pt-5 pb-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-1">
          <div className="w-9 h-9 rounded-xl bg-[#C25938] flex items-center justify-center shadow-soft">
            <span className="font-serif-editorial text-lg leading-none text-white">g</span>
          </div>
          <div className="min-w-0">
            <div className="font-serif-editorial text-lg font-semibold text-[#2A2723] leading-tight truncate">
              geminirouter
            </div>
            <div className="text-[11px] text-[#9E988F] -mt-0.5">private gateway</div>
          </div>
        </div>

        {/* Gateway running pill */}
        <div className="mt-3 flex items-center gap-2 px-1">
          <span
            className={`w-2 h-2 rounded-full ${
              isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'
            }`}
          />
          <span className="text-xs font-medium text-[#706B65]">
            {isRunning ? 'Gateway Running' : 'Gateway Stopped'}
          </span>
          <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                isLiveApi
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-stone-100 text-[#706B65] border border-stone-200'
              }`}
              title={isLiveApi ? 'Connected to local core backend' : 'Running in local reactive mock simulation mode'}
            >
              {isLiveApi ? 'Live API' : 'Demo State'}
            </span>
        </div>
      </div>

      {/* Navigation list */}
      <nav className="px-3 py-2 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              title={item.desc}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl flex items-center justify-between text-sm transition-all duration-150 ${
                isActive
                  ? 'bg-[#FFFFFF] text-[#C25938] font-semibold shadow-soft border border-[#EAE5DE]'
                  : 'text-[#504C46] hover:bg-[#F2ECE4] hover:text-[#2A2723]'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon
                  className={`w-4 h-4 transition-colors ${
                    isActive ? 'text-[#C25938]' : 'text-[#706B65]'
                  }`}
                />
                <span>{item.label}</span>
              </div>
              {item.badge && (
                <span
                    className={`text-[11px] px-2 py-0.5 rounded-full font-mono-code ${
                      isActive
                        ? 'bg-[#FAF2EF] text-[#C25938]'
                        : 'bg-[#EAE5DE] text-[#706B65]'
                    }`}
                  >
                    {item.badge}
                  </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer Info & Support */}
      <div className="mt-auto p-4 border-t border-[#EAE5DE]/80 bg-[#FAF7F2]">
        <div className="bg-[#FAF2EF] border border-[#F2DDD5] rounded-xl p-3.5 text-xs text-[#706B65]">
          <div className="flex items-center gap-1.5 text-[#C25938] font-medium mb-1">
            <ShieldCheck className="w-4 h-4" />
            <span>Zero Data Stored</span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#786358]">
            Prompt tokens stream directly to Google AI Studio via your OAuth credentials. No third-party relays.
          </p>
        </div>

        <div className="mt-3 pt-3 flex items-center justify-between text-[11px] text-[#9E988F] px-1">
          <span>Local OpenRouter Proxy</span>
          <a
            href="https://ai.google.dev"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 hover:text-[#C25938] transition-colors"
          >
            <span>Google AI</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </aside>
  );
};
