'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { tabHref } from '../../lib/tabs.mjs';

const STATUS_TEXT = { live: 'live from Zoho Books', semi: 'part live', fixed: 'as signed' };

/**
 * The tab strip of the workbook screen: one tab for each sheet of the audited Excel file, in the order of the file. The dot says how much of
 * the sheet comes from Zoho Books (filled = live, half = part live, hollow = as signed). On a phone the strip scrolls sideways and the open tab is brought into view.
 * @param {{tabs:{id:string,label:string,status:string|null,note?:string}[], active:string}} p
 */
export default function SheetTabs({ tabs, active }) {
  const strip = useRef(null);
  useEffect(() => {
    const el = strip.current?.querySelector('[aria-current="page"]');
    if (el && strip.current && strip.current.scrollWidth > strip.current.clientWidth + 2 && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, [active]);

  return (
    <div className="tabs-wrap">
      <nav aria-label="Sheets of the workbook" ref={strip} className="tabs-nav">
        <ul className="tabs">
          {tabs.map((t) => (
            <li key={t.id}>
              <Link href={tabHref(t.id)} prefetch={false} className={`tab ${t.status ?? 'index'}`} aria-current={t.id === active ? 'page' : undefined} title={t.note || undefined}>
                {t.status && <span className="dot" aria-hidden="true" />}
                {t.label}
                {t.status && <span className="sr-only"> ({STATUS_TEXT[t.status] ?? t.status})</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="tab-key" aria-hidden="true">
        <span><span className="dot" />Live from Zoho</span>
        <span><span className="dot semi" />Part live</span>
        <span><span className="dot fixed" />As signed</span>
      </p>
    </div>
  );
}
