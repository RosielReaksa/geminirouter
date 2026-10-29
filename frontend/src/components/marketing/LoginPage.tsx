import React, { useState } from 'react';
import { ArrowRight, Lock, ShieldCheck, AlertCircle } from 'lucide-react';
import { navigate, Link } from '../../router';
import { Wordmark } from '../marketing/Chrome';
import { authApi } from '../../services/authApi';

export const LoginPage: React.FC<{ onSuccess?: () => void }> = ({ onSuccess }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authApi.login(password);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'Sign in failed.');
      return;
    }
    onSuccess?.();
    navigate('/app', { replace: true });
  };

  return (
    <div className="mkt-body min-h-screen flex flex-col">
      <div className="flex-1 flex items-center justify-center px-5 py-16">
        <div className="w-full max-w-[380px]">
          <div className="flex justify-center mb-8">
            <Wordmark />
          </div>

          <div className="rounded-2xl border border-[#E4DED4] bg-white p-7 shadow-sm">
            <div className="w-9 h-9 rounded-lg bg-[#F5E7E0] flex items-center justify-center mb-4">
              <Lock className="w-4 h-4 text-[#C25938]" strokeWidth={1.75} />
            </div>

            <h1 className="text-[19px] font-semibold text-[#191714]">Sign in</h1>
            <p className="mt-1.5 text-[13px] text-[#7A736A]">
              Enter the admin password for this gateway.
            </p>

            <form onSubmit={submit} className="mt-6 space-y-3">
              <div>
                <label
                  htmlFor="password"
                  className="block text-[11px] uppercase tracking-wider text-[#A39C92] mb-1.5"
                >
                  Admin password
                </label>
                <input
                  id="password"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E4DED4] bg-[#FBF9F5] text-[14px] text-[#191714] focus:outline-none focus:border-[#C25938] focus:ring-2 focus:ring-[#F5E7E0] transition"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-[12.5px] text-[#A8462A] bg-[#FAF2EF] border border-[#EBD3C7] rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy || password.length === 0}
                className="group w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#191714] text-white text-[13.5px] font-medium hover:bg-[#332E28] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Signing in…' : 'Continue'}
                {!busy && (
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                )}
              </button>
            </form>

            <div className="mt-5 pt-5 border-t border-[#F0EBE3] flex items-start gap-2 text-[11.5px] text-[#A39C92] leading-relaxed">
              <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#4E7B62]" />
              <span>
                The password is exchanged for a session token and never stored in your browser.
              </span>
            </div>
          </div>

          <div className="mt-6 text-center">
            <Link to="/" className="text-[12.5px] text-[#7A736A] hover:text-[#191714]">
              ← Back to the site
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
