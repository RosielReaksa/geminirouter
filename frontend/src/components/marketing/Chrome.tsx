import React, { useEffect, useRef, useState } from 'react';
import { Link, usePathname } from '../../router';
import { ArrowRight, Menu, X } from 'lucide-react';

/** Fade/slide an element in when it first scrolls into view. */
export const Reveal: React.FC<{
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'section' | 'li';
}> = ({ children, delay = 0, className = '', as = 'div' }) => {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No IntersectionObserver (or a non-browser render): show immediately
    // rather than leaving content permanently invisible.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    // Anything already within the viewport (or above it) shows at once.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
    );
    io.observe(el);

    // Safety net: never leave content hidden if the observer never fires
    // (headless capture, print, very tall viewports).
    const failsafe = window.setTimeout(() => setShown(true), 1500);

    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  const Tag = as as any;
  return (
    <Tag
      ref={ref as any}
      className={`mkt-reveal ${className}`}
      data-shown={shown ? 'true' : 'false'}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
};

const NAV_LINKS = [
  { to: '/models', label: 'Models' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
];

export const Wordmark: React.FC<{ dark?: boolean; small?: boolean }> = ({ dark, small }) => (
  <Link to="/" className="flex items-center gap-2.5 group" aria-label="geminirouter home">
    <span
      className={`${small ? 'w-8 h-8' : 'w-9 h-9'} rounded-[10px] bg-[#C25938] flex items-center justify-center shadow-sm transition-transform group-hover:-rotate-3`}
    >
      <span
        className={`font-serif-editorial ${small ? 'text-base' : 'text-lg'} leading-none text-white`}
      >
        g
      </span>
    </span>
    <span
      className={`font-serif-editorial ${small ? 'text-lg' : 'text-xl'} font-semibold tracking-tight ${
        dark ? 'text-white' : 'text-[#191714]'
      }`}
    >
      geminirouter
    </span>
  </Link>
);

export const PublicNav: React.FC = () => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-[#FBF9F5]/85 backdrop-blur-xl border-b border-[#E4DED4]'
          : 'bg-transparent border-b border-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-5 sm:px-8">
        <div className="h-16 flex items-center justify-between">
          <Wordmark />

          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((l) => {
              const active = pathname === l.to || pathname.startsWith(l.to + '/');
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className={`px-3.5 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'text-[#191714] font-medium bg-[#EFEAE2]'
                      : 'text-[#4A453E] hover:text-[#191714] hover:bg-[#EFEAE2]/60'
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>

          <div className="hidden md:flex items-center gap-2">
            <Link
              to="/app"
              className="px-3.5 py-2 rounded-lg text-sm text-[#4A453E] hover:text-[#191714] hover:bg-[#EFEAE2]/60 transition-colors"
            >
              Sign in
            </Link>
            <Link
              to="/app"
              className="group inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors"
            >
              Open dashboard
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <button
            onClick={() => setOpen((v) => !v)}
            className="md:hidden p-2 -mr-2 text-[#191714]"
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="md:hidden border-t border-[#E4DED4] bg-[#FBF9F5]">
          <div className="px-5 py-3 space-y-1">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="block px-3 py-2.5 rounded-lg text-sm text-[#4A453E] hover:bg-[#EFEAE2]"
              >
                {l.label}
              </Link>
            ))}
            <Link
              to="/app"
              className="block px-3 py-2.5 rounded-lg text-sm font-medium bg-[#191714] text-white text-center mt-2"
            >
              Open dashboard
            </Link>
          </div>
        </div>
      )}
    </header>
  );
};

export const PublicFooter: React.FC = () => (
  <footer className="border-t border-[#E4DED4] bg-[#F7F4EF]">
    <div className="max-w-6xl mx-auto px-5 sm:px-8 py-14">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
        <div className="col-span-2 md:col-span-1">
          <Wordmark small />
          <p className="mt-3 text-[13px] leading-relaxed text-[#7A736A] max-w-[220px]">
            A private, self-hosted gateway for Google Antigravity accounts. One endpoint, many
            accounts, honest numbers.
          </p>
        </div>

        <div>
          <div className="mkt-eyebrow mb-3">Product</div>
          <ul className="space-y-2.5 text-[13px]">
            <li>
              <Link to="/models" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Models
              </Link>
            </li>
            <li>
              <Link to="/pricing" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Pricing
              </Link>
            </li>
            <li>
              <Link to="/docs" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                API reference
              </Link>
            </li>
            <li>
              <Link to="/app" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Dashboard
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <div className="mkt-eyebrow mb-3">Developers</div>
          <ul className="space-y-2.5 text-[13px]">
            <li>
              <Link to="/docs#quickstart" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Quickstart
              </Link>
            </li>
            <li>
              <Link to="/docs#openai" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                OpenAI SDK
              </Link>
            </li>
            <li>
              <Link to="/docs#errors" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Error codes
              </Link>
            </li>
            <li>
              <Link to="/docs#limits" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Rate limits
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <div className="mkt-eyebrow mb-3">Legal</div>
          <ul className="space-y-2.5 text-[13px]">
            <li>
              <Link to="/privacy" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Privacy
              </Link>
            </li>
            <li>
              <Link to="/terms" className="text-[#4A453E] hover:text-[#C25938] transition-colors">
                Terms
              </Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-12 pt-6 border-t border-[#E4DED4] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <p className="text-[12px] text-[#7A736A]">
          Self-hosted. Your tokens never leave your server.
        </p>
        <p className="text-[12px] text-[#A39C92] font-mono-code">
          © {new Date().getFullYear()} geminirouter
        </p>
      </div>
    </div>
  </footer>
);
