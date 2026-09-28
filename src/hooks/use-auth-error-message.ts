'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import type { AuthError } from '@/lib/supabase/app-client';

/** The translated text for an auth error, by its code; the English
 *  message when the code has no entry in AuthErrors. */
export function useAuthErrorMessage() {
  const t = useTranslations('AuthErrors');
  return useCallback(
    (error: AuthError) => (error.code && t.has(error.code) ? t(error.code) : error.message),
    [t],
  );
}
