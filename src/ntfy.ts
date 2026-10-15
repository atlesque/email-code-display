import type { Extracted } from "./extraction";
// Optional push of each new code to an ntfy server. Off unless NTFY_URL is set.
// All values come from Worker secrets or .dev.vars, never from wrangler.jsonc.
export type NtfyEnv = {
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  NTFY_USERNAME?: string;
  NTFY_PASSWORD?: string;
};
declare global {
  interface Env extends NtfyEnv {}
}
export const DEFAULT_NTFY_TOPIC = "email-codes";
export function ntfyRequest(env: NtfyEnv, code: Extracted): Request | null {
  const base = env.NTFY_URL?.trim();
  if (!base) return null;
  const url = new URL(base);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("NTFY_URL must use HTTPS");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = env.NTFY_TOKEN?.trim(),
    username = env.NTFY_USERNAME?.trim(),
    password = env.NTFY_PASSWORD;
  if (token) headers.Authorization = "Bearer " + token;
  else if (username && password)
    headers.Authorization = "Basic " + btoa(username + ":" + password);
  return new Request(url.origin + url.pathname.replace(/\/*$/, "/"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      topic: env.NTFY_TOPIC?.trim() || DEFAULT_NTFY_TOPIC,
      title: code.service + " code",
      message: code.code,
      tags: ["key"],
      priority: 4,
    }),
  });
}
export async function notifyNtfy(env: NtfyEnv, code: Extracted): Promise<void> {
  let request: Request | null;
  try {
    request = ntfyRequest(env, code);
  } catch {
    console.error(JSON.stringify({ event: "ntfy_config_invalid" }));
    return;
  }
  if (!request) return;
  try {
    const response = await fetch(request, {
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (!response.ok)
      console.error(
        JSON.stringify({ event: "ntfy_failed", status: response.status }),
      );
  } catch (error) {
    // Never log the code, URL or credentials.
    console.error(
      JSON.stringify({
        event: "ntfy_failed",
        reason: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}
