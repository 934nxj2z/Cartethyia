# syntax=docker/dockerfile:1.7
# Alpine is the default to keep the image small. The builder uses the same musl
# family so the standalone binary matches the runtime libc.
# To use the previous Debian slim setup, replace the builder with a pinned
# `oven/bun:debian` and runtime with `debian:bookworm-slim`, then
# replace apk/user commands with apt equivalents. Verify native modules and tools.
#
# Railway additions are marked `# Railway:` — everything else is upstream.

# Pinned to the version in .bun-version: `bun install --frozen-lockfile` relies
# on the lockfile semantics that produced bun.lock.
# Railway: pin instead of `alpine`, so a deploy is reproducible.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-alpine AS builder

WORKDIR /build

# Dependency layer: source changes do not invalidate Bun installation.
COPY package.json bun.lock tsconfig.json ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile --linker isolated

# Copy source contracts before dashboard typecheck: dashboard mirrors several
# backend types from src/ and cannot build against dashboard alone.
COPY src ./src
COPY dashboard ./dashboard
RUN bun run dashboard:build

# Railway: boot fallback for a deploy that builds this repo alone. Railway's
# railway.json cannot declare variables, so without this the container would
# start with no CARTETHYIA_ENCRYPTION_KEY.
#
# No wildcard: a glob would succeed while copying nothing, and the failure would
# only surface later as a missing /build/.env.railway in the runtime stage. The
# matching `.dockerignore` negation keeps the file in the build context.
COPY .env.railway ./
RUN test -f /build/.env.railway

# Backend build layer: AOT output is required before standalone compilation.
COPY scripts ./scripts
COPY migrations ./migrations
RUN test -f migrations/full-postgres/0000_baseline.sql \
    && test -f migrations/lite-sqlite3/0000_baseline.sql \
    && test -f migrations/full-postgres/0001_allow_multiple_shared_keys_per_ip.sql \
    && test -f migrations/lite-sqlite3/0001_allow_multiple_shared_keys_per_ip.sql
RUN bun run build:aot && bun run build:binary --outfile /build/dist/cartethyia

# Runtime: only the binary, dashboard assets, migrations, and entrypoint ship.
# Railway: pin the same way as the builder.
FROM alpine:3.22

WORKDIR /app

# curl powers HEALTHCHECK; util-linux provides setpriv for non-root startup.
# Railway: `su-exec` replaces util-linux's setpriv — one ~10 kB binary instead of
# the multi-package install, and the entrypoint below is written for it.
RUN apk add --no-cache ca-certificates curl libgcc libstdc++ su-exec \
    && addgroup -S -g 10001 cartethyia \
    && adduser -S -D -H -u 10001 -G cartethyia cartethyia \
    && mkdir -p /app/data \
    && chown -R cartethyia:cartethyia /app

COPY --from=builder --chown=cartethyia:cartethyia /build/migrations ./migrations
RUN test -f /app/migrations/full-postgres/0000_baseline.sql \
    && test -f /app/migrations/lite-sqlite3/0000_baseline.sql \
    && test -f /app/migrations/full-postgres/0001_allow_multiple_shared_keys_per_ip.sql \
    && test -f /app/migrations/lite-sqlite3/0001_allow_multiple_shared_keys_per_ip.sql
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/dashboard ./dist/dashboard
COPY --chmod=755 docker-entrypoint.sh ./entrypoint.sh
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/cartethyia ./cartethyia

# Railway: `.env.railway` becomes the boot fallback the entrypoint reads under
# the real environment. It holds no secret; its key is a placeholder.
COPY --from=builder --chown=cartethyia:cartethyia /build/.env.railway /app/.env.runtime

# Railway: PORT is a literal so the listener always matches EXPOSE, and the
# telemetry payload directory is placed on the volume (upstream keeps the
# relative default, which lands in the container's writable layer and is lost on
# redeploy).
ENV PORT=12800 \
    NODE_ENV=production \
    DASHBOARD_DIST=/app/dist/dashboard \
    CARTETHYIA_PACKAGE_ROOT=/app \
    CARTETHYIA_DATA_DIR=/app/data \
    CARTETHYIA_INSTALL_ID_DIR=/app/data/.cartethyia \
    CARTETHYIA_TELEMETRY_PAYLOAD_DIR=/app/data/telemetry-payloads

EXPOSE 12800
STOPSIGNAL SIGTERM

# Railway: a longer start period — the first boot runs migrations against a
# freshly provisioned volume before /health/ready can answer.
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-12800}/health/ready" || exit 1

# Start as root so mounted data ownership can be repaired, then drop to uid 10001.
ENTRYPOINT ["/app/entrypoint.sh"]
# Railway: absolute path, so the working directory does not matter.
CMD ["/app/cartethyia"]
