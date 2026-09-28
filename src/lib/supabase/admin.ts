// Server-only: the single service-role client. RLS is bypassed
// (service_role has BYPASSRLS, as on Supabase), so every query made
// with it MUST be scoped by account explicitly.
//
// Used by the WhatsApp webhook, the automation / flow engines, the AI
// auto-reply, the public API (/api/v1) and the session lookup. The old
// per-module copies in src/lib/{ai,automations,flows}/admin-client.ts
// now re-export this one.

import { AppClient, noUserAuth, type SupabaseClient } from "./app-client";
import { postgrestUrl, signedPostgrestFetch } from "./postgrest";

let adminClient: SupabaseClient | null = null;

// Lazy so importing a route module at build time never needs the env.
export function supabaseAdmin(): SupabaseClient {
  adminClient ??= new AppClient(postgrestUrl(), {
    fetch: signedPostgrestFetch(async () => ({ role: "service_role" })),
    auth: noUserAuth,
  });
  return adminClient;
}
