# Ubuntu configuration and deployment

The [Compose service](../docker-compose.yml) binds Media Ingest to host loopback on port 4000 and persists uploads and subscription credentials in named volumes. Provision the database and ingress before starting the replacement service. The [configuration schema](../apps/api/src/config.ts) defines accepted values.

| Setting                | What to supply                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | The owner's PostgreSQL or Neon connection string. Use a separate disposable database for tests.                                                                                                                                                                                                                                                      |
| `MEDIA_PUBLIC_URL`     | The exact client-facing HTTPS origin of **Media Ingest**, including a nonstandard port if used. The server derives OAuth issuer, consent URLs and the MCP resource from it and checks the incoming Host. Configure a TLS reverse proxy to preserve that authority and forward to `127.0.0.1:4000`. Loopback HTTP is supported for local development. |
| `MEDIA_OWNER_TOKEN`    | An operator-generated secret of at least 32 characters. Generate 32 random bytes with `openssl rand -hex 32` in a private terminal or use a password manager. Store it in the service's protected environment and configure trusted clients with the same value as their bearer token. It grants full owner access and authorizes OAuth consent.     |
| `TELEGRAM_PROXY_URL`   | The Telegram Proxy API origin reachable **from the worker container**. For separate Compose projects on the same Ubuntu host, use its reachable tailnet address and published proxy port, typically `http://<ubuntu-tailnet-host>:4040`. A shared Docker network can instead use the proxy service name.                                             |
| `TELEGRAM_PROXY_TOKEN` | The proxy operator's `API_BEARER_TOKEN` when proxy bearer authentication is enabled. Media Ingest sends it only to the configured Telegram proxy.                                                                                                                                                                                                    |

## Check the routes

On Ubuntu, run `tailscale serve status` to identify which external origin forwards to Media Ingest. A raw TCP forward to the HTTP listener does not provide HTTPS. Choose a free HTTPS listener or a dedicated hostname and route it to host port 4000. For example, if port 8446 is available, `tailscale serve --bg --https=8446 http://127.0.0.1:4000` creates a tailnet-only HTTPS listener. Set `MEDIA_PUBLIC_URL` to the exact HTTPS origin it reports with no path. The MCP endpoint is the origin plus `/mcp`. Test health and OAuth discovery through that same origin.

For Telegram, inspect the published port with `docker compose ps` in the **proxy** project. Get the Ubuntu tailnet IPv4 address with `tailscale ip -4`. Container loopback points to the calling container. Test a known proxy URL from the **Media Ingest** container and print only the HTTP status. A 401 confirms reachability when the proxy requires authentication.

```sh
docker compose exec -T api node -e 'fetch(new URL("/healthz", process.env.TELEGRAM_PROXY_URL), {signal: AbortSignal.timeout(5000)}).then(r => console.log(r.status))'
```

## Configure Telegram bearer authentication

The proxy operator supplies a shared secret. In the proxy's protected environment, set `API_AUTH_ENABLED=true` and `API_BEARER_TOKEN` to a newly generated secret. Set the identical value in Media Ingest as `TELEGRAM_PROXY_TOKEN` and update any other proxy clients. Keep the Media Ingest owner token separate. The proxy compares bearer credentials against its configured secret. If authentication is disabled, the client can omit the token and any caller that can reach the proxy has the same unauthenticated access. See the proxy's [settings](https://github.com/DimaPhil/telegram-proxy-api/blob/13784b00ea283f7ff15745f08235bbc68d39bdb0/src/telegram_proxy_api/config.py) and [authorization check](https://github.com/DimaPhil/telegram-proxy-api/blob/13784b00ea283f7ff15745f08235bbc68d39bdb0/src/telegram_proxy_api/dependencies.py).

Recreate the affected services after changing their environment. Verify that a protected route such as `/me` returns 401 without credentials and 200 with the intended bearer. Discard response bodies and keep tokens out of commands, logs and chat.

## Start the service

For Neon, link the desired project and branch with `neon init` and run `neon deploy` from the repository root. The [Neon policy](../neon.ts) uses Postgres. Transfer the pulled `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the service environment over SSH. The API uses the pooled connection and the explicit migration command prefers the direct connection. Keep both URLs out of Git.

For the upload retention upgrade, stop every older API/worker instance sharing the database and media volume before starting the new version. Run the explicit migration first. Migration 002 does not backfill cleanup of historical completed jobs.

Prepare the private service environment from [the example](../.env.example), back up the database and media volume, and configure the selected [providers](media-providers.md). Run the following in the reviewed Media Ingest checkout during deployment:

```sh
docker compose build
docker compose run --rm api node dist/migrate.js
docker compose up -d
```

The migration explicitly creates the application's schema. Startup checks it. Verify the deployed origin's `/healthz`, authenticated `info` and one representative job through the intended provider. For subscription jobs, complete native login in the dedicated Compose volumes first.
