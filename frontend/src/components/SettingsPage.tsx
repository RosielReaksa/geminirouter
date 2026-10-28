import React, { useState } from 'react';
import {
  Sliders,
  Save,
  RotateCcw,
  Server,
  Zap,
  Check,
  Key,
} from 'lucide-react';
import { GatewayConfig } from '../types';

interface SettingsPageProps {
  config: GatewayConfig;
  onUpdateConfig: (partial: Partial<GatewayConfig>) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  config,
  onUpdateConfig,
}) => {
  const [formData, setFormData] = useState<GatewayConfig>({ ...config });
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Sync state if config prop changes
  React.useEffect(() => {
    setFormData({ ...config });
  }, [config]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateConfig(formData);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleGenerateApiKey = () => {
    const randomHex = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    setFormData((prev) => ({
      ...prev,
      masterApiKey: `gr-live_${randomHex}`,
    }));
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Introduction */}
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
          <Sliders className="w-4 h-4" />
          <span>Core Configuration</span>
        </div>
        <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
          Gateway Settings
        </h2>
        <p className="text-sm text-[#706B65] mt-1 max-w-xl">
          Tune daemon port, account rotation strategies, failover thresholds, and security policies.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Network & Daemon Settings */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2A2723]">
            <Server className="w-4 h-4 text-[#C25938]" />
            <span>Network & Binding</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
                Listening Port
              </label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) =>
                  setFormData({ ...formData, port: parseInt(e.target.value) || 8080 })
                }
                className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl px-3.5 py-2 text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938]"
              />
              <span className="text-[11px] text-[#9E988F] mt-1 block">
                Default: 8080. If changed, update your client base URLs accordingly.
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
                Binding Host
              </label>
              <input
                type="text"
                value={formData.host}
                onChange={(e) =>
                  setFormData({ ...formData, host: e.target.value })
                }
                className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl px-3.5 py-2 text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938]"
              />
              <span className="text-[11px] text-[#9E988F] mt-1 block">
                127.0.0.1 limits traffic to this computer only.
              </span>
            </div>
          </div>
        </div>

        {/* Master API Key & Auth */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2A2723]">
            <Key className="w-4 h-4 text-[#C25938]" />
            <span>Master API Key Authorization</span>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
              Master Bearer Token
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={formData.masterApiKey}
                onChange={(e) =>
                  setFormData({ ...formData, masterApiKey: e.target.value })
                }
                className="flex-1 bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl px-3.5 py-2 text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938]"
              />
              <button
                type="button"
                onClick={handleGenerateApiKey}
                className="px-3.5 py-2 border border-[#EAE5DE] rounded-xl text-xs font-medium text-[#504C46] hover:bg-[#FAF7F2] transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Generate New</span>
              </button>
            </div>
            <span className="text-[11px] text-[#9E988F] mt-1 block">
              Used to authorize requests sent by Claude Code, Codex, or OpenAI SDK clients.
            </span>
          </div>
        </div>

        {/* Routing & Account Failover Strategy */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2A2723]">
            <Zap className="w-4 h-4 text-[#C25938]" />
            <span>Account Pool Routing & Failover</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
                Multi-Account Balancing Strategy
              </label>
              <select
                value={formData.rotationStrategy}
                onChange={(e: any) =>
                  setFormData({ ...formData, rotationStrategy: e.target.value })
                }
                className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl px-3.5 py-2 text-xs text-[#2A2723] focus:outline-none focus:border-[#C25938]"
              >
                <option value="least-used-quota">Least-Used Quota (Recommended)</option>
                <option value="round-robin">Round-Robin across Active Accounts</option>
                <option value="priority-order">Primary First, Fallback on Limit</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
                Quota Threshold Trigger (%)
              </label>
              <input
                type="number"
                min={50}
                max={99}
                value={formData.quotaWarningThresholdPercent}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    quotaWarningThresholdPercent: parseInt(e.target.value) || 85,
                  })
                }
                className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl px-3.5 py-2 text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938]"
              />
              <span className="text-[11px] text-[#9E988F] mt-1 block">
                Switches to next account when an account reaches this % of its 5-hour limit.
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-[#EAE5DE] space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.autoSwitchOnQuotaLimit}
                onChange={(e) =>
                  setFormData({ ...formData, autoSwitchOnQuotaLimit: e.target.checked })
                }
                className="w-4 h-4 accent-[#C25938] rounded"
              />
              <span className="text-xs text-[#2A2723] font-medium">
                Automatic Failover upon receiving HTTP 429 from Google
              </span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.enableThinkingTagPassthrough}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    enableThinkingTagPassthrough: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#C25938] rounded"
              />
              <span className="text-xs text-[#2A2723] font-medium">
                Pass &lt;thought&gt; internal reasoning tokens to Anthropic/Claude clients
              </span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.autoStartOnBoot}
                onChange={(e) =>
                  setFormData({ ...formData, autoStartOnBoot: e.target.checked })
                }
                className="w-4 h-4 accent-[#C25938] rounded"
              />
              <span className="text-xs text-[#2A2723] font-medium">
                Auto-start background proxy on system startup
              </span>
            </label>
          </div>
        </div>

        {/* Save Bar */}
        <div className="flex items-center justify-end gap-3 pt-2">
          {savedSuccess && (
            <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              Settings saved successfully
            </span>
          )}

          <button
            type="submit"
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-xs font-semibold shadow-soft transition-all"
          >
            <Save className="w-4 h-4" />
            <span>Save Configuration</span>
          </button>
        </div>
      </form>
    </div>
  );
};
