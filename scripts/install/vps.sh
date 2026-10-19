#!/usr/bin/env bash
# Install Cartethyia on a VPS in one shot.
#
#   NAT VPS (provider already terminates TLS):
#     curl -fsSL <raw-url>/scripts/install/vps.sh | bash -s -- --nat --full
#
#   Regular VPS (you install Caddy, it issues the certificate):
#     curl -fsSL <raw-url>/scripts/install/vps.sh | bash -s -- --regular --full
#
#   Lite mode (SQLite, no Postgres):
#     bash scripts/install/vps.sh --regular --lite
#
# Idempotent: safe to re-run. An existing .env is never overwritten.
#
# Flags:
#   --nat | --regular    topology                 (required; see below)
#   --full | --lite      database mode            (default --full)
#   --domain <host>      public hostname          (required with --regular)
#   --skip-tls           --regular without Caddy  (you front it yourself)
#
# Topology decides who owns TLS, and guessing wrong is the expensive mistake:
#   --nat      the VM sits on a private address behind the provider's own
#              Caddy, which already terminates TLS. This script never installs
#              a second proxy and never sets `local_certs`: doing either
#              breaks the provider's certificate.
#   --regular  the VM holds the public IP, so this script installs Caddy and
#              lets it issue a real Let's Encrypt certificate. DNS must already
#              point at this host.
#
# Environment overrides:
#   CARTETHYIA_ROOT       install root        (default /opt/cartethyia)
#   CARTETHYIA_BRANCH     git branch or tag   (default main)
#   CARTETHYIA_PORT       app port on loopback (default 8080)
#   CARTETHYIA_REPO_URL   git remote          (default the public repository)
#   CARTETHYIA_DB_NAME    Postgres database   (default cartethyia, --full only)
#   CARTETHYIA_DB_USER    Postgres role       (default cartethyia, --full only)
set -euo pipefail

ROOT=${CARTETHYIA_ROOT:-/opt/cartethyia}
BRANCH=${CARTETHYIA_BRANCH:-main}
PORT=${CARTETHYIA_PORT:-8080}
REPO_URL=${CARTETHYIA_REPO_URL:-https://github.com/risunCode/Cartethyia.git}
DB_NAME=${CARTETHYIA_DB_NAME:-cartethyia}
DB_USER=${CARTETHYIA_DB_USER:-cartethyia}
REPO="$ROOT/repo"

TOPOLOGY=""
DB_MODE=full
DOMAIN=""
WANT_CADDY=1

usage() {
  sed -n '2,32p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  exit 0
}

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --nat) TOPOLOGY=nat ;;
    --regular) TOPOLOGY=regular ;;
    --full) DB_MODE=full ;;
    --lite) DB_MODE=lite ;;
    --domain) shift; DOMAIN=${1:-} ;;
    --skip-tls) WANT_CADDY=0 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

[ -n "$TOPOLOGY" ] || die "pick a topology: --nat or --regular"
[ "$(id -u)" = "0" ] || die "run as root"

if [ "$TOPOLOGY" = regular ] && [ "$WANT_CADDY" = 1 ] && [ -z "$DOMAIN" ]; then
  die "--domain is required with --regular (or pass --skip-tls)"
fi
# A source run cannot take Elysia's eager validator branch; see
# resolveElysiaPrecompile(). The deployed service runs dist/main.js, which is
# built by build:aot and can — but anything started from source must not.
SOURCE_RUN=1

say "topology=$TOPOLOGY mode=$DB_MODE port=$PORT root=$ROOT"

# --- 1. system packages ----------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  say "installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  if [ "$DB_MODE" = full ]; then
    apt-get install -y -qq git curl unzip ca-certificates postgresql postgresql-contrib
  else
    apt-get install -y -qq git curl unzip ca-certificates
  fi
fi

# --- 2. bun ----------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "installing bun"
  curl -fsSL https://bun.sh/install | bash
  # /root/.bun/bin is unreachable under systemd's ProtectHome, so put it where
  # the unit can always execute it.
  cp -f "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
BUN=$(command -v bun || echo /usr/local/bin/bun)
[ -x "$BUN" ] || die "bun not found after install"
export PATH="$(dirname "$BUN"):$PATH"
say "bun $($BUN --version)"
case "$($BUN --version)" in
  0.*|1.[0-3].*) die "Bun 1.4.0 or newer is required (this is $($BUN --version))" ;;
esac

# --- 3. source -------------------------------------------------------------
mkdir -p "$ROOT/data"
if [ ! -d "$REPO/.git" ]; then
  say "cloning $BRANCH"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO"
else
  say "updating $REPO"
  git -C "$REPO" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO" checkout --force "$BRANCH"
  git -C "$REPO" reset --hard "origin/$BRANCH"
fi
cd "$REPO"
say "at $(git log --oneline -1)"

# --- 4. database (full mode only) ------------------------------------------
DB_PASSWORD=""
if [ "$DB_MODE" = full ]; then
  systemctl enable --now postgresql >/dev/null 2>&1 || true
  # `su - postgres -c` prints the MOTD and swallows query output, so the
  # "already exists" path silently no-ops. runuser behaves.
  if ! runuser -u postgres -- psql -tAc \
       "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    DB_PASSWORD=$(openssl rand -hex 24)
    runuser -u postgres -- psql -c \
      "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
    say "created role $DB_USER"
  else
    say "role $DB_USER already exists"
  fi
  if ! runuser -u postgres -- psql -tAc \
       "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"
    say "created database $DB_NAME"
  else
    say "database $DB_NAME already exists"
  fi
fi

