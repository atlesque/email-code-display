import {
  accessIdentity,
  boundedJson,
  decrypt,
  digest,
  encrypt,
  equal,
  json,
  randomToken,
} from "./security";
import {
  emailAddress,
  exchange,
  providerConfig,
  type Provider,
} from "./providers";
import { poll, pollMinute } from "./poll";
import { extract, type Extracted } from "./extraction";
import { sendMailTest } from "./mailtest";
function redirect(
  path: string,
  env: Env,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: env.PUBLIC_BASE_URL + path,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}
function sameOrigin(r: Request, env: Env): boolean {
  return r.headers.get("Origin") === env.PUBLIC_BASE_URL;
}
// The code the device shows: newest unexpired, undismissed code.
async function currentCode(env: Env) {
  const row = await env.DB.prepare(
    "SELECT id,payload,expires_at FROM codes WHERE dismissed=0 AND expires_at>? ORDER BY received_at DESC LIMIT 1",
  )
    .bind(Date.now())
    .first<{ id: string; payload: string; expires_at: number }>();
  if (!row) return { code: null };
  return {
    id: row.id,
    ...(await decrypt<Extracted & { provider: string }>(
      row.payload,
      env.ENCRYPTION_KEY,
    )),
    remainingSeconds: Math.max(
      0,
      Math.floor((row.expires_at - Date.now()) / 1000),
    ),
  };
}
function provider(value: string): Provider | null {
  return value === "gmail" || value === "outlook" ? value : null;
}
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/health") return json({ ok: true });
  // Device endpoints retain their independent bearer key; every browser route
  // (including assets and OAuth callbacks) requires a verified Access identity.
  if (!path.startsWith("/api/device/")) {
    if (!(await accessIdentity(request, env)))
      return json({ error: "Cloudflare Access sign-in required" }, 401);
  }
  if (path.startsWith("/oauth/callback/")) {
    const p = provider(path.split("/").pop() ?? "");
    if (!p) return json({ error: "Unknown provider" }, 404);
    const state = url.searchParams.get("state") ?? "";
    const cookie =
      request.headers
        .get("Cookie")
        ?.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1] ?? "";
    if (!cookie || !(await equal(cookie, state)))
      return json({ error: "Invalid OAuth state" }, 400);
    const row = await env.DB.prepare(
      "DELETE FROM oauth_states WHERE id=? AND provider=? AND expires_at>? RETURNING verifier",
    )
      .bind(state, p, Date.now())
      .first<{ verifier: string }>();
    if (!row) return json({ error: "OAuth request expired; start again" }, 400);
    if (url.searchParams.has("error"))
      return redirect("/?connection=cancelled", env);
    const code = url.searchParams.get("code");
    if (!code) return json({ error: "Missing authorization code" }, 400);
    const verifier = await decrypt<string>(row.verifier, env.ENCRYPTION_KEY);
    const tokens = await exchange(
      p,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: env.PUBLIC_BASE_URL + path,
      },
      env,
    );
    if (!tokens.refresh_token)
      return json(
        { error: "Offline access was not granted; reconnect with consent" },
        400,
      );
    const email = await emailAddress(p, tokens.access_token);
    await env.DB.prepare(
      "INSERT INTO accounts(id,provider,email,token,connected_at) VALUES(?,?,?,?,?) ON CONFLICT(provider,email) DO UPDATE SET token=excluded.token,status='connected'",
    )
      .bind(
        crypto.randomUUID(),
        p,
        email,
        await encrypt(tokens, env.ENCRYPTION_KEY),
        Date.now(),
      )
      .run();
    ctx.waitUntil(poll(env));
    return redirect("/", env, {
      "Set-Cookie":
        "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    });
  }
  if (path.startsWith("/api/device/")) {
    const supplied =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (
      !env.DEVICE_TOKEN ||
      !supplied ||
      !(await equal(supplied, env.DEVICE_TOKEN))
    )
      return json({ error: "Unauthorized" }, 401);
    if (path === "/api/device/code" && request.method === "GET")
      return json(await currentCode(env));
    if (path === "/api/device/dismiss" && request.method === "POST") {
      const data = await boundedJson<{ id: string }>(
        new Response(request.body),
        4096,
      );
      if (typeof data.id !== "string")
        return json({ error: "Invalid id" }, 400);
      await env.DB.prepare("UPDATE codes SET dismissed=1 WHERE id=?")
        .bind(data.id)
        .run();
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
  if (path.startsWith("/api/") || path.startsWith("/oauth/start/")) {
    if (request.method !== "GET" && !sameOrigin(request, env))
      return json({ error: "Invalid origin" }, 403);
    if (path === "/api/status") {
      const accounts = await env.DB.prepare(
        "SELECT id,provider,email,status,last_checked FROM accounts ORDER BY provider,email",
      ).all();
      const last = await env.DB.prepare(
        "SELECT value FROM settings WHERE key='last_poll'",
      ).first<{ value: string }>();
      return json({
        accounts: accounts.results,
        lastPoll: Number(last?.value ?? 0),
        providers: {
          gmail: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
          outlook: Boolean(
            env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET,
          ),
        },
        model: env.AI_MODEL,
        mailTestTo: env.MAIL_TEST_TO,
      });
    }
    if (path === "/api/display" && request.method === "GET")
      return json(await currentCode(env));
    if (path === "/api/check" && request.method === "POST") {
      ctx.waitUntil(poll(env));
      return json({ ok: true }, 202);
    }
    if (path === "/api/accounts/disconnect" && request.method === "POST") {
      const { id } = await boundedJson<{ id: string }>(
        new Response(request.body),
        4096,
      );
      if (typeof id !== "string") return json({ error: "Invalid id" }, 400);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM codes WHERE account_id=?").bind(id),
        env.DB.prepare("DELETE FROM processed WHERE account_id=?").bind(id),
        env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id),
      ]);
      return json({ ok: true });
    }
    if (path === "/api/test-model" && request.method === "POST") {
      const result = await extract(
        {
          id: "synthetic-test",
          subject: "Your sign-in code",
          from: "test@example.com",
          text: "Your verification code is 123456. It expires in five minutes.",
          receivedAt: Date.now(),
        },
        env,
      );
      return json({
        model: env.AI_MODEL,
        source: result?.source ?? null,
        ok: result?.code === "123456",
      });
    }
    if (path === "/api/test-mail" && request.method === "POST") {
      try {
        return json(await sendMailTest(env));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        console.error(
          JSON.stringify({ event: "mail_test_failed", code: String(code) }),
        );
        return json(
          {
            error:
              typeof code === "string"
                ? `Cloudflare Email Service refused the test email (${code})`
                : "Test email could not be sent",
          },
          502,
        );
      }
    }
    if (path === "/api/test-display" && request.method === "POST") {
      const now = Date.now();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO codes(id,account_id,payload,received_at,expires_at) VALUES(?,?,?,?,?)",
      )
        .bind(
          "display-test",
          "test",
          await encrypt(
            {
              code: "123456",
              service: "Display test",
              provider: "demo",
              source: "rules",
            },
            env.ENCRYPTION_KEY,
          ),
          now,
          now + 60000,
        )
        .run();
      return json({ ok: true });
    }
    if (path.startsWith("/oauth/start/") && request.method === "GET") {
      const p = provider(path.split("/").pop() ?? "");
      if (!p) return json({ error: "Unknown provider" }, 404);
      const cfg = providerConfig(p, env);
      if (!cfg.id || !cfg.secret)
        return json(
          { error: "Provider OAuth client has not been configured" },
          503,
        );
      const state = randomToken(),
        verifier = randomToken(),
        challenge = (await digest(verifier))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      await env.DB.prepare(
        "INSERT INTO oauth_states(id,provider,verifier,expires_at) VALUES(?,?,?,?)",
      )
        .bind(
          state,
          p,
          await encrypt(verifier, env.ENCRYPTION_KEY),
          Date.now() + 600000,
        )
        .run();
      const params = new URLSearchParams({
        client_id: cfg.id,
        redirect_uri: env.PUBLIC_BASE_URL + `/oauth/callback/${p}`,
        response_type: "code",
        scope: cfg.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(p === "gmail"
          ? { access_type: "offline", prompt: "consent select_account" }
          : { prompt: "select_account" }),
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: cfg.authorize + "?" + params,
          "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return json({ error: "Not found" }, 404);
  }
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch {
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: new URL(request.url).pathname,
        }),
      );
      return json({ error: "Request failed; try again" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollMinute(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
