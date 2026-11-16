import React from 'react';
import { Link } from '../RouterLink';
import {
  LayoutDashboard,
  Users,
  Boxes,
  Network,
  Activity,
  FlaskConical,
  Sliders,
  ExternalLink,
  ShieldCheck,
  LogOut,
  BarChart3,
  ShieldAlert,
  KeyRound,
  LifeBuoy,
} from 'lucide-react';

export type NavTab = 'overview' | 'accounts' | 'models' | 'playground' | 'gateway' | 'traffic' | 'usage' | 'settings' | 'proxy' | 'gemini';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  isRunning: boolean;
  isLiveApi: boolean;
  activeAccountsCount: number;
  onSignOut?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  isRunning,
  isLiveApi,
  activeAccountsCount,
  onSignOut,
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
      id: 'playground' as NavTab,
      label: 'Playground',
      icon: FlaskConical,
      desc: 'Try prompts and compare models',
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
      id: 'usage' as NavTab,
      label: 'Usage',
      icon: BarChart3,
      desc: 'Model usage by family & real-time stats',
    },
    {
      id: 'proxy' as NavTab,
      label: 'Proxy',
      icon: ShieldAlert,
      desc: 'Webshare proxy routing per account',
    },
    {
      id: 'gemini' as NavTab,
      label: 'Gemini API',
      icon: KeyRound,
      desc: 'AI Studio keys, models & rate limits',
    },
    {
      id: 'settings' as NavTab,
      label: 'Settings',
      icon: Sliders,
      desc: 'Port, rotation & auth',
    },
  ];

  return (
    <aside className="sticky top-0 z-30 w-full shrink-0 border-b border-[#EAE5DE]/80 bg-[#FAF7F2]/95 backdrop-blur-sm md:flex md:h-screen md:w-64 md:flex-col md:border-b-0 md:border-r">
      <div className="px-3 pt-3 pb-2 md:px-4 md:pt-5 md:pb-3">
        {/* Brand */}
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2.5">
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
          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#EAE5DE] text-[#706B65] transition-colors hover:bg-white hover:text-[#C25938] md:hidden"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Gateway running pill */}
        <div className="mt-2 flex items-center gap-2 px-1 md:mt-3">
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
      <nav aria-label="Main navigation" className="dashboard-nav-scroll flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:overflow-x-visible md:py-2 md:pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              title={item.desc}
              aria-current={isActive ? 'page' : undefined}
              className={`flex w-auto shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[11px] transition-all duration-150 md:w-full md:justify-between md:px-3.5 md:py-2.5 md:text-sm ${
                isActive
                  ? 'bg-[#FFFFFF] text-[#C25938] font-semibold shadow-soft border border-[#EAE5DE]'
                  : 'border-transparent text-[#504C46] hover:bg-[#F2ECE4] hover:text-[#2A2723]'
              }`}
            >
              <div className="flex items-center gap-2 md:gap-3">
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    isActive ? 'text-[#C25938]' : 'text-[#706B65]'
                  }`}
                />
                <span className="whitespace-nowrap">{item.label}</span>
              </div>
              {item.badge && (
                <span
                    className={`hidden text-[11px] px-2 py-0.5 rounded-full font-mono-code md:inline-flex ${
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
      <div className="mt-auto hidden border-t border-[#EAE5DE]/80 bg-[#FAF7F2] p-4 md:block">
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

        <Link
          to="/help"
          className="mt-2 w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11.5px] text-[#706B65] hover:bg-[#F2ECE4] hover:text-[#2A2723] transition-colors"
        >
          <LifeBuoy className="w-3.5 h-3.5" />
          <span>Help centre</span>
        </Link>

        {onSignOut && (
          <button
            onClick={onSignOut}
            className="mt-3 w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11.5px] text-[#706B65] hover:bg-[#F2ECE4] hover:text-[#2A2723] transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        )}
      </div>
    </aside>
  );
};
