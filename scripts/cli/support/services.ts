/**
 * TCP reachability checks for the services setup and doctor ask about.
 *
 * These are extracted from the env helpers so the dotenv reader and the probe
 * stay independent: doctor can be imported without pulling in `.env` parsing.
 */

export interface ProbeResult {
  success: boolean;
  error?: string;
}

/**
 * Opens a TCP connection to `host:port` and resolves once it connects, errors,
 * or the timeout elapses. The socket is always closed so a probe never leaves a
 * half-open connection behind.
 */
export async function probeTcpService(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const { promise, resolve } = Promise.withResolvers<ProbeResult>();

  const timeoutHandle = setTimeout(() => {
    resolve({ success: false, error: "timeout" });
  }, timeoutMs);

  Bun.connect({
    hostname: host,
    port: port,
    socket: {
      open: () => {
        clearTimeout(timeoutHandle);
        resolve({ success: true });
      },
      data: () => {},
      error: (err) => {
        clearTimeout(timeoutHandle);
        resolve({ success: false, error: String(err) });
      },
    },
  })
    .then((socket) => {
      socket.end();
    })
    .catch((err) => {
      clearTimeout(timeoutHandle);
      resolve({ success: false, error: String(err) });
    });

  return promise;
}

/**
 * Local PostgreSQL ports worth probing before asking for a URL. 5432 is the
 * server default (Laragon, Homebrew, systemd); 5433 is the usual second
 * instance when 5432 is already taken.
 */
export const LOCAL_POSTGRES_CANDIDATES = [
  { host: "127.0.0.1", port: 5432 },
  { host: "127.0.0.1", port: 5433 },
] as const;

/** First local PostgreSQL that accepts a TCP connection, or null. */
export async function detectLocalPostgres(
  timeoutMs: number,
): Promise<{ host: string; port: number } | null> {
  for (const candidate of LOCAL_POSTGRES_CANDIDATES) {
    const probe = await probeTcpService(candidate.host, candidate.port, timeoutMs);
    if (probe.success) return candidate;
  }
  return null;
}

/**
 * Parses a service URL and requires an explicit host and port.
 * Returns null if the URL is invalid or incomplete.
 */
export function parseServiceUrl(url: string): { host: string; port: number } | null {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname || !urlObj.port) return null;
    return { host: urlObj.hostname, port: Number(urlObj.port) };
  } catch {
    return null;
  }
}
