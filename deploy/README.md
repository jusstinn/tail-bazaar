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
# DEMO_TRIGGER_ENABLED=0 to stop anonymous visitors from triggering testnet transactions
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

- Public: listings (summaries only), orders and timelines, the public baseline run, static UI.
- Authenticated: `POST /api/retrieve` (signed challenge). `GET /api/orders/:id/reveal` shows packages
  the local buyer agent already purchased (buyer console); set `DEMO_BUYER_CONSOLE=0` to hide it.
- Never exposed: private keys, un-purchased packages, the SQLite file (`web/data/`).
