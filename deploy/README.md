# Hosting Tail Bazaar on a Linux VM (Ubuntu 22.04/24.04, x86_64)

This is a prototype in local demonstration mode: the seller, verifier and buyer agents all run on
the server with test-only keys, so a public host is a demo console, not a multi-user marketplace.
Nothing here has been deployed publicly by the build pass; these are the steps for the operator.

## Prerequisites

```bash
sudo apt-get update && sudo apt-get install -y curl git build-essential
curl -LsSf https://astral.sh/uv/install.sh | sh            # uv (Python 3.12 is downloaded by uv)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs   # node 24
curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup   # only needed to deploy contracts
```

MuJoCo 3.13 ships manylinux x86_64 wheels; `uv sync --frozen` in `sim/` installs it without a
compiler. No GUI, no OpenGL and no GIF rendering is needed on the server: the web replay uses the
recorded transforms. (The optional `--render` flag of the simulator CLI needs matplotlib only.)

## Configure

```bash
git clone <repo> /opt/tail-bazaar && cd /opt/tail-bazaar
cp .env.example .env            # then fill in keys/addresses; never commit .env
# CHAIN_MODE=testnet, ESCROW_ADDRESS_BASE_SEPOLIA=<from scripts/testnet-deploy.sh>
# PORT=3100  PUBLIC_BASE_URL=https://tail-bazaar.example.com
# OPERATOR_TOKEN=$(openssl rand -hex 32)   # optional; the only key to the pipeline trigger
# DEMO_TRIGGER_ENABLED=0 to remove the pipeline trigger entirely
```

**Setting `PUBLIC_BASE_URL` is what turns on hosted mode**, and hosted mode is what keeps paid
evidence private: the buyer-console reveal route and the baseline run then require a bearer token (the
buyer session issued by a signed-challenge retrieval, or `OPERATOR_TOKEN`), and `POST /api/demo/run`
requires `OPERATOR_TOKEN`. `deploy/start.sh` always exports `PUBLIC_BASE_URL`, so a host started
through it is authenticated even if the operator forgets to set the variable. Verify after deploying:

```bash
curl -si https://tail-bazaar.example.com/api/status | grep -i hosted_mode        # expect true
curl -si https://tail-bazaar.example.com/api/orders/<id>/reveal | head -1        # expect 401
```

Run once by hand to build and smoke-test: `deploy/start.sh` (Ctrl-C to stop).

## systemd unit

`/etc/systemd/system/tail-bazaar.service`:

```ini
[Unit]
Description=Tail Bazaar marketplace (demo)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tailbazaar
WorkingDirectory=/opt/tail-bazaar
EnvironmentFile=/opt/tail-bazaar/.env
Environment=PORT=3100
Environment=PUBLIC_BASE_URL=https://tail-bazaar.example.com
ExecStart=/opt/tail-bazaar/deploy/start.sh
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -m -d /home/tailbazaar tailbazaar && sudo chown -R tailbazaar /opt/tail-bazaar
sudo systemctl daemon-reload && sudo systemctl enable --now tail-bazaar && journalctl -fu tail-bazaar
```

## Caddy reverse proxy (automatic TLS)

`/etc/caddy/Caddyfile`:

```
tail-bazaar.example.com {
    reverse_proxy 127.0.0.1:3100
    # Optional: protect the demo trigger behind basic auth instead of disabling it
    # @demo path /api/demo/*
    # basicauth @demo { operator <bcrypt hash from `caddy hash-password`> }
}
```

`sudo systemctl reload caddy`. Point the DNS A record at the VM first.

## What the host exposes

- Public: listings (public summaries only), orders and timelines, the verifier's checks, the published
  envelope (`GET /api/envelope`), status, balances, static UI.
- Authenticated in hosted mode (401 without a bearer token): `GET /api/orders/:id/reveal` (package
  bytes), `GET /api/runs/baseline` (a full recorded trajectory). `POST /api/retrieve` is always
  authenticated by the signed challenge. `POST /api/demo/run` needs `OPERATOR_TOKEN`.
- Never exposed: private keys, un-purchased packages, the SQLite file (`web/data/`), the failure
  ledger export (`npm run ledger` writes it for the operator; no HTTP route serves it, because every
  row contains the scenario parameters buyers pay for).
- `DEMO_BUYER_CONSOLE=0` removes the reveal route altogether (403 for everyone, including the buyer).
