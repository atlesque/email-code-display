import { boundedJson, decrypt, encrypt } from "./security";
import { cleanHtml, type Mail } from "./extraction";
export type Provider = "gmail" | "outlook";
export type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};
export type Account = {
  id: string;
  provider: Provider;
  email: string;
  token: string;
  connected_at: number;
};
export function providerConfig(provider: Provider, env: Env) {
  return provider === "gmail"
    ? {
        id: env.GOOGLE_CLIENT_ID,
        secret: env.GOOGLE_CLIENT_SECRET,
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }
    : {
        id: env.MICROSOFT_CLIENT_ID,
        secret: env.MICROSOFT_CLIENT_SECRET,
        authorize: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}/oauth2/v2.0/token`,
        scope:
          "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
      };
}
export async function exchange(
  provider: Provider,
  params: Record<string, string>,
  env: Env,
): Promise<Tokens> {
  const cfg = providerConfig(provider, env);
  const response = await fetch(cfg.token, {
    method: "POST",
    body: new URLSearchParams({
      ...params,
      client_id: cfg.id,
      client_secret: cfg.secret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 400
        ? "Reconnect account"
        : "Token service unavailable",
    );
  }
  const t = await boundedJson<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>(response, 20000);
  if (!t.access_token) throw new Error("Missing access token");
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? params.refresh_token ?? "",
    expires_at: Date.now() + t.expires_in * 1000,
  };
}
export async function access(account: Account, env: Env): Promise<string> {
  let tokens = await decrypt<Tokens>(account.token, env.ENCRYPTION_KEY);
  if (tokens.expires_at < Date.now() + 60000) {
    tokens = await exchange(
      account.provider,
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      env,
    );
    await env.DB.prepare("UPDATE accounts SET token=? WHERE id=?")
      .bind(await encrypt(tokens, env.ENCRYPTION_KEY), account.id)
      .run();
  }
  return tokens.access_token;
}
async function api<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.body-content-type="text"',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? "Reconnect account"
        : `Mailbox HTTP ${response.status}`,
    );
  }
  return boundedJson<T>(response, 2_000_000);
}
export async function emailAddress(
  provider: Provider,
  token: string,
): Promise<string> {
  if (provider === "gmail")
    return (
      await api<{ emailAddress: string }>(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        token,
      )
    ).emailAddress;
  const me = await api<{ mail?: string; userPrincipalName: string }>(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    token,
  );
  return me.mail ?? me.userPrincipalName;
}
type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
};
function decode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  );
}
export function gmailText(part: Part): string {
  const collect = (p: Part, type: string): string[] => [
    ...(p.mimeType === type && p.body?.data ? [decode(p.body.data)] : []),
    ...(p.parts ?? []).flatMap((c) => collect(c, type)),
  ];
  const plain = collect(part, "text/plain");
  return (
    plain.length
      ? plain.join("\n")
      : cleanHtml(collect(part, "text/html").join("\n"))
  ).slice(0, 15000);
}
export async function* messages(
  account: Account,
  token: string,
): AsyncGenerator<Mail> {
  const cutoff = Math.max(account.connected_at, Date.now() - 5 * 60000);
  if (account.provider === "gmail") {
    let page = "";
    let pages = 0;
    do {
      const query = new URLSearchParams({
        q: `in:inbox after:${Math.floor(cutoff / 1000)}`,
        maxResults: "50",
        ...(page ? { pageToken: page } : {}),
      });
      const list = await api<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`,
        token,
      );
      for (const item of list.messages ?? []) {
        const msg = await api<{
          id: string;
          internalDate: string;
          payload: Part;
        }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
          token,
        );
        const header = (name: string) =>
          msg.payload.headers?.find((h) => h.name.toLowerCase() === name)
            ?.value ?? "";
        const receivedAt = Number(msg.internalDate);
        if (receivedAt >= cutoff)
          yield {
            id: msg.id,
            subject: header("subject"),
            from: header("from"),
            text: gmailText(msg.payload),
            receivedAt,
          };
      }
      page = list.nextPageToken ?? "";
    } while (page && ++pages < 4);
  } else {
    const query = new URLSearchParams({
      $filter: `receivedDateTime ge ${new Date(cutoff).toISOString()}`,
      $select: "id,subject,from,body,receivedDateTime",
      $orderby: "receivedDateTime desc",
      $top: "50",
    });
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`;
    let pages = 0;
    do {
      const list = await api<{
        value: {
          id: string;
          subject: string;
          from?: { emailAddress?: { address?: string } };
          body?: { content: string; contentType: string };
          receivedDateTime: string;
        }[];
        "@odata.nextLink"?: string;
      }>(url, token);
      for (const m of list.value) {
        const receivedAt = Date.parse(m.receivedDateTime);
        if (receivedAt >= cutoff)
          yield {
            id: m.id,
            subject: m.subject ?? "",
            from: m.from?.emailAddress?.address ?? "",
            text: (m.body?.contentType.toLowerCase() === "html"
              ? cleanHtml(m.body.content)
              : (m.body?.content ?? "")
            ).slice(0, 15000),
            receivedAt,
          };
      }
      const next = list["@odata.nextLink"];
      if (next && new URL(next).origin !== "https://graph.microsoft.com")
        throw new Error("Invalid pagination origin");
      url = next ?? "";
    } while (url && ++pages < 4);
  }
}
