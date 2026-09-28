// Browser-only: the Firebase app and its Auth instance.
//
// Firebase Auth is the identity provider (docs/firebase-migration.md,
// phase 2). The app's own session is still the httpOnly `__session`
// cookie the server mints from an ID token; the SDK's signed-in state
// is kept as well because Storage and Firestore rules (phases 3 and 4)
// authorize the browser by its ID token.
//
// Loaded on demand (see src/lib/supabase/client.ts) so pages that
// never touch auth don't ship the SDK.

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from "firebase/auth";

// Email templates (verification, password reset, email change) follow
// the UI language. Firebase's locale codes for the app's catalogues.
const EMAIL_LOCALE: Record<string, string> = {
  en: "en",
  pt: "pt-BR",
  es: "es-419",
  ko: "ko",
};

let auth: Auth | undefined;

function firebaseApp(): FirebaseApp {
  return (
    getApps()[0] ??
    initializeApp({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain:
        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
        `${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    })
  );
}

export function firebaseAuth(): Auth {
  if (auth) return auth;
  // initializeAuth rather than getAuth: no popup/redirect resolver,
  // so the SDK never loads the authDomain iframe or gapi — email and
  // password need neither, and the CSP stays small.
  const app = firebaseApp();
  try {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    });
  } catch {
    // Already initialized: this module was re-evaluated (HMR) while
    // the Firebase app lived on.
    auth = getAuth(app);
  }
  auth.languageCode = EMAIL_LOCALE[process.env.NEXT_PUBLIC_APP_LOCALE ?? "en"] ?? "en";
  return auth;
}
