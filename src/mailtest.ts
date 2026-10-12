// Sends a real code email through Cloudflare Email Service to the configured
// test inbox, so the whole path (delivery, inbox check, extraction, display) runs.
export type MailTest = { to: string; code: string; sentAt: number };
export function testCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n % 1_000_000).padStart(6, "0");
}
export async function sendMailTest(env: Env): Promise<MailTest> {
  const code = testCode(),
    sentAt = Date.now();
  await env.MAIL_TEST.send({
    from: { email: env.MAIL_TEST_FROM, name: "Email Code Display" },
    to: env.MAIL_TEST_TO,
    subject: "Email Code Display test",
    text: `Your verification code is ${code}.\n\nSent by the Email Code Display mail test.`,
  });
  return { to: env.MAIL_TEST_TO, code, sentAt };
}
