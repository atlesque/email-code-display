# Email Code Display

Gmail and Outlook one-time access codes on an **Adafruit ESP32-S3 Reverse TFT Feather**. A personal Cloudflare Worker checks connected inboxes every minute; the board polls for the latest code every five seconds. Press **D0** to dismiss it.

Production deployment: https://codes.atlesque.dev

## How it works

1. Connect one or more Gmail or Outlook mailboxes through OAuth with read-only mail permissions.
2. The Worker checks new inbox messages, starting at the moment each account was connected. A five-minute lookback catches messages delayed between checks. It does not mark messages read.
3. Likely code messages go to the configured model through the Cloudflare AI binding. The model classifies the email; the Worker accepts only high-confidence codes that appear verbatim in the message. A strict explicitly-labelled code extractor handles AI outages.
4. Tokens and code payloads are encrypted using AES-256-GCM in D1. Message bodies are not stored. D1 leases serialize inbox checks.
5. The board authenticates using its own key over verified HTTPS. It receives only a code, sender domain, provider, and remaining display time. Codes disappear five minutes after email arrival, including while offline.

This is a single-owner service, not a multi-tenant SaaS. The repo is public; the deployment's credentials and mailboxes are private.

## Development

Node 24+, npm, and a Cloudflare account:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Generate unique random admin/device keys and a base64-encoded 32-byte encryption key.
npm run types
npm run db:local
npm run dev
npm run check
npm test
```

The origin is configured to the production hostname. For local browser login and OAuth, change `PUBLIC_BASE_URL` to your local URL and register matching callback URLs. Cookies are Secure; use HTTPS when testing browser sessions.

Tests run in the Workers runtime and use local D1. Inference is mocked or excluded from tests, so tests do not submit real email to AI.

## Deploy your own instance

1. Change `account_id`, hostname routes, and `PUBLIC_BASE_URL` in `wrangler.jsonc`.
2. Run `npx wrangler d1 create email-code-display`, update the returned database ID, then `npm run db:remote`.
3. Configure the OAuth applications below. Set client IDs in `wrangler.jsonc` and secrets using `npx wrangler secret put GOOGLE_CLIENT_SECRET` / `MICROSOFT_CLIENT_SECRET`.
4. Set `ADMIN_TOKEN`, `DEVICE_TOKEN`, and `ENCRYPTION_KEY` as Worker secrets. Keep the encryption key backed up securely; changing it makes existing tokens unreadable until mailboxes reconnect.
5. `npm run types && npm run check && npm test`, then `npm run deploy`.
6. Sign in to the control panel using the admin key, connect inboxes, and select **Send a display test**.

### Gmail

Enable Gmail API in a dedicated Google Cloud project. Configure Google Auth Platform branding/audience and a **Web application** OAuth client. Register:

```
https://YOUR_HOST/oauth/callback/gmail
```

The app requests `https://www.googleapis.com/auth/gmail.readonly` with offline access and PKCE. Use a Google Workspace internal audience for mailboxes in your own organization, if available. For an external app in Testing, list the test users; Google refresh tokens then expire after seven days. Publishing to a broader audience can require Google's restricted-scope verification and security assessment. A public GitHub repository does not require making this personal OAuth app public.

### Outlook / Hotmail / Microsoft 365

Register a **Web** app in Microsoft Entra with personal Microsoft accounts and organization accounts enabled. Register:

```
https://YOUR_HOST/oauth/callback/outlook
```

Create a client secret and configure delegated `Mail.Read`, `User.Read`, and `offline_access` permissions. The flow uses PKCE and a server-side secret. `MICROSOFT_TENANT=common` supports personal and organization accounts; organizations may require administrator approval. Do not reuse credentials or mail tokens from an unrelated service.

### AI model

The configured model is `@cf/qwen/qwen3-30b-a3b-fp8`, hosted by Cloudflare. A live synthetic extraction was verified. Hosted models run directly through the Workers AI binding. For optional Gemini support, first create an AI Gateway named `email-code-display` with logging and caching disabled, then set `AI_MODEL` to `google/gemini-2.5-flash-lite`. Gemini requests disable logging and caching explicitly. Enable AI Gateway Unified Billing credits or a supported provider key in your Cloudflare account before switching. Without model access, only strict, explicitly labelled codes are extracted using rules.

Documented model prices at setup: Qwen $0.0509 / million input tokens, $0.335 / million output tokens; Gemini $0.10 / million input tokens, $0.40 / million output tokens. Cloudflare infrastructure and credit-purchase fees are separate. Only messages with code-like candidates invoke the model; inputs are capped to 10,000 body characters.

## Feather firmware

