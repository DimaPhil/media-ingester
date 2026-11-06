# Ubuntu configuration and deployment

The [Compose service](../docker-compose.yml) binds Media Ingest to host loopback on port 4000 and persists uploads and subscription credentials in named volumes. Provision the database and ingress before starting the replacement service. The [configuration schema](../apps/api/src/config.ts) defines accepted values.

| Setting                | What to supply                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | The owner's PostgreSQL or Neon connection string. Use a separate disposable database for tests.                                                                                                                                                                                                                                                      |
| `MEDIA_PUBLIC_URL`     | The exact client-facing HTTPS origin of **Media Ingest**, including a nonstandard port if used. The server derives OAuth issuer, consent URLs and the MCP resource from it and checks the incoming Host. Configure a TLS reverse proxy to preserve that authority and forward to `127.0.0.1:4000`. Loopback HTTP is supported for local development. |
| `MEDIA_OWNER_TOKEN`    | An operator-generated secret of at least 32 characters. Generate 32 random bytes with `openssl rand -hex 32` in a private terminal or use a password manager. Store it in the service's protected environment and configure trusted clients with the same value as their bearer token. It grants full owner access and authorizes OAuth consent.     |
| `TELEGRAM_PROXY_URL`   | The Telegram Proxy API origin reachable **from the worker container**. On the same Docker host, use the shared network configuration below and `http://telegram-proxy:4040`. On different hosts, use the proxy's HTTPS endpoint and verify container reachability.                                                                                   |
| `TELEGRAM_PROXY_TOKEN` | The proxy operator's `API_BEARER_TOKEN` when proxy bearer authentication is enabled. Media Ingest sends it only to the configured Telegram proxy.                                                                                                                                                                                                    |

## Check the routes

On Ubuntu, run `tailscale serve status` to identify which external origin forwards to Media Ingest. A raw TCP forward to the HTTP listener does not provide HTTPS. Choose a free HTTPS listener or a dedicated hostname and route it to host port 4000. For example, if port 8446 is available, `tailscale serve --bg --https=8446 http://127.0.0.1:4000` creates a tailnet-only HTTPS listener. Set `MEDIA_PUBLIC_URL` to the exact HTTPS origin it reports with no path. The MCP endpoint is the origin plus `/mcp`. Test health and OAuth discovery through that same origin.

For Telegram on the same Docker host, start the proxy project first, then add the following non-secret settings to the Media Ingest deployment environment. The [optional Compose override](../compose.telegram.yml) attaches the API to the proxy's existing network while retaining its own default network. Set `TELEGRAM_PROXY_NETWORK` if the proxy uses a different Compose project/network name.

```sh
COMPOSE_FILE=docker-compose.yml:compose.telegram.yml
TELEGRAM_PROXY_URL=http://telegram-proxy:4040
# TELEGRAM_PROXY_NETWORK=telegram-proxy-api_default
```

The proxy can keep its host port bound to `127.0.0.1`. A port bound to host loopback cannot be reached through the host's tailnet IP from another bridge container; the Docker service name reaches the proxy directly on the shared network. Laptop clients use the proxy's HTTPS endpoint instead. Test reachability from the **Media Ingest** container and print only the HTTP status. A 401 confirms reachability when the proxy requires authentication.

```sh
docker compose exec -T api node -e 'fetch(new URL("/healthz", process.env.TELEGRAM_PROXY_URL), {signal: AbortSignal.timeout(5000)}).then(r => console.log(r.status))'
```

## Refresh YouTube cookies

YouTube downloads read a YouTube-only cookie jar from the media volume. Set `YT_DLP_COOKIES_PATH=/data/cookies/youtube.txt` (or the YouTube entry of `YT_DLP_AUTH_JSON`) in the deployment environment. Public videos download without cookies; the jar matters for content that needs an account.

YouTube rotates session cookies only inside a live browser, so a static export goes stale. Sign in on youtube.com itself (not only to the Google account) in a normal window of the host's snap Firefox on the desktop session, then quit Firefox. Prefer a secondary account. The [refresh script](../scripts/refresh-youtube-cookies.py) reads the default profile (or the profile directory named as its argument) read-only and keeps unexpired first-party `youtube.com` cookies only. With `--visit` it first opens YouTube in the desktop Firefox so the session rotates, then quits the browser if it started it; with Firefox already open it only adds a tab. Before replacing the jar atomically through a one-off `api` container, it checks the export against a login-only YouTube feed. A logged-out or failed export leaves the previous jar in place and exits non-zero.

```sh
scripts/refresh-youtube-cookies.py --visit         # refresh once
scripts/refresh-youtube-cookies.py --install-timer # weekly systemd user timer running --visit
systemctl --user status media-ingest-youtube-cookies.service
```

The timer needs user lingering (`loginctl enable-linger`) and opens Firefox on the desktop session when one exists, headless otherwise. A failed run means the YouTube session was revoked: sign in again in Firefox and start the service. The script never signs in or answers account challenges.

## Configure Telegram bearer authentication

The proxy operator supplies a shared secret. In the proxy's protected environment, set `API_AUTH_ENABLED=true` and `API_BEARER_TOKEN` to a newly generated secret. Set the identical value in Media Ingest as `TELEGRAM_PROXY_TOKEN` and update any other proxy clients. Keep the Media Ingest owner token separate. The proxy compares bearer credentials against its configured secret. If authentication is disabled, the client can omit the token and any caller that can reach the proxy has the same unauthenticated access. See the proxy's [settings](https://github.com/DimaPhil/telegram-proxy-api/blob/13784b00ea283f7ff15745f08235bbc68d39bdb0/src/telegram_proxy_api/config.py) and [authorization check](https://github.com/DimaPhil/telegram-proxy-api/blob/13784b00ea283f7ff15745f08235bbc68d39bdb0/src/telegram_proxy_api/dependencies.py).

Recreate the affected services after changing their environment. Verify that a protected route such as `/me` returns 401 without credentials and 200 with the intended bearer. Discard response bodies and keep tokens out of commands, logs and chat.

## Start the service

For Neon, link the desired project and branch with `neon init` and run `neon deploy` from the repository root. The [Neon policy](../neon.ts) uses Postgres. Transfer the pulled `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the service environment over SSH. The API uses the pooled connection and the explicit migration command prefers the direct connection. Keep both URLs out of Git.

For the upload retention upgrade, stop every older API/worker instance sharing the database and media volume before starting the new version. Run the explicit migration first. Migration 002 does not backfill cleanup of historical completed jobs.

Prepare the private service environment from [the example](../.env.example), back up the database and media volume, and configure the selected [providers](media-providers.md). Run the following in the reviewed Media Ingest checkout during deployment:

For migration 003, stop every old API/worker before migrating. The migration backfills completed outputs into durable history and adds indexed terminal-job expiry. The new API requires migration 003 and starts bounded cleanup at startup, then every minute. Back up the database before enabling the 30-day cleanup policy.

Migration 004 adds an index for result reuse ([ADR 0008](adr/0008-result-reuse.md)). It changes no data and older instances can keep running while it applies; run the explicit migration before or after starting the new version.

```sh
docker compose build
docker compose run --rm api node dist/migrate.js
docker compose up -d
```

The migration explicitly creates the application's schema. Startup checks it. Verify the deployed origin's `/healthz`, authenticated `info` and one representative job through the intended provider. For subscription jobs, complete native login in the dedicated Compose volumes first.
