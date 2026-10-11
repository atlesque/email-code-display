import { createRemoteJWKSet, jwtVerify } from "jose";

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
export function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function digest(value: string): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export async function equal(a: string, b: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(
    unb64(await digest(a)),
    unb64(await digest(b)),
  );
}
async function key(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("Invalid encryption key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
export async function decrypt<T>(value: string, secret: string): Promise<T> {
  const [iv, data] = value.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    await key(secret),
    unb64(data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
// Cache only public verification keys; never retain request identities or tokens.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function accessIdentity(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_EMAIL)
    return false;
  try {
    const issuer = new URL(env.ACCESS_TEAM_DOMAIN);
    if (
      issuer.protocol !== "https:" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com") ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password
    )
      return false;
    let keys = keySets.get(issuer.origin);
    if (!keys) {
      keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
      keySets.set(issuer.origin, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: issuer.origin,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "email"],
    });
    return payload.email === env.ACCESS_EMAIL;
  } catch {
    return false;
  }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function boundedJson<T>(
  response: Response,
  limit = 1_000_000,
): Promise<T> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all)) as T;
}
