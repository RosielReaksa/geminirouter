import React, { useState } from 'react';
import {
  X,
  ExternalLink,
  KeyRound,
  CheckCircle2,
  Copy,
  Check,
  AlertCircle,
  Loader2,
  ShieldAlert,
  ArrowRight,
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
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [oauthData, setOauthData] = useState<OAuthStartResponse | null>(null);
  const [codeOrUrl, setCodeOrUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [addedAccount, setAddedAccount] = useState<GoogleAccount | null>(null);

  // Initialize flow on mount or open
  React.useEffect(() => {
    if (isOpen) {
      setStep(1);
      setCodeOrUrl('');
      setErrorMsg(null);
      setAddedAccount(null);
      setLoading(true);

      api.startOAuth()
        .then(({ data }) => {
          setOauthData(data);
        })
        .catch((err) => {
          console.error(err);
          setErrorMsg('Failed to initialize OAuth handshake with Google.');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopyUrl = () => {
    if (oauthData?.authorizationUrl) {
      navigator.clipboard.writeText(oauthData.authorizationUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!codeOrUrl.trim()) {
      setErrorMsg('Please paste the authorization code or the redirect URL from Google.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const sessionId = oauthData?.sessionId || 'sess_oauth_demo';
      const { data } = await api.completeOAuth(sessionId, codeOrUrl);

      if (data.success && data.account) {
        setAddedAccount(data.account);
        setStep(3);
        onAccountAdded(data.account);
      } else {
        setErrorMsg(data.error || 'Failed to exchange authorization code.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error exchanging code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#2A2723]/35 backdrop-blur-[2px] transition-opacity">
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] w-full max-w-xl rounded-2xl shadow-modal overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#EAE5DE] flex items-center justify-between bg-[#FBF9F5]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#FAF2EF] border border-[#EAE5DE] flex items-center justify-center text-[#C25938]">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-serif-editorial text-2xl font-bold text-[#2A2723]">
                Connect Google Account
              </h3>
              <p className="text-xs text-[#706B65]">
                Authorizes geminirouter to route API requests using your official Google quotas
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#9E988F] hover:text-[#2A2723] p-1.5 rounded-lg hover:bg-[#F2ECE4] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Steps Breadcrumbs */}
        <div className="px-6 py-3 bg-[#FAF7F2] border-b border-[#EAE5DE] flex items-center justify-between text-xs font-medium text-[#706B65]">
          <div className={`flex items-center gap-1.5 ${step >= 1 ? 'text-[#C25938] font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full border border-current flex items-center justify-center text-[10px]">
              1
            </span>
            <span>Authenticate</span>
          </div>
          <span className="text-[#DDD7CE]">───</span>
          <div className={`flex items-center gap-1.5 ${step >= 2 ? 'text-[#C25938] font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full border border-current flex items-center justify-center text-[10px]">
              2
            </span>
            <span>Paste Callback</span>
          </div>
          <span className="text-[#DDD7CE]">───</span>
          <div className={`flex items-center gap-1.5 ${step >= 3 ? 'text-[#C25938] font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full border border-current flex items-center justify-center text-[10px]">
              3
            </span>
            <span>Ready</span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6">
          {errorMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>{errorMsg}</div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <p className="text-sm text-[#504C46] leading-relaxed">
                Click the button below to sign in with your Google account. Google will ask you to authorize access to
                <strong> Generative Language API</strong>.
              </p>

              <div className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-2 flex items-center justify-between">
                  <span>Google Authorization Link</span>
                  {oauthData?.expiresInSeconds && (
                    <span className="text-[11px] font-mono-code text-[#9E988F]">
                      Valid for {Math.floor(oauthData.expiresInSeconds / 60)} min
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={loading ? 'Generating authorization link...' : oauthData?.authorizationUrl || ''}
                    className="flex-1 bg-[#FFFFFF] border border-[#EAE5DE] rounded-lg px-3 py-2 text-xs font-mono-code text-[#504C46] truncate select-all focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    disabled={loading || !oauthData}
                    className="px-3 py-2 border border-[#EAE5DE] rounded-lg text-xs font-medium text-[#504C46] hover:bg-[#F2ECE4] flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  >
                    {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUrl ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <a
                  href={oauthData?.authorizationUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setStep(2)}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-white font-medium text-sm transition-all shadow-soft ${
                    loading || !oauthData
                      ? 'bg-[#C25938]/60 cursor-not-allowed'
                      : 'bg-[#C25938] hover:bg-[#B24E2E]'
                  }`}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Loading...</span>
                    </>
                  ) : (
                    <>
                      <span>Open Google Login Page</span>
                      <ExternalLink className="w-4 h-4" />
                    </>
                  )}
                </a>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-4 py-2.5 border border-[#EAE5DE] rounded-xl text-sm font-medium text-[#504C46] hover:bg-[#FAF7F2] transition-colors"
                >
                  I already have a code
                </button>
              </div>

              <div className="text-[11px] text-[#9E988F] flex items-center gap-1.5 pt-1">
                <ShieldAlert className="w-3.5 h-3.5 text-[#C25938]" />
                <span>Only refreshed OAuth tokens are kept in encrypted storage on your machine.</span>
              </div>
            </div>
          )}

          {step === 2 && (
            <form onSubmit={handleComplete} className="space-y-5">
              <p className="text-sm text-[#504C46] leading-relaxed">
                After granting permission on Google, copy the redirect URL (or authorization code) from your browser address bar and paste it below:
              </p>

              <div>
                <label className="block text-xs font-semibold text-[#2A2723] uppercase tracking-wider mb-1.5">
                  Callback URL or Code
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="http://localhost:8080/oauth/callback?code=4/0AbCdEf12345... or paste code directly"
                  value={codeOrUrl}
                  onChange={(e) => setCodeOrUrl(e.target.value)}
                  className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-3 text-xs font-mono-code text-[#2A2723] focus:outline-none focus:ring-2 focus:ring-[#C25938]/30 focus:border-[#C25938]"
                />
                <span className="text-[11px] text-[#9E988F] mt-1 block">
                  Tip: In demo mode, you can type any email like `myaccount@gmail.com` to simulate connecting.
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 text-xs font-medium text-[#706B65] hover:text-[#2A2723]"
                >
                  Back to Step 1
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center gap-2 py-2.5 px-6 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-sm font-medium shadow-soft transition-all disabled:opacity-50"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying with Google...</span>
                    </>
                  ) : (
                    <>
                      <span>Complete Authentication</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {step === 3 && addedAccount && (
            <div className="text-center py-4 space-y-4">
              <div className="w-14 h-14 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center text-emerald-600 mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>

              <div>
                <h4 className="font-serif-editorial text-2xl font-bold text-[#2A2723]">
                  Account Connected Successfully
                </h4>
                <p className="text-sm text-[#706B65] mt-1">
                  <strong>{addedAccount.email}</strong> is now enrolled in the gateway routing pool.
                </p>
              </div>

              <div className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-4 text-left max-w-md mx-auto text-xs space-y-2">
                <div className="flex justify-between text-[#706B65]">
                  <span>Tier</span>
                  <span className="font-medium text-[#2A2723]">{addedAccount.tier}</span>
                </div>
                <div className="flex justify-between text-[#706B65]">
                  <span>Gemini 2.5 Pro Quota</span>
                  <span className="font-mono-code text-[#2A2723]">50 req / 5h</span>
                </div>
                <div className="flex justify-between text-[#706B65]">
                  <span>Gemini 2.5 Flash Quota</span>
                  <span className="font-mono-code text-[#2A2723]">500 req / 5h</span>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-sm font-medium shadow-soft"
                >
                  Done & Back to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
