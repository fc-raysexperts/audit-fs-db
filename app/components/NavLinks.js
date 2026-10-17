'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  ['/', 'Overview'],
  ['/workbook', 'Workbook (sheet tabs)'],
  ['/reconciliation', 'Audit tie-out'],
  ['/parties', 'Customers and suppliers'],
  ['/checks', 'Checks and alerts'],
];

export default function NavLinks({ problems = 0 }) {
  const path = usePathname();
  const on = (href) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="nav" aria-label="Sections">
      {ITEMS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={on(href) ? 'page' : undefined}>
          {label}
          {href === '/checks' && problems > 0 && <span className="badge" aria-label={`${problems} problems`}>{problems}</span>}
        </Link>
      ))}
    </nav>
  );
}
