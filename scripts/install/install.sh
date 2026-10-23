#!/usr/bin/env bash
# Unified Cartethyia installer.
# Flags:
#   --mode lite|full          (default: interactive)
#   --topology regular|nat    (default: auto-detect)
#   --domain <fqdn>
#   --port <n>
#   --non-interactive
#   --skip <step,...>         comma list: packages,bun,postgres,redis,node,npm,caddy,env,start
set -euo pipefail

MODE=""; TOPOLOGY=""; DOMAIN=""; PORT="12800"; NONINTERACTIVE=0; SKIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --topology) TOPOLOGY="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --non-interactive) NONINTERACTIVE=1; shift;;
    --skip) SKIP="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done

skip() { echo ",$SKIP," | grep -q ",$1,"; }

prompt() { # prompt "label" default
  if [ "$NONINTERACTIVE" = "1" ]; then echo "$2"; return; fi
  read -rp "$1 [$2]: " v; echo "${v:-$2}"
}

# interactive mode/topology
if [ -z "$MODE" ]; then
  MODE=$(prompt "Mode (lite/full)" "full")
fi
if [ -z "$TOPOLOGY" ]; then
  # auto-detect
  VM_IP=$(ip -4 addr show scope global | grep -oE 'inet [0-9.]+' | head -1 | awk '{print $2}')
  EGRESS=$(python3 -c "import urllib.request;print(urllib.request.urlopen('https://api.ipify.org',timeout=8).read().decode())" 2>/dev/null || echo "")
  if [ "$VM_IP" = "$EGRESS" ]; then TOPOLOGY="regular"; else TOPOLOGY="nat"; fi
  TOPOLOGY=$(prompt "Topology (regular/nat)" "$TOPOLOGY")
fi
if [ -z "$DOMAIN" ]; then
  DOMAIN=$(prompt "Domain" "cartethyia.risun.web.id")
fi

echo "==> mode=$MODE topology=$TOPOLOGY domain=$DOMAIN port=$PORT"

# packages
if ! skip packages; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y git curl unzip ca-certificates openssl
  [ "$MODE" = "full" ] && apt-get install -y postgresql postgresql-contrib redis-server
fi

# bun
if ! skip bun && ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  cp -f /root/.bun/bin/bun /usr/local/bin/bun
fi

# node/npm
if ! skip node; then
  command -v node >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; apt-get install -y nodejs npm; }
fi

# postgres
if [ "$MODE" = "full" ] && ! skip postgres; then
  systemctl enable --now postgresql
  PG_PASS="${PG_PASS:-$(openssl rand -hex 16)}"
  runuser -u postgres -- psql -c "CREATE ROLE cartethyia LOGIN PASSWORD '$PG_PASS'" 2>/dev/null || true
  runuser -u postgres -- createdb -O cartethyia cartethyia 2>/dev/null || true
fi

# redis
if [ "$MODE" = "full" ] && ! skip redis; then
  systemctl enable --now redis-server
fi

# npm cartethyia
if ! skip npm; then
  npm install --global cartethyia
fi

# env
if ! skip env; then
  ENC_KEY="${ENC_KEY:-$(openssl rand -hex 32)}"
  mkdir -p /root/.config/Cartethyia /root/.local/share/Cartethyia/data
  {
    echo "CARTETHYIA_DB_MODE=$MODE"
    echo "PORT=$PORT"
    echo "NODE_ENV=production"
    echo "DASHBOARD_DIST=/usr/local/lib/node_modules/cartethyia/dist/dashboard"
    echo "LOG_LEVEL=warn"
    echo "CARTETHYIA_ENCRYPTION_KEY=$ENC_KEY"
    echo "CARTETHYIA_PUBLIC_ORIGIN=https://$DOMAIN"
    if [ "$MODE" = "full" ]; then
      echo "DATABASE_URL=postgres://cartethyia:${PG_PASS}@127.0.0.1:5432/cartethyia"
      echo "REDIS_URL=redis://localhost:6379"
    fi
    echo "CARTETHYIA_DATA_DIR=/root/.local/share/Cartethyia/data"
  } > /root/.config/Cartethyia/.env
  chmod 600 /root/.config/Cartethyia/.env
fi

# caddy (regular only)
if [ "$TOPOLOGY" = "regular" ] && ! skip caddy; then
  ARCH=$(dpkg --print-architecture)
  curl -fsSL -o /tmp/caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_${ARCH}.tar.gz"
  tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
  install -m 0755 /tmp/caddy /usr/bin/caddy
  rm -f /tmp/caddy /tmp/caddy.tar.gz
  mkdir -p /etc/caddy /var/log/caddy /var/lib/caddy
  useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  chown -R caddy:caddy /var/lib/caddy /var/log/caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
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
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now caddy
fi

# start
if ! skip start; then
  pkill -f "cartethyia start" 2>/dev/null || true
  nohup cartethyia start > /tmp/cartethyia.log 2>&1 &
  sleep 6
  curl -s "http://127.0.0.1:$PORT/health/ready" || true
  echo
fi

echo "==> done: https://$DOMAIN  (topology=$TOPOLOGY mode=$MODE)"
echo "    first-boot wizard: https://$DOMAIN/console"