Board: **Adafruit Feather ESP32-S3 Reverse TFT** (`esp32:esp32:adafruit_feather_esp32s3_reversetft`). Display: ST7789, 240×135, using the board core's TFT pin constants. The board needs 2.4 GHz Wi-Fi and USB or battery power.

Install the ESP32 Arduino core and these libraries:

```sh
arduino-cli lib install 'Adafruit ST7735 and ST7789 Library' ArduinoJson
cp firmware/email_code_display/secrets.example.h firmware/email_code_display/secrets.h
# Fill in Wi-Fi settings, Worker URL, and DEVICE_TOKEN. This file is ignored by Git.
npm run firmware:compile
arduino-cli upload --fqbn esp32:esp32:adafruit_feather_esp32s3_reversetft --port YOUR_PORT firmware/email_code_display
```

TLS uses the ESP32 core's public certificate bundle; no insecure TLS bypass is used. NTP sets the clock before requests. Reconnection happens automatically. D0 clears the visible code immediately and requests server dismissal. If a dismissal request fails while offline, the current firmware suppresses that same code locally until it disappears from the server.

### Battery and response time

The firmware keeps its five-second polling interval after successful checks, with an immediate first check when Wi-Fi and the clock are ready. The Worker still checks inboxes once per minute: typical arrival-to-display delay is therefore up to roughly 65 seconds, plus provider, extraction, and network time. Once the Worker has a code, the board usually picks it up within five seconds plus request time. These are healthy-network estimates, not hard deadlines.

- Wi-Fi minimum modem sleep retains association; HTTP/1.1 reuses verified TLS connections when the server allows it. Responses are bounded to 4 KB and completely consumed before reuse.
- The CPU runs at 80 MHz between requests and 240 MHz during network work. Unused board LEDs and the NeoPixel power rail are disabled.
- The idle screen is dim and sleeps after 15 seconds. A new code wakes it automatically. Codes start at reduced brightness and dim further after 30 seconds; repeated polls do not reset that timer. D0 dismisses a visible code, or wakes an idle display and requests a check.
- Only the countdown area redraws each second. The main loop yields for 50 ms between checks.
- A tiny battery icon in the upper-right corner reads the onboard MAX17048 every 30 seconds. Its fill turns red at 20% or below. A dash means the gauge is unavailable (including older LC709203F boards); no charge estimate is invented. Battery updates do not wake the screen.
- Failed service requests back off to 60 seconds; Wi-Fi reconnect attempts back off to 120 seconds. Successful checks restore five-second polling. Pending dismissals retry while the board remains powered, and codes continue to expire locally during outages. Slow network calls can temporarily delay button handling and screen expiry until the call returns.

The stock Arduino core used here does not enable automatic CPU light sleep. Manually entering deep/light sleep between checks would disconnect Wi-Fi and add reconnect cost and latency, so this firmware uses connected modem sleep instead. See [Espressif power management](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/power_management.html) and [PWM backlight API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html).

Run the host timing scenarios with `c++ -std=c++11 test/firmware_power.test.cpp -o /tmp/email-code-display-power-test && /tmp/email-code-display-power-test`, then compile the firmware as above. On the board, verify idle screen sleep, automatic code wake, dimming without repeated wakeups, D0 dismissal, reconnect recovery, and expiry during an outage. Measure current on battery power with USB disconnected, both before and after the change; battery runtime depends on capacity, signal strength, and code frequency and has not been measured here.

On Macs with an incompatible bundled Arduino `ctags`, this sketch defines functions in dependency order. Compile with `--build-property tools.ctags.cmd.path=/usr/bin/true` to skip automatic prototype generation.

## Security and limits

- The admin key grants mailbox management. The device key can read/dismiss codes but cannot access OAuth credentials or connect mailboxes.
- OAuth state is random, encrypted, browser-bound, single-use, and expires after ten minutes. Admin sessions are signed, HttpOnly, Secure, and expire after 24 hours.
- No email bodies, tokens, or actual codes are written to application logs. Model caching/logging are disabled per request.
- Recent inbox scans are capped at four pages of 50 messages per mailbox. Extremely busy inboxes may exceed this window. Gmail full messages larger than 2 MB are rejected for that check.
- OTP detection is best-effort. Email wording, unusual formats, ambiguous codes, or model failures can cause misses. Rules support English and Dutch explicitly labelled codes.
- The five-minute time window is display retention, not a claim about each provider's actual code validity.
- Disconnect removes local account tokens and codes. Revoke app grants through Google/Microsoft account settings to fully remove provider-side access.
- Expired ciphertext can persist in D1 backups according to Cloudflare retention; the device API never serves expired codes.

See [privacy details](public/privacy.html). Licensed under MIT.
