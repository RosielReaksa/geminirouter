import React from 'react';
import { Reveal } from '../marketing/Chrome';

interface LegalPageProps {
  kind: 'privacy' | 'terms';
}

const PrivacyBody: React.FC = () => (
  <>
    <p>
      geminirouter is self-hosted software. This page describes what the software does with
      data when you run it on your own host. There is no geminirouter-operated service in the
      middle of your traffic.
    </p>

    <h2>What is stored</h2>
    <ul>
      <li>
        <strong>Google OAuth tokens</strong> — written to a local SQLite database beside the
        gateway. They are used only to call Google on your behalf.
      </li>
      <li>
        <strong>Account metadata</strong> — email, display name and quota snapshots, so the
        dashboard can show pool state.
      </li>
      <li>
        <strong>Request metadata</strong> — model, latency, status code and token counts, kept in
        a local traffic log for the dashboard.
      </li>
    </ul>

    <h2>What is not stored</h2>
    <ul>
      <li>Prompt and completion text is not persisted by the gateway.</li>
      <li>No analytics, telemetry or crash reporting is sent anywhere.</li>
      <li>The API key is never returned by any API endpoint and is never logged.</li>
    </ul>

    <h2>Where data goes</h2>
    <p>
      Prompts travel from your client, through the gateway on your host, to Google's APIs using
      your own OAuth credentials. Nothing is relayed to a third-party router.
    </p>

    <h2>Public pages</h2>
    <p>
      The marketing pages you are reading use two unauthenticated endpoints. They expose
      aggregate counts only — gateway status, number of connected accounts, request totals and
      the list of model ids. They never expose account emails, quota detail, traffic contents or
      credentials.
    </p>

    <h2>Your control</h2>
    <p>
      Deleting an account from the dashboard removes it from the pool. Deleting the profile
      directory removes every token and log this software created.
    </p>
  </>
);

const TermsBody: React.FC = () => (
  <>
    <p>
      These terms cover your use of the geminirouter software. The software is self-hosted:
      whoever runs it is responsible for it.
    </p>

    <h2>Your accounts, your responsibility</h2>
    <p>
      You connect Google accounts that you are entitled to use. You are responsible for
      complying with Google's terms of service for those accounts, including any limits on
      automated access.
    </p>

    <h2>No warranty</h2>
    <p>
      The software is provided as-is, without warranty of any kind. Routing, quota reporting and
      failover depend on Google's APIs and may change or fail without notice.
    </p>

    <h2>No service level</h2>
    <p>
      There is no hosted service and therefore no uptime commitment. Availability is a function
      of the host you run it on and the accounts you connect.
    </p>

    <h2>Acceptable use</h2>
    <p>
      Do not use this software to circumvent rate limits on accounts you do not control, to
      resell access in violation of an upstream provider's terms, or for any unlawful purpose.
    </p>

    <h2>Changes</h2>
    <p>
      Because the software runs on your host, these pages describe behaviour rather than a
      contract with a service operator. Update them alongside the software if you fork it.
    </p>
  </>
);

export const LegalPage: React.FC<LegalPageProps> = ({ kind }) => {
  const isPrivacy = kind === 'privacy';
  return (
    <div className="mkt-body">
      <section className="border-b border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 pt-14 pb-10">
          <Reveal>
            <div className="mkt-eyebrow mb-3">{isPrivacy ? 'Privacy' : 'Terms'}</div>
            <h1 className="mkt-display text-[40px] sm:text-[52px] text-[#191714]">
              {isPrivacy ? 'How data is handled.' : 'Terms of use.'}
            </h1>
            <p className="mt-4 text-[13px] text-[#A39C92] font-mono-code">
              Last updated {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </Reveal>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-5 sm:px-8 py-14">
        <div
          className="space-y-6 text-[14px] leading-[1.75] text-[#4A453E]
            [&_h2]:text-[18px] [&_h2]:font-semibold [&_h2]:text-[#191714] [&_h2]:mt-10 [&_h2]:mb-3
            [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:list-disc [&_li]:marker:text-[#C9C1B4]
            [&_strong]:text-[#191714] [&_strong]:font-medium"
        >
          {isPrivacy ? <PrivacyBody /> : <TermsBody />}
        </div>
      </section>
    </div>
  );
};
