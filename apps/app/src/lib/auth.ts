import { api } from "./api";

export type Me = {
  user: { id: string; email: string; name: string };
  settings: { hasYepapiKey: boolean; yepapiKeyHint: string | null; yepapiKeyCheckedAt: string | null; monthlyBudgetUsd: number | null; onboardedAt: string | null };
  /** This install's agent endpoint and docs, for the agent setup prompt. */
  links?: { mcpUrl: string; docsUrl: string };
};

export const signIn = (email: string, password: string) =>
  api("/auth/sign-in/email", { method: "POST", body: { email, password } });

export const signUp = (name: string, email: string, password: string) =>
  api("/auth/sign-up/email", { method: "POST", body: { name, email, password } });

export type AuthOptions = { sso: { providerId: string; name: string } | null; emailSignUp: boolean };

export const getAuthOptions = () => api<AuthOptions>("/auth-options");

// Starts single sign-on: the API answers with the provider's authorize URL, and the browser goes there.
export async function signInWithSso(providerId: string, next: string | null) {
  // better-auth 1.7 serves generic OAuth providers through the core social sign-in route.
  const { url } = await api<{ url: string }>("/auth/sign-in/social", {
    method: "POST",
    body: { provider: providerId, callbackURL: next ?? "/projects", newUserCallbackURL: "/welcome", errorCallbackURL: "/sign-in", disableRedirect: true },
  });
  window.location.assign(url);
}

export const signOut = () => api("/auth/sign-out", { method: "POST", body: {} });
