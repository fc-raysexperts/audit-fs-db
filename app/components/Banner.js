import AutoLoad from './AutoLoad';
import { longDate } from '../../lib/format.mjs';

/** Sits at the top of each page: says when the figures are not today's, and loads them. Renders nothing when they are. */
export default function Banner({ view }) {
  // update-20: the CWIP tab is read in two runs on an empty cache (100 journals, then the rest): the second starts by itself
  const more = view.state === 'fresh' && Boolean(view.snapshot?.cwip && !view.snapshot.cwip.error && view.snapshot.cwip.complete === false);
  if (view.state === 'fresh' && !more) return null;
  return <AutoLoad state={view.state} more={more} canRefresh={view.canRefresh} generatedAt={view.generatedAt} savedLabel={`from ${longDate(view.snapshot?.meta.istDate)}`} />;
}
