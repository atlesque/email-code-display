import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, it, expect } from "vitest";
import { encrypt, decrypt, admin, session } from "../src/security";
import {
  cleanHtml,
  candidates,
  ruleExtraction,
  validateExtraction,
  type Mail,
} from "../src/extraction";
import { gmailText } from "../src/providers";
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
  it("rejects forged or expired admin sessions", async () => {
    expect(
      await admin(
        new Request("https://codes.atlesque.dev", {
          headers: { Cookie: "session=9999999999999.fake" },
        }),
        env.ADMIN_TOKEN,
      ),
    ).toBe(false);
    const cookie = await session(env.ADMIN_TOKEN, Date.now() - 1);
    expect(
      await admin(
        new Request("https://codes.atlesque.dev", {
          headers: { Cookie: "session=" + cookie },
        }),
        env.ADMIN_TOKEN,
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
  it("protects admin endpoints and refuses cross-site login", async () => {
    expect(
      (await exports.default.fetch("https://codes.atlesque.dev/api/status"))
        .status,
    ).toBe(401);
    expect(
      (
        await exports.default.fetch("https://codes.atlesque.dev/api/login", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: JSON.stringify({ token: env.ADMIN_TOKEN }),
        })
      ).status,
    ).toBe(403);
  });
  it("creates an HttpOnly admin session", async () => {
    const response = await exports.default.fetch(
      "https://codes.atlesque.dev/api/login",
      {
        method: "POST",
        headers: { Origin: "https://codes.atlesque.dev" },
        body: JSON.stringify({ token: env.ADMIN_TOKEN }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
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
        )
      ).status,
    ).toBe(400);
  });
});
