export type LocalPlatform = "windows" | "macos" | "linux" | "unknown";

/** Detects the host platform once so setup/doctor share identical labels. */
export function getLocalPlatform(): LocalPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

/**
 * Returns actionable hints for the configured local/external service.
 * These are hints only: setup never assumes Docker or silently mutates an
 * external service. Windows users commonly run PostgreSQL through Laragon;
 * Redis may be native, WSL-backed, or external.
 */
export function getOsHints(service: "postgres" | "redis"): string[] {
  const platform = getLocalPlatform();
  if (platform === "windows") {
    return service === "postgres"
      ? [
          "Windows / Laragon:",
          "  Start Laragon (Start All) and ensure PostgreSQL is enabled.",
          "  Verify PostgreSQL is listening on the DATABASE_URL host/port (usually 5432).",
          "  External PostgreSQL is also supported — keep DATABASE_URL unchanged and reachable.",
        ]
      : [
          "Windows / Redis:",
          "  Start Redis through WSL, a native Redis-compatible service, or an external host.",
          "  Verify Redis is listening on the REDIS_URL host/port (usually 6379).",
          "  Or omit REDIS_URL to use the in-memory backend.",
        ];
  }
  if (platform === "macos") {
    return service === "postgres"
      ? [
          "macOS / Homebrew:",
          "  brew services start postgresql@16 (or the installed PostgreSQL version).",
          "  External PostgreSQL is also supported — verify DATABASE_URL reachability.",
        ]
      : [
          "macOS / Redis:",
          "  brew services start redis, or use an external Redis instance.",
          "  Or omit REDIS_URL to use the in-memory backend.",
        ];
  }
  if (platform === "linux") {
    return service === "postgres"
      ? [
          "Linux / systemd:",
          "  sudo systemctl start postgresql (or the installed PostgreSQL service).",
          "  External PostgreSQL is also supported — verify DATABASE_URL reachability.",
        ]
      : [
          "Linux / Redis:",
          "  sudo systemctl start redis-server (or the installed Redis service).",
          "  Or omit REDIS_URL to use the in-memory backend.",
        ];
  }
  return [
    `${service} is not reachable on this platform.`,
    "Verify the configured service URL or use an external service.",
  ];
}
