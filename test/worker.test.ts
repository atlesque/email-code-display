import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { encrypt, decrypt, accessIdentity } from "../src/security";
import {
  cleanHtml,
  candidates,
  ruleExtraction,
  validateExtraction,
  type Mail,
} from "../src/extraction";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { gmailText } from "../src/providers";
import { poll } from "../src/poll";
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (
      String(input) !== "https://test.cloudflareaccess.com/cdn-cgi/access/certs"
    )
      throw new Error("Unexpected network request");
    return Response.json({
      keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }],
    });
  });
});
async function assertion(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: "alexander@atlesque.media",
    iss: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
    iat: now,
    exp: now + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(privateKey);
}
async function ownerHeaders() {
  return { "Cf-Access-Jwt-Assertion": await assertion() };
}
const mail: Mail = {
  id: "message-1",
  subject: "Sign in",
  from: "Example <no-reply@example.com>",
  text: "Your verification code is 001234. Do not share it.",
  receivedAt: Date.now(),
};
beforeEach(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY,account_id TEXT,payload TEXT,received_at INTEGER,expires_at INTEGER,dismissed INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,provider TEXT,email TEXT,token TEXT,connected_at INTEGER,last_checked INTEGER,status TEXT); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY,provider TEXT,verifier TEXT,expires_at INTEGER);",
  );
  await env.DB.exec(
    "DELETE FROM codes; DELETE FROM accounts; DELETE FROM settings; DELETE FROM oauth_states;",
  );
});
describe("code extraction", () => {
  it("preserves leading zeroes", () =>
    expect(ruleExtraction(mail)?.code).toBe("001234"));
  it("rejects unrelated order IDs", () =>
    expect(
      ruleExtraction({ ...mail, text: "Order 123456 has shipped." }),
    ).toBeNull());
  it("rejects ambiguous multiple access codes", () =>
    expect(
      ruleExtraction({
        ...mail,
        text: "Verification code: 123456. Login code: 654321.",
      }),
    ).toBeNull());
  it("checks model code against the actual email", () => {
    expect(
      validateExtraction(
        { is_access_code: true, code: "999999", confidence: 1 },
        mail,
      ),
    ).toBeNull();
    expect(
      validateExtraction(
        { is_access_code: true, code: "001234", confidence: 0.99 },
        mail,
      )?.service,
    ).toBe("example.com");
  });
  it("rejects low confidence and non-code model answers", () => {
    expect(
      validateExtraction(
        { is_access_code: true, code: "001234", confidence: 0.5 },
        mail,
      ),
    ).toBeNull();
    expect(
      validateExtraction(
        { is_access_code: false, code: "001234", confidence: 1 },
        mail,
      ),
    ).toBeNull();
  });
  it("supports a code formatted with a space", () =>
    expect(candidates({ ...mail, text: "Access code: 123 456" })).toContain(
      "123 456",
    ));
  it("does not turn an 11-digit phone number into a code", () =>
    expect(candidates({ ...mail, text: "+32123456789" })).toEqual([]));
  it("flattens HTML and prefers plain MIME alternatives", () => {
    expect(cleanHtml("<style>x</style><b>Code</b>&nbsp;001234")).toBe(
      "Code 001234",
    );
    expect(
      gmailText({
        parts: [
          { mimeType: "text/plain", body: { data: btoa("Plain 001234") } },
          { mimeType: "text/html", body: { data: btoa("<b>HTML 999999</b>") } },
        ],
      }),
    ).toBe("Plain 001234");
  });
});
describe("security and device API", () => {
  it("encrypts and authenticates tokens", async () => {
    const encrypted = await encrypt({ token: "sensitive" }, env.ENCRYPTION_KEY);
    expect(encrypted).not.toContain("sensitive");
    expect(await decrypt(encrypted, env.ENCRYPTION_KEY)).toEqual({
      token: "sensitive",
    });
    await expect(
      decrypt(encrypted.slice(0, -2) + "aa", env.ENCRYPTION_KEY),
    ).rejects.toThrow();
  });
  it("validates the owner, signature, issuer, audience and expiry", async () => {
    expect(
      await accessIdentity(
        new Request("https://codes.atlesque.dev", {
          headers: await ownerHeaders(),
        }),
        env,
      ),
    ).toBe(true);
    for (const claims of [
      { email: "other@example.com" },
      { aud: "other-app" },
      { iss: "https://evil.example" },
      { exp: 1 },
      { exp: undefined },
    ]) {
      expect(
        await accessIdentity(
          new Request("https://codes.atlesque.dev", {
            headers: { "Cf-Access-Jwt-Assertion": await assertion(claims) },
          }),
          env,
        ),
      ).toBe(false);
    }
    const forged = await assertion();
    expect(
      await accessIdentity(
        new Request("https://codes.atlesque.dev", {
          headers: {
            "Cf-Access-Jwt-Assertion": forged.slice(0, -8) + "AAAAAAAA",
          },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      await accessIdentity(
        new Request("https://codes.atlesque.dev", {
          headers: {
            "Cf-Access-Authenticated-User-Email": "alexander@atlesque.media",
            Authorization: "Bearer test-admin-secret",
            Cookie: "session=9999999999999.fake",
          },
        }),
        env,
      ),
    ).toBe(false);
  });
  it("rejects unauthenticated and wrong-device requests", async () => {
    for (const headers of [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: "Bearer test-admin-secret" },
    ] as Record<string, string>[]) {
      const response = await exports.default.fetch(
        "https://codes.atlesque.dev/api/device/code",
        { headers },
      );
      expect(response.status).toBe(401);
    }
  });
  it("protects UI assets, management and OAuth routes without an admin-key fallback", async () => {
    for (const path of [
      "/",
      "/app.js",
      "/style.css",
      "/api/status",
      "/oauth/start/gmail",
      "/oauth/callback/gmail",
      "/api/login",
    ]) {
      expect(
        (
          await exports.default.fetch("https://codes.atlesque.dev" + path, {
            headers: { Authorization: "Bearer test-admin-secret" },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await exports.default.fetch("https://codes.atlesque.dev/api/status", {
          headers: await ownerHeaders(),
        })
      ).status,
    ).toBe(200);
  });
  it("rejects cross-site mutations even with an Access token and bearer header", async () => {
    expect(
      (
        await exports.default.fetch(
          "https://codes.atlesque.dev/api/test-display",
          {
            method: "POST",
            headers: {
              ...(await ownerHeaders()),
              Origin: "https://evil.example",
              Authorization: "Bearer anything",
            },
            body: "{}",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await exports.default.fetch(
          "https://codes.atlesque.dev/api/test-display",
          {
            method: "POST",
            headers: {
              ...(await ownerHeaders()),
              Origin: "https://codes.atlesque.dev",
            },
            body: "{}",
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await exports.default.fetch("https://codes.atlesque.dev/api/login", {
          method: "POST",
          headers: {
            ...(await ownerHeaders()),
            Origin: "https://codes.atlesque.dev",
          },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
  it("selects the newest unexpired, undismissed code across mailboxes", async () => {
    const now = Date.now();
    for (const [id, received, expires, dismissed] of [
      ["old", now - 1000, now + 60000, 0],
      ["new", now, now + 60000, 0],
      ["expired", now + 1, now - 1, 0],
      ["dismissed", now + 2, now + 60000, 1],
    ] as const) {
      await env.DB.prepare("INSERT INTO codes VALUES(?,?,?,?,?,?)")
        .bind(
          id,
          "a",
          await encrypt(
            { code: "001234", service: "example.com", provider: "gmail" },
            env.ENCRYPTION_KEY,
          ),
          received,
          expires,
          dismissed,
        )
        .run();
    }
    const response = await exports.default.fetch(
      "https://codes.atlesque.dev/api/device/code",
      { headers: { Authorization: "Bearer " + env.DEVICE_TOKEN } },
    );
    const result = (await response.json()) as {
      id: string;
      code: string;
      remainingSeconds: number;
    };
    expect(result.id).toBe("new");
    expect(result.code).toBe("001234");
    expect(result.remainingSeconds).toBeGreaterThan(0);
  });
  it("serves the device's current code to the owner's display preview", async () => {
    await env.DB.prepare("INSERT INTO codes VALUES(?,?,?,?,?,0)")
      .bind(
        "a",
        "a",
        await encrypt(
          { code: "123456", service: "example.com", provider: "gmail" },
          env.ENCRYPTION_KEY,
        ),
        Date.now(),
        Date.now() + 60000,
      )
      .run();
    const url = "https://codes.atlesque.dev/api/display";
    expect(
      (
        await exports.default.fetch(url, {
          headers: { Authorization: "Bearer " + env.DEVICE_TOKEN },
        })
      ).status,
    ).toBe(401);
    const result = (await (
      await exports.default.fetch(url, { headers: await ownerHeaders() })
    ).json()) as { id: string; code: string; remainingSeconds: number };
    expect(result).toMatchObject({ id: "a", code: "123456" });
    expect(result.remainingSeconds).toBeGreaterThan(0);
    await env.DB.exec("UPDATE codes SET dismissed=1");
    expect(
      await (
        await exports.default.fetch(url, { headers: await ownerHeaders() })
      ).json(),
    ).toEqual({ code: null });
  });
  it("dismisses only the requested code", async () => {
    await env.DB.prepare("INSERT INTO codes VALUES(?,?,?,?,?,0)")
      .bind(
        "a",
        "a",
        await encrypt({ code: "123456" }, env.ENCRYPTION_KEY),
        Date.now(),
        Date.now() + 60000,
      )
      .run();
    await exports.default.fetch(
      "https://codes.atlesque.dev/api/device/dismiss",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + env.DEVICE_TOKEN },
        body: '{"id":"a"}',
      },
    );
    expect(
      (
        await env.DB.prepare("SELECT dismissed FROM codes WHERE id=?")
          .bind("a")
          .first<{ dismissed: number }>()
      )?.dismissed,
    ).toBe(1);
  });
  it("rejects OAuth callbacks without browser-bound state", async () => {
    expect(
      (
        await exports.default.fetch(
          "https://codes.atlesque.dev/oauth/callback/gmail?state=bad&code=bad",
          { headers: await ownerHeaders() },
        )
      ).status,
    ).toBe(400);
  });
});
describe("mail test", () => {
  it("sends a real-format code email and follows it to the device", async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS processed (account_id TEXT,message_id TEXT,expires_at INTEGER,PRIMARY KEY(account_id,message_id)); CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY,owner TEXT,expires_at INTEGER); DELETE FROM processed; DELETE FROM leases;",
    );
    await env.DB.prepare(
      "INSERT INTO accounts(id,provider,email,token,connected_at,status) VALUES('acct','gmail',?,?,?,'connected')",
    )
      .bind(
        env.MAIL_TEST_TO,
        await encrypt(
          {
            access_token: "gmail-token",
            refresh_token: "refresh",
            expires_at: Date.now() + 3600000,
          },
          env.ENCRYPTION_KEY,
        ),
        Date.now() - 60000,
      )
      .run();
    // The sent message lands in the simulated Gmail inbox.
    const inbox: { from: string; subject: string; text: string }[] = [];
    const send = vi
      .spyOn(env.MAIL_TEST, "send")
      .mockImplementation(async (message) => {
        const m = message as EmailMessageBuilder;
        const from = m.from as { email: string; name: string };
        inbox.push({
          from: `${from.name} <${from.email}>`,
          subject: m.subject,
          text: m.text ?? "",
        });
        return { messageId: "sent-1" };
      });
    const ai = vi.spyOn(env.AI, "run").mockRejectedValue(new Error("offline"));
    const certs = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://gmail.googleapis.com/"))
        return certs(input, init);
      if (url.includes("/messages?"))
        return Response.json({
          messages: inbox.map((_, i) => ({ id: "m" + i })),
        });
      const m = inbox[Number(url.match(/messages\/m(\d+)/)![1])];
      return Response.json({
        id: "m0",
        internalDate: String(Date.now()),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: m.from },
            { name: "Subject", value: m.subject },
          ],
          body: { data: btoa(m.text) },
        },
      });
    });
    try {
      const sent = (await (
        await exports.default.fetch(
          "https://codes.atlesque.dev/api/test-mail",
          {
            method: "POST",
            headers: {
              ...(await ownerHeaders()),
              Origin: "https://codes.atlesque.dev",
            },
            body: "{}",
          },
        )
      ).json()) as { to: string; code: string };
      expect(sent.to).toBe("alexander@atlesque.media");
      expect(sent.code).toMatch(/^\d{6}$/);
      expect(send.mock.calls[0][0]).toMatchObject({
        to: "alexander@atlesque.media",
        from: { email: "codes@atlesque.dev" },
      });
      await poll(env);
      const shown = (await (
        await exports.default.fetch(
          "https://codes.atlesque.dev/api/device/code",
          { headers: { Authorization: "Bearer " + env.DEVICE_TOKEN } },
        )
      ).json()) as { code: string; service: string; provider: string };
      expect(shown).toMatchObject({
        code: sent.code,
        service: "atlesque.dev",
        provider: "gmail",
      });
    } finally {
      vi.mocked(fetch).mockImplementation(certs);
      send.mockRestore();
      ai.mockRestore();
    }
  });
  it("reports Email Service refusals without leaking details", async () => {
    const send = vi
      .spyOn(env.MAIL_TEST, "send")
      .mockRejectedValue(
        Object.assign(new Error("domain"), { code: "E_SENDER_NOT_VERIFIED" }),
      );
    try {
      const response = await exports.default.fetch(
        "https://codes.atlesque.dev/api/test-mail",
        {
          method: "POST",
          headers: {
            ...(await ownerHeaders()),
            Origin: "https://codes.atlesque.dev",
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error:
          "Cloudflare Email Service refused the test email (E_SENDER_NOT_VERIFIED)",
      });
    } finally {
      send.mockRestore();
    }
  });
});
