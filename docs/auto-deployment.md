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

Apply new D1 migrations with `npm run db:remote` before deploying code that needs
them. The automatic deployment command does not apply database migrations.

Manage the connection and commands in the Worker's **Settings → Builds** section.
Inspect build results in **Deployments**.

Reference: [Cloudflare Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
