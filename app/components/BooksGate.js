/** What to show instead of a booklet page when the notes could not be built (or are not set up for this year). Null when fine. */
export default function booksGate(view) {
  if (view.booksError) {
    return (
      <div className="notice bad">
        <b>This page could not be built.</b> The Balance Sheet and Profit and Loss are not affected. The reason: {view.booksError}
      </div>
    );
  }
  if (!view.books) {
    return (
      <div className="notice warn">
        The notes, cash flow and other workings are not set up for FY {view.fy} yet. They need their own files in the <code>config</code> folder (see the README, "A new financial year").
      </div>
    );
  }
  return null;
}
