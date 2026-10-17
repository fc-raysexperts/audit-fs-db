import { NextResponse } from 'next/server';

// Optional sign-in. With DASH_PASSWORD set (Vercel settings, or .env) the whole site asks for a user name and password.
// Without it the site is open - fine on your own computer, not on the internet. The morning job has its own secret.
export function middleware(request) {
  const password = process.env.DASH_PASSWORD;
  if (!password) return NextResponse.next();
  const user = process.env.DASH_USER || 'rays';
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const [u, ...rest] = atob(header.slice(6)).split(':');
      const p = rest.join(':');
      if (same(u, user) & same(p, password)) return NextResponse.next();
    } catch { /* fall through to the prompt */ }
  }
  return new NextResponse('Sign in to see the financial statements.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="RPEL financial statements", charset="UTF-8"' } });
}

// compares without stopping at the first difference
function same(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 ? 1 : 0;
}

export const config = { matcher: ['/((?!api/cron|_next/static|_next/image|favicon.ico).*)'] };
