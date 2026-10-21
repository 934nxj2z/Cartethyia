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
# Placeholder values are recorded as MISSING instead of being exported. Those are
# either unresolved `${{...}}` expressions or the repository's own
# `replace-with-` default. Exporting them would resolve to "set but wrong" and
# defeat the app's fail-fast checks — on a public URL, a known encryption key is
# worse than no boot at all.
ENV_FALLBACK_FILE="/app/.env.runtime"
MISSING_VARS=""
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
    value_trimmed="$(printf '%s' "$value" | tr -d '[:space:]')"
    [ -n "$value_trimmed" ] || continue
    # Bare `${{` is the literal Railway template marker quoted on purpose.
    # The prefix match is narrow: a placeholder's tail is random hex, but a real
    # key is 64 hex chars, which can legitimately contain any word-shaped
    # substring (e.g. "abcdef0").
    # shellcheck disable=SC2016
    case "$value" in
      *'${{'* | replace-with-*)
        MISSING_VARS="${MISSING_VARS}${MISSING_VARS:+, }${key}"
        continue
        ;;
    esac
    if [ -z "$(printenv "$key" 2> /dev/null)" ]; then
      export "$key=$value"
    fi
  done < "$ENV_FALLBACK_FILE"
fi

if [ -n "$MISSING_VARS" ]; then
  echo "cartethyia: these variables have no value and no usable fallback: ${MISSING_VARS}" >&2
  echo "cartethyia: set them as Railway service variables and give the service a public domain" >&2
  echo "cartethyia: (CARTETHYIA_PUBLIC_ORIGIN), or deploy through the template, which supplies them." >&2
  echo "cartethyia: refusing to start with a placeholder key." >&2
  exit 1
fi

# A mounted volume arrives owned by root, while the application runs as 10001.
# The image deliberately does not set USER, so the entrypoint starts as root,
# repairs the ownership of the data directories, and then drops privileges —
# otherwise the lite database cannot write and every telemetry payload capture
# fails while the console still reports capture as enabled.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE_DIR" "$PAYLOAD_DIR" ${CONFIG_DIR:+"$CONFIG_DIR"} 2> /dev/null || true
  chown -R "$APP_UID:$APP_GID" "$STATE_DIR" "$PAYLOAD_DIR" ${CONFIG_DIR:+"$CONFIG_DIR"} 2> /dev/null || true
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
