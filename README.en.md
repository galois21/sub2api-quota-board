# Sub2API Quota Board

[简体中文](README.md) | **English**

**A lightweight dashboard for Sub2API upstream account quotas, concurrency, and recent activity.**

Add an upstream quota dashboard to Sub2API's custom menu so regular signed-in users can see the currently available capacity.

A standalone Node.js service with a plain HTML/CSS/JavaScript page. No runtime dependencies, database connection, or frontend build step. It reads Sub2API's admin API without changing Sub2API's source code or framework. This is an independently maintained, third-party tool for [Sub2API](https://github.com/Wei-Shaw/sub2api).

## Features

<img width="2398" height="1566" alt="image" src="https://github.com/user-attachments/assets/be03d7cb-d979-4bc1-9c51-f3a392ef92a8" />

- Three tabs: GPT, Antigravity, and Gemini. GPT opens by default; quotas are fetched only for the selected tab, and other tabs load on their first visit.
- Quota windows, used and remaining percentages, reset countdowns in parentheses, account status, current concurrency, and unique users in the last five minutes.
- Summary counts for total, available, rate-limited, and disabled accounts. Two account cards per row on desktop, one on mobile, with light and dark themes.
- Checks the current tab every 60 seconds and pauses while the page is hidden. Supports manual updates, caching, and request coalescing.
- Disabled accounts keep gray cards with quota details hidden. Viewers see account aliases instead of real email addresses, credentials, or internal notes.
- The admin key stays on the server. Viewers use their existing Sub2API login.

Verified with Sub2API `0.2.18`. For other versions, check compatibility with its admin API and custom menu format. This dashboard shows **upstream account quotas**, rather than individual users' balances or spending.

## Easiest installation: ask an AI agent

Copy this prompt to an AI agent that can operate your server, then fill in your directory and site address:

```text
Install https://github.com/galois21/sub2api-quota-board on my server
and add it to Sub2API's custom menu so regular signed-in users can view upstream account quotas.

My Sub2API directory: <existing Sub2API directory>
My Sub2API site: https://<your domain>
Server connection: <SSH host, username, and authentication method; do not commit passwords or private keys to Git>

Read the project README first. Inspect the existing deployment, Node.js, and reverse proxy,
then deploy the dashboard as a separate service.
Preserve existing menus. Do not modify Sub2API's source code, framework, or database.
I will enter the admin key directly on the server; tell me where the configuration file is.
Do not put the key in chat, Git, the web page, or the menu URL.
When finished, give me the dashboard URL and verify that anonymous visitors cannot read quotas
while regular signed-in users can.
```

## Manual installation

The examples below use Linux, systemd, and Nginx, serving the dashboard under `/quota/` on the same origin as Sub2API. You need Node.js 22 or later, Git, and an administrator API key that can read Sub2API's upstream accounts and quotas. This is not a regular model API key. The menu configuration step also requires access to system settings.

### 1. Download the source

```sh
sudo git clone https://github.com/galois21/sub2api-quota-board.git /opt/sub2api-quota-board
cd /opt/sub2api-quota-board
node --version
npm test
```

There are no npm dependencies, so `npm install` is unnecessary. Tests use local mock APIs and require no real keys.

### 2. Configure the server environment file

```sh
sudo install -m 600 .env.example /etc/sub2api-quota-board.env
sudoedit /etc/sub2api-quota-board.env
```

Set these values:

```dotenv
SUB2API_BASE_URL=http://127.0.0.1:8080
SUB2API_ADMIN_KEY=
PUBLIC_ORIGIN=https://sub2api.example.com
BASE_PATH=/quota
PORT=18081
```

| Setting | Description |
| --- | --- |
| `SUB2API_BASE_URL` | Sub2API's address as reachable from this service; use your actual internal address and port |
| `SUB2API_ADMIN_KEY` | Enter the admin key in an editor on the server; if empty, the quota API reports that the service is not configured |
| `PUBLIC_ORIGIN` | Your actual Sub2API HTTPS origin, matching the domain users sign in to, without `/quota/` |
| `BASE_PATH` | Defaults to `/quota`; update the Nginx paths and menu if you change it |
| `PORT` | Defaults to `18081`; the service listens only on `127.0.0.1` |

Keep the real environment file outside the project directory with permissions set to `600`. Do not copy it into `public/` or commit it to the repository.

### 3. Start the service

```sh
command -v node
sudo install -m 644 deploy/sub2api-quota-board.service /etc/systemd/system/sub2api-quota-board.service
```

The template uses `/usr/bin/node` and `/opt/sub2api-quota-board`. If your paths differ, edit the installed service file before starting it. The template enables `ProtectHome=true`, so install Node.js in a system directory rather than using an NVM installation in a user's home directory.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sub2api-quota-board
curl -fsS http://127.0.0.1:18081/quota/healthz
```

After entering the key, the health endpoint should return `{"status":"ok","configured":true}`. This confirms only that a key is configured; verify its actual permissions through the quota page. The dynamic service user must be able to read the source files and parent directories. systemd reads the environment file, so its permissions do not need to be relaxed.

### 4. Add a reverse proxy on the same origin

Add the contents of `deploy/nginx.conf` to the existing HTTPS `server` block for Sub2API, or save it as a snippet and include it. Preserve the site's existing proxy and certificate configuration.

```sh
sudo install -d -m 755 /etc/nginx/snippets
sudo install -m 644 /opt/sub2api-quota-board/deploy/nginx.conf /etc/nginx/snippets/sub2api-quota-board.conf
```

Include it in the existing HTTPS `server` block:

```nginx
include /etc/nginx/snippets/sub2api-quota-board.conf;
```

Validate the configuration before reloading Nginx:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

For control panels such as aaPanel/BT, use the panel's configuration directories and Nginx validation/reload controls. If Nginx runs in a container, adjust the proxy address so it can reach the host service; there is no need to expose `18081` to the internet.

The example proxy disables access logging for this path because custom menu entry URLs may contain a user's login token. Any CDN, gateway, or monitoring system in front of it should also avoid recording these query parameters. See [SECURITY.md](SECURITY.md).

### 5. Add the custom menu

Run this once using your configured environment file:

```sh
sudo /usr/bin/node --env-file=/etc/sub2api-quota-board.env /opt/sub2api-quota-board/scripts/configure-menu.mjs
```

The script preserves existing menu entries and idempotently adds a user-visible menu named “上游额度” (Upstream Quota), without changing other settings. Starting the dashboard later does not automatically rewrite menus. Alternatively, add a user-visible custom menu manually in Sub2API's admin settings with this URL:

```text
https://<your Sub2API domain>/quota/
```

Do not put the admin key in the menu URL. Sign in to Sub2API and open the menu. Direct visits on the same origin also attempt to reuse your existing login. Administrators can switch to personal navigation to view the user menu.

## Data definitions

- Current concurrency counts requests being processed, not distinct people. Recent activity counts distinct users within the current provider group over the last five minutes; only the count is returned, never user identities or request records.
- GPT displays the 5-hour window above the 7-day window. The standalone Gemini tab displays the per-minute window above the daily window.
- Antigravity displays Gemini above Claude / GPT. Duplicate model quotas are represented by the highest utilization. An otherwise active account is marked rate-limited only when both Gemini's 5-hour quota and the Claude / GPT quota are exhausted. Error and disabled states take priority.
- Disabled accounts are not queried for upstream quotas, and their quota details are removed from the public API. Their cards display “额度不可用” (Quota unavailable).
- Missing, failed, or expired data is labeled accordingly. It is not interpreted as 100% remaining. Percentages are not added across accounts, and no estimate guarantees how long capacity will last.
- All valid signed-in users see the same set of public accounts, regardless of their plan. Confirm that this sharing scope fits your site before installation.
- The service exposes fixed, read-only quota endpoints. The separate menu script calls the settings API. It does not test accounts, clear rate limits, refresh OAuth credentials, or change quotas.

## Updates and removal

Keep `/etc/sub2api-quota-board.env` when updating:

```sh
cd /opt/sub2api-quota-board
sudo git pull --ff-only
npm test
sudo systemctl restart sub2api-quota-board
```

To remove the dashboard, first remove its menu from Sub2API's admin settings. Then stop the service and remove its Nginx snippet/include and systemd service. Validate and reload Nginx while preserving the main site's configuration. Keep or delete the environment file separately as needed.

## Security and license

See [SECURITY.md](SECURITY.md) for security boundaries, logging considerations, and vulnerability reporting. Test data is fictional, and the example configuration contains no real credentials.

[MIT License](LICENSE).
