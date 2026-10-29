import React from 'react';
import { ArrowLeft, Compass } from 'lucide-react';
import { Link } from '../../router';

export const NotFoundPage: React.FC = () => (
  <div className="max-w-3xl mx-auto px-5 sm:px-8 py-24 sm:py-32 text-center">
    <div className="w-11 h-11 rounded-xl bg-[#F5E7E0] flex items-center justify-center mx-auto mb-6">
      <Compass className="w-5 h-5 text-[#C25938]" strokeWidth={1.75} />
    </div>
    <div className="mkt-eyebrow mb-3">404</div>
    <h1 className="mkt-display text-[36px] sm:text-[48px] text-[#191714]">
      This page wandered off.
    </h1>
    <p className="mt-4 text-[14px] text-[#7A736A] max-w-md mx-auto">
      The route you asked for does not exist on this gateway.
    </p>
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Link
        to="/"
        className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back home
      </Link>
      <Link
        to="/docs"
        className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white border border-[#E4DED4] text-[#191714] text-sm font-medium hover:border-[#C9C1B4] transition-colors"
      >
        Read the docs
      </Link>
    </div>
  </div>
);
