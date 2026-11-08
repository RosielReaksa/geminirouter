import type React from 'react';
import { navigate } from './router';

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
}

/** Anchor that performs client-side navigation but stays a real link. */
export const Link: React.FC<LinkProps> = ({ to, replace, children, onClick, ...rest }) => {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    // Let modifier-clicks and middle-clicks behave normally.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to, { replace });
  };

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
};
