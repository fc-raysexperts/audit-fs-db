import AutoLoad from './AutoLoad';
import { longDate } from '../../lib/format.mjs';

/** Sits at the top of each page: says when the figures are not today's, and loads them. Renders nothing when they are. */
export default function Banner({ view }) {
  // update-20: the CWIP tab is read in two runs on an empty cache (100 journals and bills, then the rest): the second starts by itself
  const cwipMore = Boolean(view.snapshot?.cwip && !view.snapshot.cwip.error && view.snapshot.cwip.complete === false);
  const h = view.snapshot?.register?.history; // update-29: the entries of the fixed assets (Dep.Calc.) are read in runs of 100 as well
  const regMore = Boolean(h && !h.error && h.complete === false && h.stalled !== true);
  const more = view.state === 'fresh' && (cwipMore || regMore);
  if (view.state === 'fresh' && !more) return null;
  return <AutoLoad state={view.state} more={more} what={cwipMore ? 'CWIP' : 'Dep.Calc.'} canRefresh={view.canRefresh} generatedAt={view.generatedAt} savedLabel={`from ${longDate(view.snapshot?.meta.istDate)}`} />;
}
