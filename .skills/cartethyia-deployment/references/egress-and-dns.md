# Egress and DNS — check before blaming the payload

A resolver that returns a wrong address produces failures that read exactly like
application bugs. This is the highest-value check on a fresh host and takes ten
seconds. Do it before theorising about headers, identity, or request shape.

## The failure it produces

Seen on a regular VPS (`160.250.227.21`): `www.codebuddy.ai` resolved to
`0.0.0.1`, so the gateway dialed `0.0.0.1:443` and reported

```
connect ECONNREFUSED 0.0.0.1:443
```

while other requests against the same provider surfaced as
`400 invalid_parameter_value (upstream 400)` and `14003 (upstream 429)`. Five
failures, three different-looking causes, one root cause. Nothing was wrong with
any request — the address was wrong.

## Diagnose

```bash
getent hosts <upstream-host>          # 0.0.0.1 or 127.0.0.1 means poisoned
nslookup <upstream-host> 1.1.1.1      # comparison against a public resolver
nslookup <upstream-host> 8.8.8.8
```

A disagreement between the local answer and the public resolvers means the
local resolver is lying. Poisoning is often selective: on the host above
`www.workbuddy.ai` resolved correctly while `www.codebuddy.ai` did not, so one
healthy lookup proves nothing.

## Fix permanently

Writing `/etc/resolv.conf` directly **does not survive** — `systemd-resolved`
rewrites it, and the symptom returns within minutes:

```bash
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/dns.conf <<'EOF'
[Resolve]
DNS=1.1.1.1 8.8.8.8
FallbackDNS=9.9.9.9
DNSStubListener=no
EOF
ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
systemctl restart systemd-resolved
```

Verify:

```bash
cat /etc/resolv.conf | grep nameserver
getent hosts <upstream-host>   # must now be the real address
```

**Restart the app afterwards.** A process that already resolved and cached the
bad answer keeps using it, so a DNS fix that appears not to work is usually just
a stale process.

## Rules of thumb

- `ECONNREFUSED` naming an address you did not configure is egress, not payload.
- A burst of unrelated `4xx` from one provider at once is usually egress, not
  payload. Real payload bugs are specific to a field, not to a host.
- `0.0.0.1` is not `127.0.0.1`. Do not read a `0.0.0.1` connection error as
  "the app is misconfigured to talk to itself".
- If a provider's own client fails from the same host, the contract is not yours
  to satisfy — see `cartethyia-remote-debugging` on varying the egress IP.

## Related: verifying HTTPS from Windows

Windows `curl`/schannel and some Git-Bash builds fail the handshake against
otherwise-healthy sites and print `000`. That is a client problem. Confirm with
a real TLS client:

```bash
python -c "import urllib.request;r=urllib.request.urlopen('https://<domain>/health',timeout=20);print(r.status,r.read()[:80])"
```

`000` from curl **plus** 200 from Python means the deployment is fine. Do not
report a host as unreachable on a single `000`.
