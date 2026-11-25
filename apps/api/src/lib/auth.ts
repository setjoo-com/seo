import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { db, schema } from "../db";
import { env } from "../env";
import { identify, track } from "./analytics";

const list = (value: string | undefined) =>
  (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
const allowedEmails = list(env.AUTH_ALLOWED_EMAILS);
const allowedDomains = list(env.AUTH_ALLOWED_EMAIL_DOMAINS);

// With no allow list every email may sign up; with one, only those emails and domains.
export function emailMayRegister(email: string) {
  if (!allowedEmails.length && !allowedDomains.length) return true;
  const normalized = email.trim().toLowerCase();
  return allowedEmails.includes(normalized) || allowedDomains.includes(normalized.split("@").pop() ?? "");
}

export const SETJOO_PROVIDER_ID = "setjoo";
export const ssoEnabled = Boolean(env.SETJOO_SSO_ISSUER);
export const emailSignUpEnabled = env.AUTH_EMAIL_SIGNUP === "true";

// The app proxies /api/* to this server, so auth cookies are first-party to APP_URL.
export const auth = betterAuth({
  baseURL: env.APP_URL,
  basePath: "/api/auth",
  secret: env.AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 8, disableSignUp: !emailSignUpEnabled },
  plugins: ssoEnabled
    ? [
        genericOAuth({
          config: [
            {
              providerId: SETJOO_PROVIDER_ID,
              discoveryUrl: `${env.SETJOO_SSO_ISSUER!.replace(/\/$/, "")}/.well-known/openid-configuration`,
              clientId: env.SETJOO_SSO_CLIENT_ID,
              // Public client: PKCE instead of a secret, client_id sent in the token request body.
              pkce: true,
              authentication: "post",
              scopes: ["openid", "profile", "email"],
            },
          ],
        }),
      ]
    : [],
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  // Sign-ups and sign-ins for product analytics (lib/analytics.ts); nothing is sent without POSTHOG_KEY.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!emailMayRegister(user.email)) {
            throw new APIError("FORBIDDEN", { message: "This email is not allowed to create an account here." });
          }
        },
        after: async (user) => {
          identify(user.id, { email: user.email, name: user.name, signed_up_at: user.createdAt.toISOString() });
          track(user.id, "user_signed_up", { method: "email" });
        },
      },
    },
    session: {
      create: {
        after: async (session) => track(session.userId, "user_signed_in"),
      },
    },
  },
  // Sign-in rate limits key on the visitor's address. Behind an edge proxy that is the header it
  // sets (CLIENT_IP_HEADER); without one, every visitor would share a single bucket.
  ...(env.CLIENT_IP_HEADER ? { advanced: { ipAddress: { ipAddressHeaders: [env.CLIENT_IP_HEADER.toLowerCase()] } } } : {}),
});
