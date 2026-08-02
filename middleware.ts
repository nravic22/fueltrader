import { NextRequest, NextResponse } from 'next/server';

export const config = {
  // Everything except Next's own static/image assets — pages and /api routes
  // (including /api/query) all sit behind auth, not just the UI shell.
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function middleware(req: NextRequest) {
  const expectedUser = process.env.SITE_BASIC_AUTH_USER;
  const expectedPass = process.env.SITE_BASIC_AUTH_PASSWORD;

  // Not configured (e.g. local dev) — skip auth entirely rather than lock
  // everyone out. Not recommended left unset in production, see README.
  if (!expectedUser || !expectedPass) {
    return NextResponse.next();
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice('Basic '.length));
    const separatorIndex = decoded.indexOf(':');
    const suppliedUser = decoded.slice(0, separatorIndex);
    const suppliedPass = decoded.slice(separatorIndex + 1);

    if (timingSafeEqual(suppliedUser, expectedUser) && timingSafeEqual(suppliedPass, expectedPass)) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Fuel Trader", charset="UTF-8"' },
  });
}
