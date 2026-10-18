import { expect, test } from "bun:test";
import { applySqliteMigrations, createSqliteDatabase } from "../../src/persistence/db-sqlite";

test("the baseline has the final network-pool schema", async () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('tenant-1', 'A', 'active')");
    sqlite.exec(
      `INSERT INTO network_pools (id, kind, endpoint_config, tenant_id)
       VALUES ('pool-1', 'https', '{}', 'tenant-1')`,
    );
    expect(() =>
      sqlite.exec(
        `INSERT INTO network_pools (id, kind, endpoint_config, tenant_id)
         VALUES ('pool-2', 'bridge', '{}', 'tenant-1')`,
      ),
    ).toThrow();

    const columns = sqlite.query("PRAGMA table_info('network_pools')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "family",
        "last_error_at",
        "last_health_check_at",
        "egress_ip",
        "quota_bytes",
        "last_speedtest_bytes",
        "last_speedtest_duration_ms",
        "last_speedtest_status",
        "last_speedtest_error",
        "last_speedtest_at",
        "bytes_sent_total",
        "bytes_received_total",
        "provider_probe_status",
        "provider_probe_endpoint",
      ]),
    );

    sqlite.exec("INSERT INTO providers (id) VALUES ('openai')");
    sqlite.exec("INSERT INTO provider_routing_settings (provider_id) VALUES ('openai')");
    const routing = sqlite
      .query("SELECT user_agent FROM provider_routing_settings WHERE provider_id = 'openai'")
      .get() as { user_agent: string };
    expect(routing.user_agent).toBe("claude-cli/2.1.293 (external, cli)");
  } finally {
    sqlite.close();
  }
});
