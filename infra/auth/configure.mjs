// Applies the Firebase Authentication settings the app relies on
// (docs/firebase-migration.md, phase 2). Idempotent; prints the diff.
//
//   - Email/Password sign-in on (passwordless email links off).
//   - Email templates in the app's language: `notification.defaultLocale`
//     is used when a request carries no language. The browser sets
//     `auth.languageCode` from NEXT_PUBLIC_APP_LOCALE, so this is the
//     fallback, not the only source.
//   - The action URL of every email (verify, reset, email change) →
//     `<site>/auth/action`, the app's own handler page, instead of
//     Firebase's hosted one.
//   - The site's host in the authorized domains, so continue URLs and
//     sign-in from it are accepted.
//
// Env:
//   SITE_URL                   e.g. https://crm.example.com (required)
//   AUTH_EMAIL_LOCALE          default: pt-BR
//   GOOGLE_OAUTH_ACCESS_TOKEN  e.g. $(gcloud auth print-access-token)
//   FIREBASE_PROJECT           default: crm-zap-cbd5d
//
// Flags:
//   --dry-run   print what would change, change nothing

const PROJECT = process.env.FIREBASE_PROJECT || 'crm-zap-cbd5d'
const SITE_URL = required('SITE_URL').replace(/\/+$/, '')
const LOCALE = process.env.AUTH_EMAIL_LOCALE || 'pt-BR'
const TOKEN = required('GOOGLE_OAUTH_ACCESS_TOKEN')
const dryRun = process.argv.includes('--dry-run')

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing env var ${name}`)
    process.exit(1)
  }
  return value
}

const CONFIG_URL = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`
const headers = {
  authorization: `Bearer ${TOKEN}`,
  'x-goog-user-project': PROJECT,
  'content-type': 'application/json',
}

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} config failed: ${json.error?.message ?? res.status}`)
  return json
}

const current = await call('GET', CONFIG_URL)
const host = new URL(SITE_URL).hostname
const domains = current.authorizedDomains ?? []

const wanted = {
  'signIn.email.enabled': [current.signIn?.email?.enabled, true],
  'signIn.email.passwordRequired': [current.signIn?.email?.passwordRequired, true],
  'notification.defaultLocale': [current.notification?.defaultLocale, LOCALE],
  'notification.sendEmail.callbackUri': [
    current.notification?.sendEmail?.callbackUri,
    `${SITE_URL}/auth/action`,
  ],
  authorizedDomains: [domains, domains.includes(host) ? domains : [...domains, host]],
}

const changed = Object.entries(wanted).filter(
  ([, [from, to]]) => JSON.stringify(from) !== JSON.stringify(to),
)
if (changed.length === 0) {
  console.log('Firebase Auth already configured.')
  process.exit(0)
}
for (const [field, [from, to]] of changed) {
  console.log(`${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`)
}
if (dryRun) process.exit(0)

// Build the PATCH body from the dotted field names.
const body = {}
for (const [field, [, to]] of changed) {
  const parts = field.split('.')
  let node = body
  for (const part of parts.slice(0, -1)) node = node[part] ??= {}
  node[parts.at(-1)] = to
}
await call('PATCH', `${CONFIG_URL}?updateMask=${changed.map(([f]) => f).join(',')}`, body)
console.log('Firebase Auth updated.')
