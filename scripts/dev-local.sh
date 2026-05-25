#!/usr/bin/env bash
# Start the full local dev stack: worker + Caddy HTTPS proxy + Vite frontend.
# Prerequisites: brew install mkcert caddy && sudo mkcert -install
#
# One-time cert setup (if .certs/*.pem don't exist yet):
#   mkdir -p .certs
#   mkcert -key-file .certs/localhost+2-key.pem -cert-file .certs/localhost+2.pem localhost 127.0.0.1 ::1
#
# Copy .env.example to .env.local and set VITE_ADMIN_API_KEY=osprey-local-dev-key

set -euo pipefail
cd "$(dirname "$0")/.."

CERT=".certs/localhost+2.pem"
KEY=".certs/localhost+2-key.pem"

# Preflight checks
if ! command -v caddy &>/dev/null; then
  echo "error: caddy not installed. Run: brew install caddy" >&2; exit 1
fi
if ! command -v mkcert &>/dev/null; then
  echo "error: mkcert not installed. Run: brew install mkcert && sudo mkcert -install" >&2; exit 1
fi
if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
  echo "Generating local TLS certs..."
  mkdir -p .certs
  mkcert -key-file "$KEY" -cert-file "$CERT" localhost 127.0.0.1 ::1
fi
if [[ ! -f ".env.local" ]]; then
  echo "error: .env.local not found. Copy .env.example to .env.local and configure it." >&2; exit 1
fi
if [[ ! -f "worker/.dev.vars" ]]; then
  echo "error: worker/.dev.vars not found. Create it with NOSTR_NSEC and ADMIN_API_KEY." >&2; exit 1
fi

# Generate Caddyfile with absolute paths for this machine
REPO_ROOT="$(pwd)"
cat > .certs/Caddyfile <<CADDY
{
  auto_https off
}

:4443 {
  tls ${REPO_ROOT}/.certs/localhost+2.pem ${REPO_ROOT}/.certs/localhost+2-key.pem
  reverse_proxy localhost:4444
}

:8788 {
  tls ${REPO_ROOT}/.certs/localhost+2.pem ${REPO_ROOT}/.certs/localhost+2-key.pem
  reverse_proxy localhost:8787
}
CADDY

cleanup() {
  echo ""
  echo "Shutting down..."
  caddy stop 2>/dev/null || true
  [[ -n "${WRANGLER_PID:-}" ]] && kill "$WRANGLER_PID" 2>/dev/null || true
  [[ -n "${VITE_PID:-}" ]] && kill "$VITE_PID" 2>/dev/null || true
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

# Kill anything on our ports
for port in 5173 8787 8788 4443; do
  lsof -ti:"$port" 2>/dev/null | xargs kill -9 2>/dev/null || true
done
sleep 1

# 1. Worker (local D1 + Durable Objects)
echo "Starting worker on http://localhost:8787..."
(cd worker && npx wrangler dev --config wrangler.local.toml --local --port 8787 2>&1 | sed 's/^/[worker] /') &
WRANGLER_PID=$!

# 2. Caddy HTTPS proxy (8788 → 8787, 4443 → 4444)
echo "Starting Caddy HTTPS proxy..."
caddy start --config .certs/Caddyfile 2>/dev/null

# 3. Vite frontend
echo "Starting frontend on https://localhost:5173..."
npx vite --port 5173 2>&1 | sed 's/^/[vite] /' &
VITE_PID=$!

echo ""
echo "Local dev stack ready:"
echo "  Frontend:  https://localhost:5173"
echo "  Worker:    http://localhost:8787 (direct)"
echo "  API proxy: https://localhost:8788 (via Caddy)"
echo ""
echo "Select 'Local' in the environment selector."
echo "Press Ctrl+C to stop all services."
echo ""

wait
