#!/bin/sh
# Cartethyia container entrypoint
# Fixes the data directories' ownership, then executes the application as the
# unprivileged runtime identity.
#
# Railway additions are marked `# Railway:` — everything else is upstream.

set -e

APP_USER="${APP_USER:-cartethyia}"
APP_UID="$(id -u "$APP_USER" 2> /dev/null || echo 10001)"
APP_GID="$(id -g "$APP_USER" 2> /dev/null || echo 10001)"

# Gateway-owned state (lite database, install id) plus telemetry payload
# captures. Both default under /app/data; a relative payload dir is resolved
# against /app so it stays inside the volume.
STATE_DIR="${CARTETHYIA_DATA_DIR:-/app/data}"
case "$STATE_DIR" in /*) ;; *) STATE_DIR="/app/data" ;; esac
PAYLOAD_DIR="${CARTETHYIA_TELEMETRY_PAYLOAD_DIR:-/app/data}"
case "$PAYLOAD_DIR" in
  /*) ;;
  *) PAYLOAD_DIR="/app/$PAYLOAD_DIR" ;;
esac
CONFIG_DIR="${CARTETHYIA_CONFIG_DIR:-}"
if [ -n "$CONFIG_DIR" ]; then
  case "$CONFIG_DIR" in /*) ;; *) CONFIG_DIR="/app/$CONFIG_DIR" ;; esac
fi

# Railway: boot fallback. railway.json cannot declare variables, so a deploy
# that builds this repo alone relies on /app/.env.runtime (copied from
# .env.railway by the Dockerfile). A real service variable always wins: this
# only fills what the process environment left empty.
#
# Railway never evaluates `${{...}}` inside this file — it is plain text read
# here, not a Railway variable — so `.env.railway` carries no expressions. The
# two values that genuinely need computing are handled below.
ENV_FALLBACK_FILE="/app/.env.runtime"
if [ -f "$ENV_FALLBACK_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*)
        continue
        ;;
    esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    # An empty value means "not set here", which is how the file leaves the
    # generated key and the derived origin for the steps below.
    value_trimmed="$(printf '%s' "$value" | tr -d '[:space:]')"
    [ -n "$value_trimmed" ] || continue
    # A leftover `${{...}}` expression would reach the app verbatim and is never
    # a usable value; skip it rather than exporting it.
    # shellcheck disable=SC2016
    case "$value" in *'${{'*) continue ;; esac
    if [ -z "$(printenv "$key" 2> /dev/null)" ]; then
      export "$key=$value"
    fi
  done < "$ENV_FALLBACK_FILE"
fi

# A mounted volume arrives owned by root, while the application runs as 10001.
# The image deliberately does not set USER, so the entrypoint starts as root,
# repairs the ownership of the data directories, and then drops privileges —
# otherwise the lite database cannot write and every telemetry payload capture
# fails while the console still reports capture as enabled.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE_DIR" "$PAYLOAD_DIR" ${CONFIG_DIR:+"$CONFIG_DIR"} 2> /dev/null || true
  chown -R "$APP_UID:$APP_GID" "$STATE_DIR" "$PAYLOAD_DIR" ${CONFIG_DIR:+"$CONFIG_DIR"} 2> /dev/null || true
else
  # Not root: the mount cannot be repaired, but the directories still have to
  # exist before the key file can be written into them.
  mkdir -p "$STATE_DIR" "$PAYLOAD_DIR" ${CONFIG_DIR:+"$CONFIG_DIR"} 2> /dev/null || true
fi

# Railway: derive the public origin from the Railway-provided domain.
#
# RAILWAY_PUBLIC_DOMAIN is a bare hostname ("example.up.railway.app"); the app
# needs a scheme, and it only exists once the service has a domain. The gateway
# reads this lazily — only OAuth callback URLs need it — so a missing domain
# does not block boot. An explicit CARTETHYIA_PUBLIC_ORIGIN always wins.
if [ -z "$(printenv CARTETHYIA_PUBLIC_ORIGIN 2> /dev/null)" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export CARTETHYIA_PUBLIC_ORIGIN="https://${RAILWAY_PUBLIC_DOMAIN}"
  echo "cartethyia: public origin derived from RAILWAY_PUBLIC_DOMAIN: ${CARTETHYIA_PUBLIC_ORIGIN}" >&2
elif [ -z "$(printenv CARTETHYIA_PUBLIC_ORIGIN 2> /dev/null)" ]; then
  echo "cartethyia: no public domain yet, so CARTETHYIA_PUBLIC_ORIGIN is unset." >&2
  echo "cartethyia: the gateway and /console work; provider OAuth callbacks will fail" >&2
  echo "cartethyia: until the service has a domain (Settings -> Networking -> Generate Domain)." >&2
fi

# Railway: the encryption key.
#
# CARTETHYIA_ENCRYPTION_KEY must never come from this repository, which is
# public. When neither a service variable nor a usable value is present, a random
# 256-bit key is generated once and stored on the volume, so redeploys reuse it
# and previously stored credentials stay readable. Losing the volume, or setting
# a different key, makes every stored provider credential and API key unreadable
# — the same consequence as rotating a key by hand.
KEY_FILE="${STATE_DIR}/.encryption-key"
if [ -z "$(printenv CARTETHYIA_ENCRYPTION_KEY 2> /dev/null)" ]; then
  if [ -s "$KEY_FILE" ]; then
    stored_key="$(tr -d '[:space:]' < "$KEY_FILE")"
    if [ "${#stored_key}" -ne 64 ]; then
      echo "cartethyia: ${KEY_FILE} does not hold a 64-character hex key." >&2
      echo "cartethyia: set CARTETHYIA_ENCRYPTION_KEY as a service variable instead" >&2
      echo "cartethyia: (openssl rand -hex 32), or restore the volume backup." >&2
      exit 1
    fi
    export CARTETHYIA_ENCRYPTION_KEY="$stored_key"
    echo "cartethyia: using the generated encryption key from ${KEY_FILE}" >&2
  else
    generated_key="$(od -An -N32 -tx1 /dev/urandom 2> /dev/null | tr -d ' \n')"
    if [ "${#generated_key}" -eq 64 ]; then
      if printf '%s\n' "$generated_key" > "$KEY_FILE" 2> /dev/null; then
        chmod 600 "$KEY_FILE" 2> /dev/null || true
        chown "$APP_UID:$APP_GID" "$KEY_FILE" 2> /dev/null || true
        export CARTETHYIA_ENCRYPTION_KEY="$generated_key"
        echo "cartethyia: generated a new encryption key and stored it in ${KEY_FILE}" >&2
        echo "cartethyia: back up this volume — the file is required to read stored credentials." >&2
      else
        echo "cartethyia: could not write ${KEY_FILE}." >&2
        echo "cartethyia: mount a volume at ${STATE_DIR}, or set CARTETHYIA_ENCRYPTION_KEY" >&2
        echo "cartethyia: as a service variable. Refusing to start without a key." >&2
        exit 1
      fi
    else
      echo "cartethyia: could not generate a secure key (od unavailable?)." >&2
      echo "cartethyia: set CARTETHYIA_ENCRYPTION_KEY as a service variable: openssl rand -hex 32" >&2
      exit 1
    fi
  fi
fi

if [ "$(id -u)" = "0" ]; then
  # Railway: su-exec replaces upstream's setpriv (see the Dockerfile).
  exec su-exec "$APP_UID:$APP_GID" "$@"
fi

# Started unprivileged (the operator pinned a user, or the platform forbids
# root): nothing can be repaired from here, so report the exact ownership the
# host directory needs.
if [ ! -w "$STATE_DIR" ]; then
  echo "cartethyia: $STATE_DIR is not writable by uid $(id -u); the lite database cannot start here." >&2
  echo "cartethyia: chown it to $APP_UID:$APP_GID on the host, or let the entrypoint start as root so it can fix the mount." >&2
fi
if [ ! -w "$PAYLOAD_DIR" ]; then
  echo "cartethyia: $PAYLOAD_DIR is not writable by uid $(id -u); telemetry payload capture will fail." >&2
fi

exec "$@"
