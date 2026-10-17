import { NextResponse } from 'next/server';
import { getContext } from '../../lib/data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // a first load with nothing cached takes about 30 s

/** The Refresh button (manual: true) and the automatic first load of the day (manual: false). */
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const result = await getContext().refresh({ manual: body.manual !== false });
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 });
}
