import React from 'react';

interface LoadingScreenProps {
  title?: string;
  detail?: string;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  title = 'Getting your workspace ready',
  detail = 'Connecting your accounts and models…',
}) => (
  <main className="loading-screen" role="status" aria-live="polite" aria-label={`${title}. ${detail}`}>
    <div className="loading-sparkle loading-sparkle-one" aria-hidden="true">✦</div>
    <div className="loading-sparkle loading-sparkle-two" aria-hidden="true">✧</div>
    <div className="loading-sparkle loading-sparkle-three" aria-hidden="true">·</div>

    <section className="loading-content">
      <div className="loading-mascot-wrap" aria-hidden="true">
        <span className="loading-orbit loading-orbit-one" />
        <span className="loading-orbit loading-orbit-two" />
        <img className="loading-mascot" src="/loading-mascot.png" alt="" />
      </div>

      <div className="loading-copy">
        <div className="loading-brand-mark" aria-hidden="true">g</div>
        <h1 className="font-serif-editorial">{title}</h1>
        <p>{detail}</p>
      </div>

      <div
        className="loading-progress"
        role="progressbar"
        aria-label="Loading"
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span />
      </div>
      <span className="loading-footnote">A little moment, then we’re ready</span>
    </section>
  </main>
);
