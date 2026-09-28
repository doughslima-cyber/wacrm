import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, verifySessionCookie } from '@/lib/auth/session'

// Next 16 `proxy` (formerly middleware) — always runs on Node.js, which
// firebase-admin needs. Only answers "is there a valid session?"; the
// uuid lookup and RLS happen where data is actually read.
//
// Firebase session cookies have a fixed lifetime and are never
// refreshed in flight, so unlike the Supabase version there are no
// rotated cookies to carry onto redirects (issue #288 can't recur).
export async function proxy(request: NextRequest) {
  // Verification throws only when the revocation check can't reach
  // Firebase and has nothing cached; treat that as signed out.
  const user = await verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value).catch(
    (err) => {
      console.error('[proxy] session check failed:', err)
      return null
    },
  )

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next({ request })
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
