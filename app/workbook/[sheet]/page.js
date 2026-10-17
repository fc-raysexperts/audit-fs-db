import { notFound, redirect } from 'next/navigation';
import { getView, getContext } from '../../lib/data';
import gate from '../../components/Gate';
import Banner from '../../components/Banner';
import PageHead from '../../components/PageHead';
import SheetTabs from '../../components/SheetTabs';
import SignedSheet from '../../tabs/SignedSheet';
import { BODIES, NOTE_SHEETS, NotesTab } from '../../tabs/bodies';
import { resolveTab } from '../../../lib/tabs.mjs';

export const dynamic = 'force-dynamic';

/** The model of the tab strip, or the plain reason it cannot be built (a wrong `tabs` list in index.json). */
function tabModel() {
  try { return { model: getContext().tabs() }; } catch (e) { return { error: e.message }; }
}

export async function generateMetadata({ params }) {
  const { sheet } = await params;
  const { model } = tabModel();
  const hit = model ? resolveTab(model, sheet) : null;
  return { title: `${hit?.tab?.label ?? 'Workbook'} - RPEL` };
}

/** What a tab shows: for each sheet on it, the live figures (if the sheet has them) and the sheet as signed (if the file has it). */
function TabBody({ view, tab }) {
  const parts = [];
  let notesDone = false;
  for (const id of tab.sheets) {
    if (NOTE_SHEETS.includes(id)) {
      if (!notesDone) { parts.push({ id, notes: tab.sheets.filter((x) => NOTE_SHEETS.includes(x)) }); notesDone = true; }
      continue;
    }
    parts.push({ id });
  }
  return parts.map((p) => {
    const entry = view.workbook?.sheets.find((s) => s.id === p.id);
    if (p.notes) return <NotesTab key="notes" view={view} sheets={p.notes} />;
    const Live = BODIES[p.id];
    const signed = Boolean(entry?.file);
    if (!Live && !signed) {
      return (
        <div key={p.id}>
          <PageHead title={entry?.sheet ?? tab.label}>{entry?.note}</PageHead>
          <div className="notice warn">This sheet has no view set up for FY {view.fy} yet.</div>
        </div>
      );
    }
    return (
      <div key={p.id}>
        {Live && <Live view={view} />}
        {signed && <SignedSheet view={view} id={p.id} withHead={!Live} />}
      </div>
    );
  });
}

export default async function TabPage({ params }) {
  const { sheet: param } = await params;
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;

  const { model, error } = tabModel();
  if (!model) {
    return (
      <>
        <Banner view={view} />
        <PageHead title="Workbook" />
        <div className="notice bad"><b>The tabs could not be set up.</b> The reason: {error}</div>
      </>
    );
  }
  const hit = resolveTab(model, param);
  if (!hit) notFound();
  if (hit.redirect) redirect(hit.redirect);
  const { tab } = hit;
  return (
    <>
      <Banner view={view} />
      <SheetTabs tabs={model.tabs} active={tab.id} />
      <TabBody view={view} tab={tab} />
    </>
  );
}