# --- 5. .env ---------------------------------------------------------------
set_kv() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ ! -f .env ]; then
  say "creating .env"
  cp .env.example .env
  chmod 600 .env
  ORIGIN=${DOMAIN:+https://$DOMAIN}
  set_kv NODE_ENV production
  set_kv CARTETHYIA_SOURCE_RUN "$SOURCE_RUN"
  set_kv LOG_LEVEL warn
  set_kv PORT "$PORT"
  set_kv DASHBOARD_DIST "$REPO/dist/dashboard"
  set_kv CARTETHYIA_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  set_kv CARTETHYIA_DATA_DIR "$ROOT/data"
  set_kv CARTETHYIA_TELEMETRY_PAYLOAD_DIR "$ROOT/data/telemetry-payloads"
  set_kv CARTETHYIA_INSTALL_ID_DIR "$ROOT/data/.cartethyia"
  # Only loopback may assert a client IP: the proxy hops over 127.0.0.1.
  set_kv TRUSTED_PROXY_CIDRS "127.0.0.1/32,::1/128"
  set_kv REDIS_MODE disabled
  if [ -n "$ORIGIN" ]; then set_kv CARTETHYIA_PUBLIC_ORIGIN "$ORIGIN"; fi

  if [ "$DB_MODE" = full ]; then
    set_kv CARTETHYIA_DB_MODE full
    if [ -z "$DB_PASSWORD" ]; then
      # Reusing an existing role means its password is not ours to know; ask.
      die "role $DB_USER exists but its password is unknown: set DATABASE_URL in $REPO/.env and re-run"
    fi
    set_kv DATABASE_URL "postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME"
  else
    set_kv CARTETHYIA_DB_MODE lite
  fi
else
  say ".env already exists, leaving it alone"
fi

# --- 6. install + build ----------------------------------------------------
say "bun install"
bun install --linker isolated --frozen-lockfile || die "bun install failed"

say "bun run dashboard:build"
bun run dashboard:build || die "dashboard build failed"

say "bun run build:aot + build:binary (slow on 1 vCPU)"
CARTETHYIA_SOURCE_RUN="$SOURCE_RUN" bun run build:aot || die "build:aot failed"
CARTETHYIA_SOURCE_RUN="$SOURCE_RUN" bun run build:binary --outfile "$REPO/dist/cartethyia" \
  || die "build:binary failed"

# --- 7. systemd -------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  say "installing systemd unit"
  cat > /etc/systemd/system/cartethyia.service <<EOF
[Unit]
Description=Cartethyia AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env
Environment=PATH=$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin
ExecStart=$REPO/dist/cartethyia
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cartethyia
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$ROOT/data $REPO/.env
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable cartethyia
  systemctl restart cartethyia
else
  say "no systemd; start it yourself: PORT=$PORT $REPO/dist/cartethyia"
fi

# --- 8. TLS: only on a regular VPS -----------------------------------------
if [ "$TOPOLOGY" = regular ] && [ "$WANT_CADDY" = 1 ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    say "installing caddy"
    # The Cloudsmith apt repo has repeatedly failed signature verification, so
    # use the release binary directly.
    ARCH=$(dpkg --print-architecture)
    curl -fsSL -o /tmp/caddy.tar.gz \
      "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_${ARCH}.tar.gz"
    tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
    install -m 0755 /tmp/caddy /usr/bin/caddy
    rm -f /tmp/caddy /tmp/caddy.tar.gz
  fi
  # A binary install creates neither of these.
  mkdir -p /etc/caddy /var/log/caddy /var/lib/caddy
  id -u caddy >/dev/null 2>&1 \
    || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
  chown -R caddy:caddy /var/lib/caddy /var/log/caddy

  if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
    say "writing Caddyfile for $DOMAIN"
    cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip

	reverse_proxy 127.0.0.1:$PORT {
		# Streaming must not be buffered.
		flush_interval -1
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	log {
		output file /var/log/caddy/cartethyia.log
	}
}
EOF
  else
    say "Caddyfile already references $DOMAIN, leaving it alone"
  fi

  cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy reverse proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
RestartSec=3
TimeoutStopSec=15
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now caddy
  say "caddy up; certificate status:"
  journalctl -u caddy --since '-1min' --no-pager \
    | grep -iE 'certificate obtained|challenge failed' || true
else
  say "NAT topology: your provider terminates TLS; not installing a proxy"
fi

# --- 9. health -------------------------------------------------------------
say "waiting for /health/ready on port $PORT"
healthy=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 3
done
if [ "$healthy" != 1 ]; then
  # Egress DNS is the usual cause of a deployment that boots but cannot reach
  # its upstreams, so surface it rather than letting the operator guess.
  say "checking egress DNS (a poisoned resolver looks like an app bug)"
  getent hosts www.codebuddy.ai || say "  (codebuddy unreachable — check /etc/resolv.conf)"
  die "service did not become healthy; check: journalctl -u cartethyia -n 50"
fi
say "healthy"

cat <<EOF

  Cartethyia installed ($TOPOLOGY, $DB_MODE).

    root    $ROOT
    commit  $(git log --oneline -1)
    env     $REPO/.env
    health  http://127.0.0.1:$PORT/health/ready
EOF

if [ "$TOPOLOGY" = regular ] && [ "$WANT_CADDY" = 1 ]; then
  echo "    public  https://$DOMAIN"
else
  echo "    public  via your provider's proxy"
fi

cat <<EOF

  Next: finish the first-boot wizard at /console, then enroll an account.
  Useful: journalctl -u cartethyia -f
EOF
