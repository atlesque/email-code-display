const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.redirected || response.status === 401 || response.status === 403)
    throw new Error("Cloudflare Access sign-in required");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function message(text) {
  $("message").textContent = text;
}
async function refresh() {
  try {
    const s = await api("/api/status");
    $("dashboard").hidden = false;
    $("accounts").replaceChildren();
    for (const account of s.accounts) {
      const row = document.createElement("div");
      row.className = "account";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = account.email;
      const status = document.createElement("p");
      const badge = document.createElement("span");
      badge.className =
        "badge" + (account.status === "connected" ? "" : " warn");
      badge.textContent = account.status;
      status.append(
        account.provider === "gmail" ? "Gmail" : "Outlook",
        badge,
        account.last_checked
          ? new Date(account.last_checked).toLocaleTimeString()
          : "",
      );
      info.append(name, status);
      const disconnect = document.createElement("button");
      disconnect.className = "secondary";
      disconnect.textContent = "Disconnect";
      disconnect.onclick = async () => {
        try {
          await api("/api/accounts/disconnect", { id: account.id });
          await refresh();
        } catch (e) {
          message(e.message);
        }
      };
      row.append(info, disconnect);
      $("accounts").append(row);
    }
    if (!s.accounts.length) {
      const empty = document.createElement("p");
      empty.textContent = "No inboxes connected.";
      $("accounts").append(empty);
    }
    for (const p of ["gmail", "outlook"]) {
      $(p).classList.toggle("disabled", !s.providers[p]);
      $(p).setAttribute("aria-disabled", String(!s.providers[p]));
    }
    $("provider-status").textContent = Object.entries(s.providers)
      .filter(([, ready]) => !ready)
      .map(
        ([p]) =>
          `${p === "gmail" ? "Google" : "Microsoft"} OAuth not configured.`,
      )
      .join(" ");
    $("last-poll").textContent = s.lastPoll
      ? "Last check: " + new Date(s.lastPoll).toLocaleString()
      : "No checks yet.";
  } catch (e) {
    $("dashboard").hidden = true;
    message("Session expired. Reload to sign in.");
  }
}
$("check").onclick = async () => {
  try {
    await api("/api/check", {});
    message("Inbox check started.");
  } catch (e) {
    message(e.message);
  }
};
$("test").onclick = async () => {
  try {
    await api("/api/test-display", {});
    message("Test code sent.");
    pollDisplay();
  } catch (e) {
    message(e.message);
  }
};

// Mirrors firmware/email_code_display/power_policy.h and fetchCode().
const POLL_MS = 5000,
  IDLE_SCREEN_MS = 15000,
  CODE_BRIGHT_MS = 30000;
const screen = { id: "", code: "", service: "", provider: "", deadline: 0 };
let screenActivity = Date.now();
function clearScreen() {
  Object.assign(screen, { id: "", code: "", service: "", provider: "" });
  screen.deadline = 0;
  screenActivity = Date.now();
}
async function pollDisplay() {
  if (document.hidden || $("dashboard").hidden) return;
  try {
    const started = Date.now();
    const r = await api("/api/display");
    if (!r.code) {
      if (screen.code) clearScreen();
    } else {
      const seconds = Math.min(300, r.remainingSeconds);
      const deadline = started + seconds * 1000;
      const changed = r.id !== screen.id || r.code !== screen.code;
      // Repeated responses never extend an existing code's deadline.
      screen.deadline = changed
        ? deadline
        : Math.min(screen.deadline, deadline);
      Object.assign(screen, {
        id: r.id,
        code: r.code,
        service: r.service || "",
        provider: r.provider || "",
      });
      if (changed) screenActivity = Date.now();
    }
  } catch {}
  renderScreen();
}
function renderScreen() {
  const now = Date.now();
  if (screen.code && now >= screen.deadline) clearScreen();
  const elapsed = now - screenActivity;
  const state = screen.code
    ? elapsed < CODE_BRIGHT_MS
      ? "bright"
      : "dim"
    : elapsed < IDLE_SCREEN_MS
      ? "idle"
      : "asleep";
  const el = $("screen");
  el.className = "display-preview " + state;
  el.classList.toggle("long", screen.code.length > 8);
  $("screen-service").textContent = screen.code
    ? screen.service
    : "Ready for your next code";
  $("screen-code").textContent = screen.code;
  $("screen-footer").textContent = screen.code
    ? `${screen.provider}  /  ${Math.floor((screen.deadline - now) / 1000)}s`
    : "";
  $("screen-state").textContent = screen.code
    ? "Code"
    : state === "idle"
      ? "Idle"
      : "Asleep";
  $("screen-state").classList.toggle("off", !screen.code);
}
// Clicking the preview acts like the device button when no code is shown.
$("screen").onclick = () => {
  if (!screen.code) screenActivity = Date.now();
  renderScreen();
};
document.addEventListener("visibilitychange", pollDisplay);

refresh().then(pollDisplay);
setInterval(refresh, 15000);
setInterval(pollDisplay, POLL_MS);
setInterval(renderScreen, 250);
