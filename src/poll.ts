import { access, messages, type Account } from "./providers";
import { extract } from "./extraction";
import { encrypt } from "./security";
import { notifyNtfy } from "./ntfy";
export async function poll(env: Env): Promise<void> {
  const now = Date.now(),
    owner = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "INSERT INTO leases(name,owner,expires_at) VALUES('poll',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<? RETURNING owner",
  )
    .bind(owner, now + 15 * 60000, now)
    .first<{ owner: string }>();
  if (!lease) return;
  try {
    const accounts = await env.DB.prepare(
      "SELECT * FROM accounts",
    ).all<Account>();
    for (const account of accounts.results) {
      try {
        const token = await access(account, env);
        for await (const mail of messages(account, token)) {
          if (
            !Number.isFinite(mail.receivedAt) ||
            mail.receivedAt > now + 60000 ||
            mail.receivedAt + 5 * 60000 <= Date.now()
          )
            continue;
          const seen = await env.DB.prepare(
            "SELECT message_id FROM processed WHERE account_id=? AND message_id=?",
          )
            .bind(account.id, mail.id)
            .first();
          if (seen) continue;
          const code = await extract(mail, env);
          const statements = [
            env.DB.prepare(
              "INSERT OR IGNORE INTO processed(account_id,message_id,expires_at) VALUES(?,?,?)",
            ).bind(account.id, mail.id, now + 3600000),
          ];
          if (code) {
            const id = account.id + ":" + mail.id;
            const expiresAt = mail.receivedAt + 5 * 60000;
            statements.push(
              env.DB.prepare(
                "INSERT OR IGNORE INTO codes(id,account_id,payload,received_at,expires_at) VALUES(?,?,?,?,?)",
              ).bind(
                id,
                account.id,
                await encrypt(
                  { ...code, provider: account.provider },
                  env.ENCRYPTION_KEY,
                ),
                mail.receivedAt,
                expiresAt,
              ),
            );
          }
          const results = await env.DB.batch(statements);
          if (code && results[1].meta.changes) await notifyNtfy(env, code);
        }
        await env.DB.prepare(
          "UPDATE accounts SET last_checked=?,status='connected' WHERE id=?",
        )
          .bind(Date.now(), account.id)
          .run();
      } catch (error) {
        const message =
          error instanceof Error && error.message === "Reconnect account"
            ? "Reconnect account"
            : "Check failed; will retry";
        await env.DB.prepare("UPDATE accounts SET status=? WHERE id=?")
          .bind(message, account.id)
          .run();
        console.error(
          JSON.stringify({
            event: "mailbox_check_failed",
            provider: account.provider,
          }),
        );
      }
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM codes WHERE expires_at<?").bind(Date.now()),
      env.DB.prepare("DELETE FROM processed WHERE expires_at<?").bind(
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(
        Date.now(),
      ),
    ]);
    await env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES('last_poll',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(String(Date.now()))
      .run();
  } finally {
    await env.DB.prepare("DELETE FROM leases WHERE name='poll' AND owner=?")
      .bind(owner)
      .run();
  }
}
