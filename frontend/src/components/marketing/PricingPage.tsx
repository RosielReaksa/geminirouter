import React from 'react';
import { Check, ArrowRight, Server, Users, ShieldCheck, Minus } from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';

/**
 * Honest pricing for a self-hosted tool.
 *
 * geminirouter is not a metered SaaS: you run it, you pay Google nothing extra
 * for the accounts you already have, and there is no per-token markup. Inventing
 * tiers here would misrepresent how the software actually works.
 */

const INCLUDED = [
  'Unlimited requests through your own accounts',
  'Every model your accounts can access',
  'Unlimited concurrent requests (capped per account)',
  'OpenAI, Anthropic and Gemini-compatible endpoints',
  'Per-model quota tracking and cooldown',
  'Automatic failover across accounts',
  'Dashboard, traffic log and live model tests',
  'No prompt retention, no analytics, no telemetry',
];

const COMPARISON = [
  { feature: 'Cost model', self: 'Free — you host it', hosted: 'Per-token markup' },
  { feature: 'Account pool', self: 'Your own Google accounts', hosted: 'Provider-managed' },
  { feature: 'Prompt data', self: 'Never leaves your host', hosted: 'Processed by provider' },
  { feature: 'Rate limits', self: 'Whatever your accounts allow', hosted: 'Tier-based' },
  { feature: 'Model access', self: 'Entitlement of your accounts', hosted: 'Whatever they offer' },
  { feature: 'Source code', self: 'Yours to read and change', hosted: 'Closed' },
  { feature: 'Ops burden', self: 'You run the process', hosted: 'None' },
];

export const PricingPage: React.FC = () => {
  return (
    <div className="mkt-body">
      <section className="border-b border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-16 pb-14">
          <Reveal>
            <div className="mkt-eyebrow mb-3">Pricing</div>
            <h1 className="mkt-display text-[40px] sm:text-[60px] text-[#191714] max-w-3xl">
              No metering.
              <br />
              No markup.
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-[#4A453E] max-w-xl">
              geminirouter is software you run, not a service you buy. There are no tokens to
              purchase and no per-request fees — the capacity is the quota your own Google
              accounts already have.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-6">
          {/* The one plan */}
          <Reveal>
            <div className="rounded-2xl border-2 border-[#191714] bg-white p-8 sm:p-10 h-full flex flex-col">
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-[#191714]">Self-hosted</h2>
                <span className="px-2.5 py-1 rounded-full bg-[#F5E7E0] text-[#A8462A] text-[11px] font-medium">
                  The only plan
                </span>
              </div>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="mkt-display text-[56px] text-[#191714]">$0</span>
                <span className="text-[13px] text-[#7A736A] pb-2">forever</span>
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-[#7A736A]">
                You supply the host and the Google accounts. The gateway supplies the routing.
              </p>

              <div className="mt-7 pt-7 border-t border-[#E4DED4] flex-1">
                <div className="text-[11px] uppercase tracking-wider text-[#A39C92] mb-3">
                  Included
                </div>
                <ul className="space-y-2.5">
                  {INCLUDED.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-[13.5px] text-[#4A453E]">
                      <Check className="w-4 h-4 text-[#4E7B62] shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Link
                to="/app"
                className="group mt-8 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors"
              >
                Open the dashboard
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </Reveal>

          {/* What you actually pay for */}
          <div className="space-y-6">
            <Reveal delay={60}>
              <div className="rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-7">
                <div className="flex items-center gap-2.5 mb-3">
                  <Server className="w-4 h-4 text-[#C25938]" strokeWidth={1.75} />
                  <h3 className="text-[14px] font-semibold text-[#191714]">What you provide</h3>
                </div>
                <ul className="space-y-2 text-[13px] text-[#4A453E]">
                  <li>A machine to run it on — a VPS, home server or your own laptop</li>
                  <li>Google accounts with Antigravity access</li>
                  <li>Node.js, or the bundled start script</li>
                </ul>
              </div>
            </Reveal>

            <Reveal delay={110}>
              <div className="rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-7">
                <div className="flex items-center gap-2.5 mb-3">
                  <Users className="w-4 h-4 text-[#C25938]" strokeWidth={1.75} />
                  <h3 className="text-[14px] font-semibold text-[#191714]">Capacity you get</h3>
                </div>
                <p className="text-[13px] leading-relaxed text-[#4A453E]">
                  The sum of every connected account's remaining quota, spread across models.
                  Add an account and capacity grows immediately — there is nothing to purchase.
                </p>
              </div>
            </Reveal>

            <Reveal delay={160}>
              <div className="rounded-2xl border border-[#D8E3DB] bg-[#EEF5F1] p-7">
                <div className="flex items-center gap-2.5 mb-3">
                  <ShieldCheck className="w-4 h-4 text-[#4E7B62]" strokeWidth={1.75} />
                  <h3 className="text-[14px] font-semibold text-[#2F5241]">No hidden costs</h3>
                </div>
                <p className="text-[13px] leading-relaxed text-[#2F5241]">
                  No per-token fee, no seat count, no egress charge. Your only cost is the host
                  you already pay for.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="border-t border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <Reveal>
            <h2 className="mkt-display text-[30px] sm:text-[40px] text-[#191714]">
              How this differs from a hosted router.
            </h2>
          </Reveal>

          <Reveal delay={60}>
            <div className="mt-8 overflow-hidden rounded-2xl border border-[#E4DED4] bg-white">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[#E4DED4] bg-[#FBF9F5]">
                    <th className="px-5 py-3.5 text-[11px] uppercase tracking-wider text-[#A39C92] font-medium">
                      &nbsp;
                    </th>
                    <th className="px-5 py-3.5 text-[11px] uppercase tracking-wider text-[#191714] font-semibold">
                      geminirouter
                    </th>
                    <th className="px-5 py-3.5 text-[11px] uppercase tracking-wider text-[#A39C92] font-medium">
                      Hosted router
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0EBE3]">
                  {COMPARISON.map((row) => (
                    <tr key={row.feature} className="hover:bg-[#FBF9F5] transition-colors">
                      <td className="px-5 py-3.5 text-[13px] text-[#7A736A]">{row.feature}</td>
                      <td className="px-5 py-3.5 text-[13px] text-[#191714] font-medium">
                        {row.self}
                      </td>
                      <td className="px-5 py-3.5 text-[13px] text-[#7A736A]">{row.hosted}</td>
                    </tr>
                  ))}
                  <tr className="bg-[#FBF9F5]">
                    <td className="px-5 py-3.5 text-[13px] text-[#7A736A]">Cost</td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-[#2F5241]">$0</td>
                    <td className="px-5 py-3.5 text-[13px] text-[#7A736A]">
                      <Minus className="w-4 h-4 text-[#C9C1B4]" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-16">
        <Reveal>
          <div className="rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-8 sm:p-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
            <div>
              <h3 className="mkt-display text-[26px] text-[#191714]">Questions about running it?</h3>
              <p className="mt-2 text-[13.5px] text-[#7A736A]">
                The docs cover setup, endpoints and rate-limit behaviour.
              </p>
            </div>
            <Link
              to="/docs"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors shrink-0"
            >
              Read the docs
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
};
