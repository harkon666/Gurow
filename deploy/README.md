# Deploying Gurow to one host

`scripts/deploy.sh USER@HOST PUBLIC_ORIGIN` builds the frontend here, prepares the host
(`deploy/provision.sh`: Docker with Compose, and a firewall open only for SSH, HTTP and HTTPS),
copies the release to `/opt/gurow`, and starts `deploy/compose.yaml`: PostgreSQL, the backend
(migrations run before it starts), the frontend server, and Caddy in front. Only Caddy is
published. Pass SSH options through `DEPLOY_SSH_OPTS`, for example `-i ~/.ssh/key`.

Run it again to deploy a newer checkout; the database volume and the host's settings are kept.

## Settings

`/opt/gurow/deploy/.env` on the host is created on the first deploy, with a generated database
password and session secret, and is never overwritten or copied back. After changing it, run
`sudo docker compose up -d` in `/opt/gurow/deploy`.

| Name | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | The one address people open; sign-in and emailed links depend on it (ADR 0022). |
| `SITE_ADDRESS` | What Caddy serves: `:80` for plain HTTP on any address, or domain names for automatic HTTPS, comma-separated. A `www.` name listed here redirects to `PUBLIC_ORIGIN`. |
| `EMAIL_VERIFICATION` | `required` (default) or `off` for trials without a sending domain. |
| `RESEND_API_KEY`, `MAIL_FROM` | Email delivery (ADR 0023); without them links are only logged. |

## HTTPS

A bare IP address is served over plain HTTP, so passwords and session cookies travel
unencrypted. To use HTTPS, point a domain's DNS A record at the host, then set
`PUBLIC_ORIGIN=https://that.domain` and `SITE_ADDRESS=that.domain` and run
`sudo docker compose up -d`. Caddy obtains and renews the certificate. Existing sessions end,
because the origin changes.

## Operating

In `/opt/gurow/deploy` on the host: `sudo docker compose ps`, `sudo docker compose logs -f backend`,
and `sudo docker compose exec postgres pg_dump -U gurow gurow > backup.sql` for a backup. Nothing
backs the database up automatically.
