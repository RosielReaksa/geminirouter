import React, { useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Info,
  Network,
} from 'lucide-react';
import { GatewayConfig } from '../types';

interface GatewayPageProps {
  config: GatewayConfig;
  onUpdateConfig: (partial: Partial<GatewayConfig>) => void;
}

type SdkTab = 'claude' | 'codex' | 'curl' | 'openai' | 'anthropic' | 'cursor';

export const GatewayPage: React.FC<GatewayPageProps> = ({ config }) => {
  const [activeTab, setActiveTab] = useState<SdkTab>('claude');
  const [showKey, setShowKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // The reverse proxy exposes the gateway on the same HTTPS origin as the
  // dashboard. Keep generated client snippets valid for both local and VPS use.
  const baseUrl = typeof window !== 'undefined'
    ? window.location.origin
    : `http://${config.host}:${config.port}`;
  const v1Url = `${baseUrl}/v1`;

  const handleCopyKey = () => {
    navigator.clipboard.writeText(config.masterApiKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const snippets: Record<SdkTab, { title: string; code: string; note: string }> = {
    claude: {
      title: 'Claude Code CLI (~/.claude/settings.json)',
      note: 'Drop into your Claude Code config to route Sonnet / Opus calls seamlessly to Gemini Pro & Flash models with high context windows.',
      code: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${v1Url}",
    "ANTHROPIC_API_KEY": "${config.masterApiKey}"
  },
  "model": "gemini-2.5-pro",
  "smallModel": "gemini-2.5-flash"
}`,
    },
    codex: {
      title: 'Codex CLI (~/.codex/config.toml)',
      note: 'Configures Codex review & exec batches through geminirouter via OpenAI-compatible endpoints.',
      code: `model = "gemini-2.5-pro"
api_base = "${v1Url}"
api_key = "${config.masterApiKey}"

[aliases]
"gpt-4o" = "gemini-2.5-pro"
"deepseek-v4.1-flash" = "gemini-2.5-flash"`,
    },
    curl: {
      title: 'Standard cURL (OpenAI Compatible API)',
      note: 'Test raw completions and streaming directly from your terminal.',
      code: `curl ${v1Url}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${config.masterApiKey}" \\
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful coding assistant."},
      {"role": "user", "content": "Explain how geminirouter balances quotas across multiple Google accounts."}
    ],
    "stream": true
  }'`,
    },
    openai: {
      title: 'OpenAI Python SDK',
      note: 'Use the official openai client library simply pointing base_url to geminirouter.',
      code: `from openai import OpenAI

client = OpenAI(
    base_url="${v1Url}",
    api_key="${config.masterApiKey}",
)

response = client.chat.completions.create(
    model="gemini-2.5-pro",
    messages=[
        {"role": "user", "content": "Write a fast concurrent queue in Rust."}
    ],
)
print(response.choices[0].message.content)`,
    },
    anthropic: {
      title: 'Anthropic TypeScript SDK',
      note: 'Direct drop-in for @anthropic-ai/sdk with automated Thinking-tag passthrough.',
      code: `import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  baseURL: '${v1Url}',
  apiKey: '${config.masterApiKey}',
});

const message = await anthropic.messages.create({
  model: 'gemini-2.5-pro',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Design a clean relational schema.' }],
});

console.log(message.content[0]);`,
    },
    cursor: {
      title: 'Cursor IDE Configuration',
      note: 'Settings > Models > OpenAI API Key override.',
      code: `OpenAI API Key: ${config.masterApiKey}
Override OpenAI Base URL: ${v1Url}

Custom Models to add:
- gemini-2.5-pro
- gemini-2.5-flash
- gemini-2.5-flash-thinking`,
    },
  };

  const handleCopySnippet = () => {
    navigator.clipboard.writeText(snippets[activeTab].code);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Introduction */}
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
          <Network className="w-4 h-4" />
          <span>Routing & SDK Integration</span>
        </div>
        <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
          API Gateway & Routing Guide
        </h2>
        <p className="text-sm text-[#706B65] mt-1 max-w-2xl leading-relaxed">
          geminirouter speaks standard OpenRouter, OpenAI, and Anthropic API formats. Configure your local
          coding assistants, IDEs, and CLI tools to tap into your unified Google account quotas.
        </p>
      </div>

      {/* Gateway Connection Details Card */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-5">
        <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">
          Connection Credentials
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Base URL */}
          <div className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-4">
            <div className="text-xs font-semibold text-[#706B65] uppercase tracking-wider mb-1.5 flex items-center justify-between">
              <span>OpenRouter / OpenAI Base URL</span>
              <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                Active
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono-code text-sm font-semibold text-[#2A2723]">
                {v1Url}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(v1Url);
                  setCopiedKey(false);
                }}
                className="p-1.5 rounded-lg border border-[#EAE5DE] bg-[#FFFFFF] hover:bg-[#F2ECE4] text-[#706B65] transition-colors"
                title="Copy Base URL"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-[11px] text-[#9E988F] mt-2">
              Native Anthropic endpoint: <code className="bg-[#EAE5DE]/60 px-1 rounded">{baseUrl}/anthropic/v1</code>
            </div>
          </div>

          {/* Master API Key */}
          <div className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-4">
            <div className="text-xs font-semibold text-[#706B65] uppercase tracking-wider mb-1.5 flex items-center justify-between">
              <span>Master API Key (Bearer)</span>
              <span className="text-[10px] text-[#706B65]">Local Token</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono-code text-sm font-semibold text-[#2A2723] truncate">
                {showKey ? config.masterApiKey : '••••••••••••••••••••••••••••••••'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="p-1.5 rounded-lg border border-[#EAE5DE] bg-[#FFFFFF] hover:bg-[#F2ECE4] text-[#706B65] transition-colors"
                  title={showKey ? 'Hide Key' : 'Reveal Key'}
                >
                  {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={handleCopyKey}
                  className="p-1.5 rounded-lg border border-[#EAE5DE] bg-[#FFFFFF] hover:bg-[#F2ECE4] text-[#706B65] transition-colors"
                  title="Copy Master API Key"
                >
                  {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="text-[11px] text-[#9E988F] mt-2">
              Use this key across all your local clients. Change it anytime in Settings.
            </div>
          </div>
        </div>
      </div>

      {/* Model Compatibility & Routing Mapping Matrix */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">
              Model Aliasing & Routing
            </h3>
            <p className="text-xs text-[#706B65] mt-0.5">
              geminirouter automatically translates requested OpenAI or Anthropic model strings to their Google Gemini counterparts.
            </p>
          </div>
          <span className="text-xs bg-[#FAF2EF] text-[#C25938] px-2.5 py-1 rounded-full font-medium border border-[#EAE5DE]">
            Auto-Translation Active
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border border-[#EAE5DE] rounded-xl overflow-hidden">
            <thead className="bg-[#FAF7F2] text-[#706B65] font-semibold border-b border-[#EAE5DE]">
              <tr>
                <th className="py-3 px-4">Incoming Request Model</th>
                <th className="py-3 px-4">Routed Google Gemini Model</th>
                <th className="py-3 px-4">Context Window</th>
                <th className="py-3 px-4">Features</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EAE5DE] text-[#2A2723]">
              <tr className="hover:bg-[#FAF9F5]/70 transition-colors">
                <td className="py-3 px-4 font-mono-code font-semibold text-[#C25938]">
                  claude-3-5-sonnet-20241022, gpt-4o
                </td>
                <td className="py-3 px-4 font-mono-code font-semibold">
                  gemini-2.5-pro
                </td>
                <td className="py-3 px-4 font-mono-code text-[#706B65]">
                  1,000,000 tokens
                </td>
                <td className="py-3 px-4 text-[#706B65]">
                  Deep reasoning, complex code generation, full tool calling
                </td>
              </tr>
              <tr className="hover:bg-[#FAF9F5]/70 transition-colors">
                <td className="py-3 px-4 font-mono-code font-semibold text-[#C25938]">
                  claude-3-5-haiku-20241022, gpt-4o-mini
                </td>
                <td className="py-3 px-4 font-mono-code font-semibold">
                  gemini-2.5-flash
                </td>
                <td className="py-3 px-4 font-mono-code text-[#706B65]">
                  1,000,000 tokens
                </td>
                <td className="py-3 px-4 text-[#706B65]">
                  Ultra-low latency, 500 req/5h quota, instant completions
                </td>
              </tr>
              <tr className="hover:bg-[#FAF9F5]/70 transition-colors">
                <td className="py-3 px-4 font-mono-code font-semibold text-[#C25938]">
                  o1, o3-mini, deepseek-r1
                </td>
                <td className="py-3 px-4 font-mono-code font-semibold">
                  gemini-2.5-flash-thinking
                </td>
                <td className="py-3 px-4 font-mono-code text-[#706B65]">
                  1,000,000 tokens
                </td>
                <td className="py-3 px-4 text-[#706B65]">
                  Step-by-step internal reasoning trace passthrough
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Interactive Code Snippets Tabs */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">
              Quick Setup by Client & SDK
            </h3>
            <p className="text-xs text-[#706B65] mt-0.5">
              Select your tool to copy ready-to-paste configurations.
            </p>
          </div>
          <button
            onClick={handleCopySnippet}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] hover:bg-[#F2ECE4] text-xs font-medium text-[#2A2723] transition-colors"
          >
            {copiedSnippet ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedSnippet ? 'Copied snippet' : 'Copy configuration'}</span>
          </button>
        </div>

        {/* Tab pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-[#EAE5DE]">
          {(
            [
              { id: 'claude', label: 'Claude Code' },
              { id: 'codex', label: 'Codex CLI' },
              { id: 'cursor', label: 'Cursor IDE' },
              { id: 'curl', label: 'cURL' },
              { id: 'openai', label: 'OpenAI Python' },
              { id: 'anthropic', label: 'Anthropic TS' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-3.5 py-2 text-xs rounded-xl font-medium whitespace-nowrap transition-all ${
                activeTab === t.id
                  ? 'bg-[#C25938] text-white shadow-soft'
                  : 'text-[#706B65] hover:text-[#2A2723] hover:bg-[#FAF7F2]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Active tab content */}
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2 text-xs text-[#706B65]">
            <Info className="w-4 h-4 text-[#C25938] shrink-0" />
            <span>{snippets[activeTab].note}</span>
          </div>

          <div className="relative rounded-xl overflow-hidden border border-[#2A2723]/10 bg-[#1E1B18] text-[#FAF7F2] font-mono-code text-xs p-4 shadow-inner">
            <div className="text-[11px] text-[#A69E94] pb-2 mb-2 border-b border-white/10 flex items-center justify-between">
              <span>{snippets[activeTab].title}</span>
              <span className="text-[10px] uppercase tracking-wider text-emerald-400">ready</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre leading-relaxed select-all">
              {snippets[activeTab].code}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
