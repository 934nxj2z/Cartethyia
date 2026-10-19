# Regular VPS

The VM holds the public IP on its own interface, so **you** install the reverse
proxy and it issues the certificate. There is no provider layer to negotiate
with, which makes this the simpler of the two bare-metal shapes.

Do the [shared provisioning](../references/shared-provisioning.md) first.

## 1. Point DNS at the VM before starting Caddy

ACME cannot issue unless the domain already resolves to this host. Confirm
**from the host**, not from your laptop:

```bash
getent hosts <domain>   # must equal the VM's public IP
```

## 2. Install Caddy

The Cloudsmith apt repo has repeatedly failed signature verification
(`NO_PUBKEY ABA1F9B8875A6661`), including via its own `setup.deb.sh`. On a
single box the release binary is more reliable:

```bash
ARCH=$(dpkg --print-architecture)
curl -fsSL -o /tmp/caddy.tar.gz \
  "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_${ARCH}.tar.gz"
tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
install -m 0755 /tmp/caddy /usr/bin/caddy
rm -f /tmp/caddy /tmp/caddy.tar.gz
caddy version
```

A binary install does **not** create `/etc/caddy` or the `caddy` user. Create
both before writing the Caddyfile, or the unit fails on a missing path:

```bash
mkdir -p /etc/caddy /var/log/caddy /var/lib/caddy
useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy
```

## 3. Caddyfile (`/etc/caddy/Caddyfile`)

```caddyfile
<domain> {
	encode zstd gzip

	reverse_proxy 127.0.0.1:8080 {
		# SSE / streaming must not be buffered.
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
```

No `local_certs` — ever. It replaces the public Let's Encrypt certificate with
a private one and is a NAT-VPS-only footgun; on a regular VPS it simply breaks
the site.

## 4. Caddy unit (`/etc/systemd/system/caddy.service`)

```ini
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
```

`AmbientCapabilities=CAP_NET_BIND_SERVICE` is what lets a non-root process bind
:80 and :443.

## 5. Start and verify issuance

```bash
systemctl daemon-reload && systemctl enable --now caddy
journalctl -u caddy --since '-2min' --no-pager | grep -iE 'certificate obtained|challenge failed'
```

Pass condition is `certificate obtained successfully`. Confirm the certificate
is public:

```bash
echo | openssl s_client -connect <domain>:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

`O=Let's Encrypt` is the pass condition. `Caddy Local Authority` means
`local_certs` is somehow set.

Then `https://<domain>/health` must return 200. See
[`verification.md`](verification.md) for why that alone is not proof.

## Verified instance

`160.250.227.21` → `https://dev-cartethyia.risun.web.id`. Ubuntu 24.04.5,
1 CPU / 1919 MB RAM. Bun 1.4.3, PostgreSQL 16, Caddy 2.9.1. Let's Encrypt
issued on first start; real upstream dispatch returned 200.

The egress resolver on this host was poisoned
(`www.codebuddy.ai` → `0.0.0.1`). Check
[`egress-and-dns.md`](egress-and-dns.md) before dispatching anything.
