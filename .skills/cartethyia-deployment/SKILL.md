---
name: cartethyia-deployment
description: "Deploy Cartethyia to a server: regular VPS or NAT VPS. Use when provisioning a fresh host, when a domain resolves but HTTPS fails, when :80/:443 or the app port behave unexpectedly, or when a deployed instance cannot reach its upstreams."
---

# Deploying Cartethyia

Two deployment shapes, and every question starts the same way: **what is the
topology?** They differ in who owns the public IP and who terminates TLS.
Guessing wrong first is what turns a 20-minute deploy into an afternoon.

This file routes only. Do the identification below, then read the reference for
your shape.

## Step 1 — identify the topology

Never assume the VM owns the public IP:

```bash
# Inside the VM: what address does it actually hold?
ip -4 addr show scope global | grep inet
ip route | head -3
# What egress address does the world see?
python3 -c "import urllib.request;print(urllib.request.urlopen('https://api.ipify.org',timeout=8).read().decode())"
```

- VM holds the **same** address as egress → **regular VPS**. You own :80/:443.
- VM holds `10.x` / `192.168.x` / `100.x` but egress is public → **NAT VPS**.
  The public IP belongs to the host, not the VM.

Corroborate with what is already installed. A Caddy you did not install (typical
on Dahono Cloud, Narwhal) means NAT:

```bash
systemctl list-unit-files | grep -i caddy; systemctl is-active caddy
```

Which ports actually reach you must be probed **from outside** — from inside the
VM everything binds fine and tells you nothing.

## Step 2 — read the reference for your shape

| Shape | Public IP | Who terminates TLS | Reference |
|---|---|---|---|
| Regular VPS | on the VM itself | **you** — you install Caddy | [`references/regular-vps.md`](references/regular-vps.md) |
| NAT VPS | the host's, ports forwarded | **the provider** — already running | [`references/nat-vps.md`](references/nat-vps.md) |

Supporting references, independent of shape:

| Concern | Reference |
|---|---|
| Packages, Postgres, env file, systemd unit, first boot | [`references/shared-provisioning.md`](references/shared-provisioning.md) |
| Egress and DNS — **read this before blaming a payload** | [`references/egress-and-dns.md`](references/egress-and-dns.md) |
| Host and runtime gotchas | [`references/gotchas.md`](references/gotchas.md) |
| Proving a deployment, enrolling accounts | [`references/verification.md`](references/verification.md) |
| One-shot install script | [`references/install-script.md`](references/install-script.md) |

## Order of work

1. Identify the topology (Step 1).
2. Prefer [`scripts/install/vps.sh`](../../../scripts/install/vps.sh) — it does
   steps 3–5 and is idempotent. Read the manual references when it fails, or
   when you need to change something it does not cover.
3. [`shared-provisioning.md`](references/shared-provisioning.md) — what the
   script does, step by step.
4. The shape reference — TLS ownership is the only real difference.
5. [`egress-and-dns.md`](references/egress-and-dns.md) — before any upstream
   dispatch.
6. [`verification.md`](references/verification.md) — prove it with a real request.

## Non-negotiables

- Secrets are generated **on the host** and never reused from another
  deployment or a pasted env file. `.env` is mode `0600`. Nothing reaches git:
  no source file, env file, commit, diff, log, or report.
- Do not copy NAT workarounds onto a regular VPS (`local_certs`, port-forwarding
  assumptions) or vice versa.
- Patch the repository, not the installed tree. A hot patch under
  `/opt/cartethyia` is lost on the next clone and lets the server drift from the
  tag it claims to run.
