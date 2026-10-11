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
      status.textContent =
        account.provider.toUpperCase() +
        " · " +
        account.status +
        (account.last_checked
          ? " · " + new Date(account.last_checked).toLocaleTimeString()
          : "");
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
      empty.textContent = "Connect your first inbox to get started.";
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
          `${p === "gmail" ? "Google" : "Microsoft"} OAuth application still needs configuration.`,
      )
      .join(" ");
    $("last-poll").textContent = s.lastPoll
      ? "Last inbox check: " +
        new Date(s.lastPoll).toLocaleString() +
        " · Every minute"
      : "Waiting for the first scheduled check.";
  } catch (e) {
    $("dashboard").hidden = true;
    message(
      "Session expired or unavailable. Reload to sign in through Cloudflare Access.",
    );
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
    message("Test code sent. It will clear in one minute.");
  } catch (e) {
    message(e.message);
  }
};

refresh();
setInterval(refresh, 15000);
