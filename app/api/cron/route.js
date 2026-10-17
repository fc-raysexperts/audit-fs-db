import { NextResponse } from 'next/server';
import { getContext } from '../../lib/data';
import { cronAllowed } from '../../../lib/server.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** The morning job (vercel.json: 05:30 India time). Vercel sends "Authorization: Bearer <CRON_SECRET>". */
export async function GET(request) {
  const ok = cronAllowed({
    authorization: request.headers.get('authorization') ?? undefined,
    secret: process.env.CRON_SECRET || '',
    production: process.env.NODE_ENV === 'production',
  });
  if (!ok) return NextResponse.json({ status: 'denied', message: 'Not allowed.' }, { status: 401 });
  const result = await getContext().refresh({ manual: false });
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 });
}
