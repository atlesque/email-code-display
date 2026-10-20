import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
          DEVICE_TOKEN: "test-device-secret",
          ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          GMAIL_PUBSUB_TOPIC: "projects/test/topics/gmail",
          GMAIL_PUSH_SERVICE_ACCOUNT: "push@test.iam.gserviceaccount.com",
        },
      },
    }),
  ],
});
