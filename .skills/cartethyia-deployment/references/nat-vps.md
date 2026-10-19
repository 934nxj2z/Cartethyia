# NAT VPS (provider-managed Caddy)

A "NAT VPS" (Dahono Cloud, Narwhal, and similar cheap Indonesian/Chinese hosts)
is an LXC container on a **private** address with a limited set of public ports
forwarded by the host. The public IP is the host's, not yours.

Providers like this advertise "Caddy Auto-SSL & subdomain gratis". That means a
Caddy already occupies `:80`/`:443` **and terminates TLS for you**.

Do the [shared provisioning](../references/shared-provisioning.md) first.

## 1. Confirm which ports actually reach you

Probe **from outside** — inside the VM everything binds fine and tells you
nothing:

```bash
for p in 22 80 443 8080; do timeout 6 bash -c "echo > /dev/tcp/<PUBLIC_IP>/$p" 2>/dev/null \
  && echo "$p OPEN" || echo "$p CLOSED"; done
```

Corroborate by binding a throwaway listener inside and probing from outside. A
port can bind locally yet be unreachable, so the outside probe is the only
answer that counts.

SSH is usually on a non-standard port (e.g. `:45222`) precisely because :22 is
not forwarded.

## 2. The three rules that cost the most time

- **Do not install a second reverse proxy.** You will fight the provider's for
  the ports.
- **Do not set `local_certs`.** It swaps the public certificate for a private
  one; the browser then rejects the site and ACME never issues. The symptom is
  `https=000` from outside while `openssl s_client` shows a cert issued by
  `Caddy Local Authority`. This is the single most expensive mistake in this
  setup.
- **Do not disable the 80→443 redirect** to "fix" an ACME challenge. If :443 is
  forwarded, tls-alpn-01 and http-01 both work; suppressing the redirect just
  breaks the site for users.

## 3. Caddyfile

The provider's Caddy does the TLS work; yours only needs the proxy hop:

```caddyfile
<domain> {
	encode zstd gzip

	reverse_proxy 127.0.0.1:8080 {
		# SSE / streaming must not be buffered.
		flush_interval -1
	}
}
```

## 4. Bind the app to loopback

Once a proxy fronts it, the app should listen on `127.0.0.1:<port>`. Exposing
`0.0.0.0:8080` adds nothing — that port is not forwarded anyway — and it invites
direct plaintext access if it ever is.

## 5. Verify issuance

```bash
journalctl -u caddy --since '-2min' --no-pager | grep -iE 'certificate obtained|challenge failed'
echo | openssl s_client -connect <domain>:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

`issuer=... O=Let's Encrypt` is the pass condition. `Caddy Local Authority`
means `local_certs` is still set.

## 6. Do not import regular-VPS assumptions

No `local_certs` guard is needed on a regular VPS, and no port-forwarding
probing is needed there either. Conversely, never assume a NAT host's :80/:443
are yours to bind.

## Verified instance

`143.20.199.50`, ssh on `:45222` (Dahono Cloud) →
`https://cartethyia.risun.web.id`, real Let's Encrypt certificate.
