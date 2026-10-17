import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// This screen is now a tab of the workbook (one tab for each sheet of the audited Excel file). Old bookmarks and links still arrive here.
export default function Moved() {
  redirect('/workbook/computation');
}
