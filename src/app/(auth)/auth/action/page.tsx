"use client";

// ============================================================
// /auth/action — where the links in Firebase Auth emails land.
//
// Firebase appends `mode`, `oobCode` and `continueUrl` to the action
// URL configured for the project (infra/auth/configure.mjs points it
// here). One page handles every mode:
//
//   verifyEmail            confirm a new account's email
//   resetPassword          choose a new password
//   verifyAndChangeEmail   confirm a new sign-in email
//   recoverEmail           undo an email change
//
// `continueUrl` is where the flow started (e.g. /join/<token>); only
// same-origin values are followed.
// ============================================================

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle, KeyRound, Loader2 } from "lucide-react";
import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
} from "firebase/auth";

import { firebaseAuth } from "@/lib/firebase/client";
import { toAuthError } from "@/lib/firebase/auth-flows";
import { useAuthErrorMessage } from "@/hooks/use-auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Mode = "verifyEmail" | "resetPassword" | "verifyAndChangeEmail" | "recoverEmail";

type State =
  | { step: "loading" }
  | { step: "invalid" }
  | { step: "choosePassword"; email: string }
  | { step: "done"; mode: Mode; email?: string };

const MIN_PASSWORD = 6;

function isMode(value: string | null): value is Mode {
  return (
    value === "verifyEmail" ||
    value === "resetPassword" ||
    value === "verifyAndChangeEmail" ||
    value === "recoverEmail"
  );
}

/** A same-origin path to continue to, or /login. */
function safeContinue(raw: string | null): string {
  if (!raw) return "/login";
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}` : "/login";
  } catch {
    return "/login";
  }
}

// Codes are single-use, and dev Strict Mode runs effects twice: the
// second applyActionCode would fail on the code the first one spent.
const handled = new Map<string, Promise<State>>();

function handleCode(mode: Mode, oobCode: string): Promise<State> {
  let result = handled.get(oobCode);
  if (!result) {
    result = (async (): Promise<State> => {
      const auth = firebaseAuth();
      try {
        if (mode === "resetPassword") {
          // Only checks the code; confirmPasswordReset spends it.
          return { step: "choosePassword", email: await verifyPasswordResetCode(auth, oobCode) };
        }
        if (mode === "recoverEmail") {
          const info = await checkActionCode(auth, oobCode);
          await applyActionCode(auth, oobCode);
          return { step: "done", mode, email: info.data.email ?? undefined };
        }
        await applyActionCode(auth, oobCode);
        return { step: "done", mode };
      } catch {
        return { step: "invalid" };
      }
    })();
    handled.set(oobCode, result);
  }
  return result;
}

export default function AuthActionPage() {
  return (
    <Suspense fallback={null}>
      <AuthActionInner />
    </Suspense>
  );
}

function AuthActionInner() {
  const t = useTranslations("AuthActionPage");
  const authErrorMessage = useAuthErrorMessage();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode");
  const continueUrl = searchParams.get("continueUrl");

  const [state, setState] = useState<State>({ step: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    if (!isMode(mode) || !oobCode) {
      setState({ step: "invalid" });
      return;
    }
    let cancelled = false;
    handleCode(mode, oobCode).then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode]);

  const onChoosePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.step !== "choosePassword" || !oobCode) return;
    if (password.length < MIN_PASSWORD) {
      setError(t("passwordTooShort", { min: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordsMismatch"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await confirmPasswordReset(firebaseAuth(), oobCode, password);
      setState({ step: "done", mode: "resetPassword", email: state.email });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "auth/expired-action-code" || code === "auth/invalid-action-code") {
        setState({ step: "invalid" });
      } else {
        setError(authErrorMessage(toAuthError(err)));
      }
    } finally {
      setSaving(false);
    }
  };

  const onSendReset = async (email: string) => {
    try {
      await sendPasswordResetEmail(firebaseAuth(), email);
      setResetSent(true);
    } catch (err) {
      setError(authErrorMessage(toAuthError(err)));
    }
  };

  if (state.step === "loading") {
    return (
      <Shell>
        <CardContent className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Shell>
    );
  }

  if (state.step === "invalid") {
    return (
      <Shell
        icon={<AlertTriangle className="h-6 w-6 text-primary" />}
        title={t("invalidTitle")}
        description={t("invalidDesc")}
      >
        <CardContent className="flex flex-col gap-2">
          <Link href="/forgot-password">
            <Button className="w-full">{t("requestNewLink")}</Button>
          </Link>
          <Link href="/login">
            <Button variant="outline" className="w-full">
              {t("backToSignIn")}
            </Button>
          </Link>
        </CardContent>
      </Shell>
    );
  }

  if (state.step === "choosePassword") {
    return (
      <Shell
        icon={<KeyRound className="h-6 w-6 text-primary" />}
        title={t("resetTitle")}
        description={t.rich("resetDesc", {
          email: state.email,
          strong: (chunks) => <span className="text-foreground">{chunks}</span>,
        })}
      >
        <CardContent>
          <form onSubmit={onChoosePassword} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("newPasswordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm" className="text-muted-foreground">
                {t("confirmPasswordLabel")}
              </Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
            </div>
            <Button type="submit" disabled={saving} className="mt-2 h-10 w-full">
              {saving ? t("saving") : t("savePassword")}
            </Button>
          </form>
        </CardContent>
      </Shell>
    );
  }

  // done
  const next = safeContinue(continueUrl);
  const copy = {
    verifyEmail: { title: t("verifiedTitle"), desc: t("verifiedDesc") },
    resetPassword: { title: t("passwordChangedTitle"), desc: t("passwordChangedDesc") },
    verifyAndChangeEmail: { title: t("emailChangedTitle"), desc: t("emailChangedDesc") },
    recoverEmail: {
      title: t("emailRecoveredTitle"),
      desc: t("emailRecoveredDesc", { email: state.email ?? "" }),
    },
  }[state.mode];

  return (
    <Shell
      icon={<CheckCircle className="h-6 w-6 text-primary" />}
      title={copy.title}
      description={copy.desc}
    >
      <CardContent className="flex flex-col gap-2">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        {state.mode === "recoverEmail" && state.email && (
          <Button
            variant="outline"
            className="w-full"
            disabled={resetSent}
            onClick={() => onSendReset(state.email!)}
          >
            {resetSent ? t("resetSent") : t("sendReset")}
          </Button>
        )}
        {/* Full navigation: the proxy decides where a signed-in user goes. */}
        <Button className="w-full" onClick={() => (window.location.href = next)}>
          {t("continue")}
        </Button>
      </CardContent>
    </Shell>
  );
}

function Shell({
  icon,
  title,
  description,
  children,
}: {
  icon?: React.ReactNode;
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        {title && (
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              {icon}
            </div>
            <CardTitle className="text-xl text-foreground">{title}</CardTitle>
            {description && (
              <CardDescription className="text-muted-foreground">{description}</CardDescription>
            )}
          </CardHeader>
        )}
        {children}
      </Card>
    </div>
  );
}
