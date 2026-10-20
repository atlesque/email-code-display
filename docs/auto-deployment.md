# Automatic production deployment

Cloudflare Workers Builds connects `atlesque/email-code-display` to the
`email-code-display` Worker. Pushes to `main` automatically deploy production at
https://codes.atlesque.dev.

Configured on 11 October 2026:

- Production branch: `main`; builds enabled.
- Root directory: `/`.
- Build command: `npm run check && npm test`.
- Deploy command: `npm run deploy`.
- Preview builds disabled.
- Build authentication: Cloudflare-managed `email-code-display build token`.
- Watch paths: all repository paths.

Cloudflare installs the npm dependencies before running the build command. A
failed type check or test stops deployment. Runtime secrets remain configured on
the Worker; they are not committed or copied into build variables.

`npm run deploy` applies pending D1 migrations before uploading the Worker, so a
merge that adds a migration needs no manual step. A failed migration stops the
deploy. This needs **D1 Edit** on the build token: in **My Profile → API Tokens**,
edit `email-code-display build token` and add Account → D1 → Edit (Cloudflare's
generated token does not include it).

Manage the connection and commands in the Worker's **Settings → Builds** section.
Inspect build results in **Deployments**.

Reference: [Cloudflare Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
