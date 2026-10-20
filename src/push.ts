import { createRemoteJWKSet, jwtVerify } from "jose";
import { access, type Account } from "./providers";
import { boundedJson, equal, json, randomToken } from "./security";
import { poll } from "./poll";
// Mailbox push: Gmail publishes to a Pub/Sub topic whose push subscription
// calls /hooks/gmail; Outlook calls /hooks/outlook through a Graph
// subscription. Each call triggers an inbox check. The cron renews the
// subscriptions and still checks accounts that have no live push.
export type PushEnv = {
  GMAIL_PUBSUB_TOPIC?: string;
  GMAIL_PUSH_SERVICE_ACCOUNT?: string;
};
declare global {
  interface Env extends PushEnv {}
}
type Watch = {
  account_id: string;
  subscription_id: string | null;
  secret: string | null;
  expires_at: number;
  retry_at: number;
};
const RENEW_BEFORE = 24 * 3600000,
  RETRY_AFTER = 3600000,
  OUTLOOK_LIFETIME = 3 * 24 * 3600000;
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export function gmailPushEnabled(env: Env): boolean {
  return Boolean(
    env.GMAIL_PUBSUB_TOPIC?.trim() && env.GMAIL_PUSH_SERVICE_ACCOUNT?.trim(),
  );
}
// Pub/Sub push carries a Google-signed OIDC token for the subscription's
// service account, with the hook URL as audience.
async function fromPubSub(request: Request, env: Env): Promise<boolean> {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.PUBLIC_BASE_URL + "/hooks/gmail",
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "email"],
    });
    return (
      payload.email_verified === true &&
      payload.email === env.GMAIL_PUSH_SERVICE_ACCOUNT!.trim()
    );
  } catch {
    return false;
  }
}
export async function hook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  if (path === "/hooks/gmail") {
    if (!gmailPushEnabled(env)) return json({ error: "Not found" }, 404);
    if (!(await fromPubSub(request, env)))
      return json({ error: "Unauthorized" }, 401);
    ctx.waitUntil(poll(env));
    return new Response(null, { status: 204 });
  }
  if (path === "/hooks/outlook") {
    // Graph validates a new subscription by echoing this token as plain text.
    const validation = new URL(request.url).searchParams.get("validationToken");
    if (validation !== null)
      return new Response(validation.slice(0, 1024), {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    const body = await boundedJson<{
      value?: { subscriptionId?: unknown; clientState?: unknown }[];
    }>(new Response(request.body), 100_000);
    let valid = false;
    for (const n of Array.isArray(body.value) ? body.value : []) {
      if (typeof n.subscriptionId !== "string") continue;
      const row = await env.DB.prepare(
        "SELECT secret FROM watches WHERE subscription_id=?",
      )
        .bind(n.subscriptionId)
        .first<{ secret: string }>();
      if (
        row?.secret &&
        typeof n.clientState === "string" &&
        (await equal(n.clientState, row.secret))
      )
        valid = true;
    }
    if (!valid) return json({ error: "Unauthorized" }, 401);
    ctx.waitUntil(poll(env));
    return new Response(null, { status: 202 });
  }
  return json({ error: "Not found" }, 404);
}
async function call<T>(
  url: string,
  token: string,
  method: string,
  body: unknown,
): Promise<{ status: number; data?: T }> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status };
  }
  return { status: response.status, data: await boundedJson<T>(response) };
}
async function renew(
  account: Account,
  watch: Watch | null,
  env: Env,
): Promise<Partial<Watch> | null> {
  if (account.provider === "gmail" && !gmailPushEnabled(env)) return null;
  const token = await access(account, env);
  if (account.provider === "gmail") {
    const r = await call<{ expiration: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      token,
      "POST",
      {
        topicName: env.GMAIL_PUBSUB_TOPIC!.trim(),
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    );
    if (!r.data) throw new Error("Gmail watch failed: " + r.status);
    return { expires_at: Number(r.data.expiration) };
  }
  const expiry = new Date(Date.now() + OUTLOOK_LIFETIME).toISOString();
  if (watch?.subscription_id) {
    const r = await call<{ expirationDateTime: string }>(
      `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(watch.subscription_id)}`,
      token,
      "PATCH",
      { expirationDateTime: expiry },
    );
    if (r.data) return { expires_at: Date.parse(r.data.expirationDateTime) };
    if (r.status !== 404) throw new Error("Graph renewal failed: " + r.status);
  }
  const secret = randomToken();
  const r = await call<{ id: string; expirationDateTime: string }>(
    "https://graph.microsoft.com/v1.0/subscriptions",
    token,
    "POST",
    {
      changeType: "created",
      notificationUrl: env.PUBLIC_BASE_URL + "/hooks/outlook",
      resource: "me/mailFolders('inbox')/messages",
      expirationDateTime: expiry,
      clientState: secret,
    },
  );
  if (!r.data) throw new Error("Graph subscription failed: " + r.status);
  return {
    subscription_id: r.data.id,
    secret,
    expires_at: Date.parse(r.data.expirationDateTime),
  };
}
// Creates or renews push for every account whose push ends within a day.
// A failure is retried after an hour; the cron keeps checking that account.
export async function renewWatches(env: Env): Promise<void> {
  const now = Date.now();
  const accounts = await env.DB.prepare(
    "SELECT a.* FROM accounts a LEFT JOIN watches w ON w.account_id=a.id WHERE (w.expires_at IS NULL OR w.expires_at<?) AND (w.retry_at IS NULL OR w.retry_at<?)",
  )
    .bind(now + RENEW_BEFORE, now)
    .all<Account>();
  for (const account of accounts.results) {
    const watch = await env.DB.prepare(
      "SELECT * FROM watches WHERE account_id=?",
    )
      .bind(account.id)
      .first<Watch>();
    try {
      const next = await renew(account, watch, env);
      if (!next) continue;
      await env.DB.prepare(
        "INSERT INTO watches(account_id,subscription_id,secret,expires_at,retry_at) VALUES(?,?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET subscription_id=excluded.subscription_id,secret=excluded.secret,expires_at=excluded.expires_at,retry_at=0",
      )
        .bind(
          account.id,
          next.subscription_id ?? watch?.subscription_id ?? null,
          next.secret ?? watch?.secret ?? null,
          Number.isFinite(next.expires_at) ? next.expires_at : 0,
        )
        .run();
    } catch {
      await env.DB.prepare(
        "INSERT INTO watches(account_id,retry_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET retry_at=excluded.retry_at",
      )
        .bind(account.id, now + RETRY_AFTER)
        .run();
      console.error(
        JSON.stringify({
          event: "push_renewal_failed",
          provider: account.provider,
        }),
      );
    }
  }
}
