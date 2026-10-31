import React, { useState, useEffect } from 'react';
import {
  X,
  ExternalLink,
  RotateCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { api } from '../services/api';
import { authApi } from '../services/authApi';
import { GoogleAccount, OAuthStartResponse } from '../types';

function extractAuthorizationCode(value: string): string {
  const input = value.trim();
  if (!input) return '';

  // Hosted OAuth may redirect to the gateway's loopback callback. The user's
  // browser cannot reach the VPS at 127.0.0.1, but the callback URL still has
  // the short-lived Google code that can be completed through the dashboard.
  if (/^(https?:\/\/|127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/)/i.test(input)) {
    try {
      const url = new URL(input.startsWith('http') ? input : `http://${input}`);
      return url.searchParams.get('code') || '';
    } catch {
      return '';
    }
  }

  return input;
}

interface OAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccountAdded: (account: GoogleAccount) => void;
}

export const OAuthModal: React.FC<OAuthModalProps> = ({
  isOpen,
  onClose,
  onAccountAdded,
}) => {
  const isHostedWebsite =
    typeof window !== 'undefined' && !['localhost', '127.0.0.1'].includes(window.location.hostname);
  const isMobileDevice =
    typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const [selectedMethod, setSelectedMethod] = useState('antigravity_enterprise');
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [showManualCode, setShowManualCode] = useState(isHostedWebsite);
  const [currentSession, setCurrentSession] = useState<OAuthStartResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [baselineAccountIds, setBaselineAccountIds] = useState<string[] | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setAuthCode('');
      setErrorMsg(null);
      setSuccessMsg(null);
      setCurrentSession(null);
      setBaselineAccountIds(null);
    }
  }, [isOpen]);

  // Polling to detect when Google sign-in completes automatically in browser.
  // Only a genuinely NEW account counts as success: pre-existing accounts must
  // not make the modal claim the sign-in worked.
  useEffect(() => {
    if (!isOpen || !currentSession || !baselineAccountIds) return;

    const baseline = new Set(baselineAccountIds);
    const interval = setInterval(async () => {
      try {
        const { data: accounts } = await api.getAccounts();
        if (!Array.isArray(accounts)) return;
        const added = accounts.find((account) => !baseline.has(account.id));
        if (added) {
          setSuccessMsg(`Account ${added.email} successfully added!`);
          setTimeout(() => {
            onAccountAdded(added);
            onClose();
          }, 1500);
        }
      } catch {
        // ignore polling errors
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [isOpen, currentSession, baselineAccountIds, onAccountAdded, onClose]);

  if (!isOpen) return null;

  const handleOpenLoginPage = async () => {
    setIsStarting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      // Snapshot existing accounts so completion is only reported for a new one.
      const baselineIds = await api
        .getAccounts()
        .then(({ data }) => (Array.isArray(data) ? data.map((account) => account.id) : []))
        .catch(() => [] as string[]);

      // Antigravity requires its own OAuth client and the private `aicode`
      // scope, so a plain Google web client is rejected by Google. On a hosted
      // site the only redirect that client accepts is the loopback relay.
      const useLocalRelay = isHostedWebsite;

      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authApi.headers(),
        },
        body: JSON.stringify({
          oauthClientKey: selectedMethod,
          ...(useLocalRelay ? { callbackMode: 'local-relay' } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.authorizationUrl) {
        setErrorMsg(data.message || data.error || 'Failed to start Google sign-in session.');
        return;
      }

      setBaselineAccountIds(baselineIds);
      setCurrentSession(data);

      // Open Google login page directly in a new window/tab
      window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error connecting to core.');
    } finally {
      setIsStarting(false);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setErrorMsg('Your clipboard is empty. Copy the full address-bar URL first.');
        return;
      }
      setAuthCode(text.trim());
      setErrorMsg(null);
    } catch {
      setErrorMsg('Clipboard access was blocked — paste into the field manually.');
    }
  };

  const handleManualCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = extractAuthorizationCode(authCode);
    if (!code) {
      setErrorMsg('Paste the Google authorization code or the full callback URL from your browser address bar.');
      return;
    }

    setIsSubmittingCode(true);
    setErrorMsg(null);

    try {
      const sessionId = currentSession?.sessionId || 'current';
      const res = await fetch('/api/oauth/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authApi.headers(),
        },
        body: JSON.stringify({ sessionId, code }),
      });

      const data = await res.json();
      if (!res.ok || data.success === false) {
        setErrorMsg(data.message || data.error || 'Failed to verify authorization code.');
        return;
      }

      setSuccessMsg(data.email ? `Account ${data.email} connected!` : 'Account successfully verified and added!');
      // Fetch fresh accounts and prefer the one the server confirmed.
      const { data: accounts } = await api.getAccounts();
      const confirmed = data.email
        ? accounts.find((account) => account.email.toLowerCase() === String(data.email).toLowerCase())
        : undefined;
      if (confirmed) {
        onAccountAdded(confirmed);
      } else if (accounts.length > 0) {
        onAccountAdded(accounts[0]);
      }
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error verifying code.');
    } finally {
      setIsSubmittingCode(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-[500px] bg-white rounded-2xl border border-[#EAE5DE] shadow-modal overflow-hidden text-[#2A2723]">
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4 border-b border-[#EAE5DE]">
          <div>
            <h3 className="font-serif-editorial text-2xl font-bold text-[#2A2723]">
              Add Google Account
            </h3>
            <p className="text-xs text-[#706B65] mt-1">
              Sign in with the Google account you use for Antigravity. This adds that account’s Antigravity authorization to the gateway.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[#9E988F] hover:text-[#2A2723] hover:bg-[#F2ECE4] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5">
          {/* Sign-in Method Dropdown */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#504C46]">
              Sign-in method
            </label>
            <div className="relative">
              <select
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full appearance-none px-3.5 py-2.5 rounded-xl border border-[#EAE5DE] bg-white text-xs text-[#2A2723] focus:outline-none focus:border-[#C25938] transition-colors pr-8 font-medium cursor-pointer"
              >
                <option value="antigravity_enterprise">
                  {isHostedWebsite
                    ? 'Antigravity account (Google sign-in)'
                    : 'Antigravity account (Google sign-in)'}
                </option>
              </select>
              <ChevronDown className="w-4 h-4 text-[#706B65] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          {isHostedWebsite && (
            <div className="rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] p-3.5">
              <p className="text-[11px] leading-relaxed text-[#706B65]">
                <strong className="text-[#504C46]">No download needed.</strong> Google sends you to
                <span className="font-mono-code"> 127.0.0.1:41209 </span>, which only exists on this device — so the page
                will say “can't be reached”. That is expected. Leave it open and copy the
                <em> entire address-bar URL </em>(it contains <span className="font-mono-code">code=…</span>) into the box
                below.
              </p>
            </div>
          )}

          {/* Error Message banner */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-[#FAF2EF] border border-[#F2DDD5] text-xs text-[#C25938] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="leading-relaxed">{errorMsg}</div>
            </div>
          )}

          {/* Success Message banner */}
          {successMsg && (
            <div className="p-3 rounded-xl bg-[#EEF5F1] border border-[#D3E4DB] text-xs text-[#4E7B62] flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Main Action: Open Login Page Button */}
          <div>
            <button
              onClick={handleOpenLoginPage}
              disabled={isStarting}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#F2ECE4] hover:bg-[#EAE1D5] border border-[#DDD7CE] text-xs font-semibold text-[#2A2723] transition-colors disabled:opacity-50"
            >
              {isStarting ? (
                <Loader2 className="w-4 h-4 animate-spin text-[#C25938]" />
              ) : (
                <RotateCw className="w-4 h-4 text-[#706B65]" />
              )}
              <span>{isStarting ? 'Opening...' : 'Open Login Page'}</span>
              <ExternalLink className="w-3.5 h-3.5 text-[#9E988F]" />
            </button>
            <p className="text-[11px] text-[#9E988F] text-center mt-2 leading-relaxed">
              {!isHostedWebsite
                ? 'Complete sign-in in your browser. This window will update when it finishes.'
                : isMobileDevice
                  ? 'After signing in, copy the full URL from the failed page and paste it below.'
                  : 'After signing in, if the page fails to load, copy its URL and paste it below. The helper is optional.'}
            </p>
          </div>

          {/* Finish sign-in: paste the callback URL. No helper required. */}
          <div className="pt-2 border-t border-[#EAE5DE]">
            <button
              type="button"
              onClick={() => setShowManualCode(!showManualCode)}
              className="flex items-center gap-1.5 text-xs font-semibold text-[#504C46] hover:text-[#2A2723] transition-colors py-1"
            >
              {showManualCode ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <span>{isHostedWebsite ? 'Finish sign-in (paste the URL)' : 'Enter a code manually'}</span>
            </button>

            {showManualCode && (
              <form onSubmit={handleManualCodeSubmit} className="mt-3 space-y-3">
                {isHostedWebsite && (
                  <ol className="text-[11px] text-[#706B65] leading-relaxed list-decimal pl-4 space-y-1">
                    <li>Click <strong className="text-[#504C46]">Open Login Page</strong> and sign in with the Antigravity account.</li>
                    <li>When the page fails with “can't be reached”, tap the address bar and copy the whole URL.</li>
                    <li>Paste it below and click <strong className="text-[#504C46]">Verify &amp; Add</strong>.</li>
                  </ol>
                )}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#706B65]">
                    Authorization code or callback URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      autoFocus={isHostedWebsite}
                      placeholder="Paste the full URL or the code (4/…)"
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-[#EAE5DE] bg-white text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938] transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handlePasteFromClipboard}
                      className="shrink-0 px-3 py-2 rounded-xl border border-[#DDD7CE] bg-white hover:bg-[#F2ECE4] text-xs font-semibold text-[#504C46] transition-colors"
                    >
                      Paste
                    </button>
                  </div>
                  <p className="text-[10px] text-[#9E988F]">
                    A full URL is fine — only its <span className="font-mono-code">code</span> parameter is used.
                  </p>
                </div>

                <div className="flex justify-start">
                  <button
                    type="submit"
                    disabled={isSubmittingCode || !authCode.trim()}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-xs font-semibold transition-colors disabled:opacity-40"
                  >
                    {isSubmittingCode ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : null}
                    <span>Verify & Add</span>
                  </button>
                </div>
              </form>
            )}
          </div>

          {isHostedWebsite && (
            <p className="text-[10px] text-[#9E988F] leading-relaxed">
              Prefer not to copy the URL? Get the Framecall Helper from
              <strong className="text-[#504C46]"> Accounts → Pair desktop helper </strong>
              and keep it open during sign-in — it relays the callback automatically.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-[#FAF7F2] border-t border-[#EAE5DE] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-[#EAE5DE] bg-white hover:bg-[#F2ECE4] text-xs font-medium text-[#504C46] transition-colors shadow-soft"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
