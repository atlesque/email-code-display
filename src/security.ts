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
export async function session(
  secret: string,
  expires: number,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${expires}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(String(expires)))))}`;
}
export async function admin(
  request: Request,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  const bearer = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (bearer && (await equal(bearer, secret))) return true;
  const value = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!value) return false;
  const expires = Number(value.split(".")[0]);
  return (
    Number.isSafeInteger(expires) &&
    expires > Date.now() &&
    (await equal(value, await session(secret, expires)))
  );
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
