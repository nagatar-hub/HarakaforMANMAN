import { NextRequest, NextResponse } from 'next/server';
import {
  OPERATOR_SESSION_COOKIE,
  isOperatorEmailAllowed,
  operatorAuthRequiredFromEnv,
  operatorAuthSecretFromEnv,
  verifyOperatorSession,
} from '@/lib/operator-auth';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (!operatorAuthRequiredFromEnv()) {
    return NextResponse.next();
  }

  const secretResult = operatorAuthSecretFromEnv();
  const session = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  if (secretResult.ok && session) {
    const verified = await verifyOperatorSession({
      session,
      secret: secretResult.value,
    });
    if (verified.ok && isOperatorEmailAllowed(verified.value.email)) {
      return NextResponse.next();
    }
  }

  const loginUrl = new URL('/api/auth/google', request.url);
  loginUrl.searchParams.set('target', 'operator');
  loginUrl.searchParams.set('return_to', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/runs/:path*',
    '/custom-buyback/:path*',
    '/db/:path*',
    '/tags/:path*',
    '/settings/:path*',
    '/gallery/:path*',
    '/post/:path*',
  ],
};
