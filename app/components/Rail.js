import NavLinks from './NavLinks';
import UnitSwitch from './UnitSwitch';
import RefreshButton from './RefreshButton';
import { istStamp, longDate, ago } from '../../lib/format.mjs';

function Snap({ view }) {
  if (!view.generatedAt) return <div className="snap"><b>Nothing loaded yet</b></div>;
  const m = view.snapshot.meta;
  const [headline, cls] =
    view.state === 'fresh' ? ["Today's figures", ''] :
    view.state === 'stale' ? [`Figures from ${longDate(m.istDate)}`, 'stale'] :
    ['Run with errors', 'flawed'];
  return (
    <div className="snap">
      <b className={cls}>{headline}</b>
      Loaded {istStamp(view.generatedAt)}, {ago(view.generatedAt)}
    </div>
  );
}

export default function Rail({ view }) {
  const h = view.statements?.health;
  const problems = (h ? h.failedChecks.length + h.errors : 0) + (view.bookProblems ?? 0);
  return (
    <aside className="rail">
      <div>
        <p className="brand">Rays Power Experts</p>
        <p className="brand-sub">Standalone financial statements, live from Zoho Books</p>
      </div>
      <div className="period">
        <strong>FY {view.fy}</strong>
        {view.snapshot && <span>as at {longDate(view.snapshot.meta.asOf)}</span>}
      </div>
      <NavLinks problems={problems} />
      <div className="rail-foot">
        <UnitSwitch />
        <Snap view={view} />
        <RefreshButton canRefresh={view.canRefresh} generatedAt={view.generatedAt} />
      </div>
    </aside>
  );
}
