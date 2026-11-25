"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { ApiError } from "@/lib/api";
import { type AuthOptions, getAuthOptions, signIn, signInWithSso, signUp } from "@/lib/auth";
import { Button, ErrorNote, Field, Input } from "./ui";

// The website with the terms and privacy policy. Unset (a bare self-hosted app), the sign-up note is left out.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  // Where to go after signing in, for example back to a connection request. Same-site paths only.
  const nextParam = useSearchParams().get("next");
  // Same-site paths only, with no whitespace, control characters or backslashes: the URL parser
  // strips tabs and newlines, so "/\t/evil.com" would otherwise become "//evil.com".
  const next = nextParam && /^\/(?![/\\])[^\s\x00-\x1f\\]*$/.test(nextParam) ? nextParam : null;
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  // The API may also report an error the sign-on provider sent back to /sign-in.
  const ssoError = useSearchParams().get("error");
  useEffect(() => {
    getAuthOptions().then(setOptions, () => setOptions({ sso: null, emailSignUp: true }));
  }, []);
  // With email sign-up off, the sign-up page only offers single sign-on.
  const emailFormShown = mode === "sign-in" || options?.emailSignUp !== false;
  const isSignUp = mode === "sign-up";

  async function onSso() {
    if (!options?.sso) return;
    setPending(true);
    setError(null);
    try {
      await signInWithSso(options.sso.providerId, next);
    } catch (caught) {
      setError(caught);
      setPending(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      if (isSignUp) await signUp(String(form.get("name") ?? ""), email, password);
      else await signIn(email, password);
      track(isSignUp ? "sign_up_form_completed" : "sign_in_form_completed");
      // New accounts start with the welcome flow; the app sends unfinished ones there too.
      router.replace(next ?? (isSignUp ? "/welcome" : "/projects"));
    } catch (caught) {
      track(isSignUp ? "sign_up_form_failed" : "sign_in_form_failed", { error: caught instanceof ApiError ? caught.code || String(caught.status) : "network" });
      setError(caught);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-line bg-surface p-5">
      <h1 className="font-display text-lg font-semibold">{isSignUp ? "Create your account" : "Sign in"}</h1>
      {options?.sso && (
        <>
          <Button type="button" variant="primary" loading={pending} onClick={onSso} className="w-full">
            Continue with {options.sso.name}
          </Button>
          {emailFormShown && <p className="text-center text-[13px] text-muted">or with email</p>}
        </>
      )}
      {ssoError && !error && <ErrorNote error={ssoError === "signup_disabled" ? "This account is not allowed to sign up here." : `Sign-in failed (${ssoError}).`} />}
      {!emailFormShown && <ErrorNote error={error} />}
      {!emailFormShown && !options?.sso && <p className="text-sm text-muted">Sign-ups are closed.</p>}
      {emailFormShown && (
        <>
          {isSignUp && (
            <Field label="Name">
              <Input name="name" autoComplete="name" required maxLength={80} />
            </Field>
          )}
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" hint={isSignUp ? "At least 8 characters." : undefined}>
            <Input name="password" type="password" autoComplete={isSignUp ? "new-password" : "current-password"} required minLength={8} />
          </Field>
          <ErrorNote error={error} />
        </>
      )}
      {isSignUp && SITE_URL && (options?.sso || emailFormShown) && (
        <p className="text-[13px] text-muted">
          By creating an account you agree to the{" "}
          <a href={`${SITE_URL}/terms`} className="underline underline-offset-2">
            terms of service
          </a>{" "}
          and{" "}
          <a href={`${SITE_URL}/privacy`} className="underline underline-offset-2">
            privacy policy
          </a>
          .
        </p>
      )}
      {emailFormShown && (
        <Button type="submit" variant={options?.sso ? "secondary" : "primary"} loading={pending} className="w-full">
          {isSignUp ? "Create account" : "Sign in"}
        </Button>
      )}
      {/* With email sign-up off, new people come in through single sign-on, so there is no sign-up link. */}
      {(isSignUp || options?.emailSignUp !== false) && (
        <p className="text-center text-[13px] text-muted">
          {isSignUp ? "Already have an account? " : "New here? "}
          <Link href={`${isSignUp ? "/sign-in" : "/sign-up"}${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-ink underline underline-offset-2">
            {isSignUp ? "Sign in" : "Create an account"}
          </Link>
        </p>
      )}
    </form>
  );
}
