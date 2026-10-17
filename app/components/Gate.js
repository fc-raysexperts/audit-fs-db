import AutoLoad from './AutoLoad';

/**
 * What to show instead of a page when there is nothing to show: no storage, a storage error, or the very first load of all.
 * Returns null when the page can render normally.
 */
export default function gate(view) {
  if (view.state === 'error') {
    return (
      <div className="empty">
        <h1>The figures cannot be read</h1>
        <p>{view.message}</p>
        <p>Fix this in the <code>.env</code> file (on your computer) or in the Vercel project settings, then reload.</p>
      </div>
    );
  }
  if (view.state === 'empty') {
    return (
      <div className="empty">
        <h1>Nothing is loaded for FY {view.fy} yet</h1>
        <p>{view.canRefresh ? 'The first load reads the Trial Balance, receivables, supplier ledger and journals from Zoho Books. It takes about 30 seconds and then stays ready all day.' : 'Zoho Books loading is not set up here, so there is nothing to show.'}</p>
        <AutoLoad state="empty" canRefresh={view.canRefresh} generatedAt={null} savedLabel="" />
      </div>
    );
  }
  return null;
}
