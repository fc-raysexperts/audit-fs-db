import { NextResponse } from 'next/server';
import { getContext } from '../../lib/data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Small answer for the page's "is the new load ready yet?" check. */
export async function GET() {
  return NextResponse.json(await getContext().status(), { headers: { 'cache-control': 'no-store' } });
}
