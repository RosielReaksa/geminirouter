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
import { GoogleAccount, OAuthStartResponse } from '../types';

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
  const [selectedMethod, setSelectedMethod] = useState('antigravity_enterprise');
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [showManualCode, setShowManualCode] = useState(false);
  const [currentSession, setCurrentSession] = useState<OAuthStartResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setAuthCode('');
      setErrorMsg(null);
      setSuccessMsg(null);
      setCurrentSession(null);
    }
  }, [isOpen]);

  // Polling to detect when Google sign-in completes automatically in browser
  useEffect(() => {
    if (!isOpen || !currentSession) return;

    const interval = setInterval(async () => {
      try {
        const { data: accounts } = await api.getAccounts();
        if (Array.isArray(accounts) && accounts.length > 0) {
          // Check if an account was recently added
          const newest = accounts[0];
          setSuccessMsg(`Account ${newest.email} successfully added!`);
          setTimeout(() => {
            onAccountAdded(newest);
            onClose();
          }, 1500);
        }
      } catch {
        // ignore polling errors
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [isOpen, currentSession, onAccountAdded, onClose]);

  if (!isOpen) return null;

  const handleOpenLoginPage = async () => {
    setIsStarting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oauthClientKey: selectedMethod }),
      });

      const data = await res.json();
      if (!res.ok || !data.authorizationUrl) {
        setErrorMsg(data.message || data.error || 'Failed to start Google sign-in session.');
        return;
      }

      setCurrentSession(data);

      // Open Google login page directly in a new window/tab
      window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error connecting to core.');
    } finally {
      setIsStarting(false);
    }
  };

  const handleManualCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = authCode.trim();
    if (!code) {
      setErrorMsg('Please paste the code from your browser.');
      return;
    }

    setIsSubmittingCode(true);
    setErrorMsg(null);

    try {
      const sessionId = currentSession?.sessionId || 'current';
      const res = await fetch('/api/oauth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, code }),
      });

      const data = await res.json();
      if (!res.ok || data.success === false) {
        setErrorMsg(data.message || data.error || 'Failed to verify authorization code.');
        return;
      }

      setSuccessMsg('Account successfully verified and added!');
      // Fetch fresh accounts to update parent
      const { data: accounts } = await api.getAccounts();
      if (accounts.length > 0) {
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
              Choose a sign-in method, then sign in to Google in your browser. Your account will be added automatically.
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
                <option value="antigravity_enterprise">Antigravity Enterprise</option>
              </select>
              <ChevronDown className="w-4 h-4 text-[#706B65] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

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
              Complete sign-in in your browser. This window will update when it finishes.
            </p>
          </div>

          {/* Collapsible: Enter a code manually */}
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
              <span>Enter a code manually</span>
            </button>

            {showManualCode && (
              <form onSubmit={handleManualCodeSubmit} className="mt-3 space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#706B65]">
                    Authorization Code
                  </label>
                  <input
                    type="text"
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    placeholder="Paste the code starting with 4/..."
                    className="w-full px-3 py-2 rounded-xl border border-[#EAE5DE] bg-white text-xs font-mono-code text-[#2A2723] focus:outline-none focus:border-[#C25938] transition-colors"
                  />
                  <p className="text-[10px] text-[#9E988F]">
                    If automatic sign-in does not finish, paste the code from the browser here.
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
