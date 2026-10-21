import { Eye, Shield, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select } from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { Switch } from "../../components/ui/switch";
import { Banner } from "../../components/patterns/banner";
import { BackupPanel } from "../../components/BackupPanel";
import { toast } from "../../lib/toast";
import { useChangePassword } from "../../hooks/auth";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../../hooks/settings";
import { getErrorMessage } from "../../data/api";


function PrivacyPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending) return <LoadingState label="Loading privacy settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load runtime settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }


  return (
    <Card className="h-full">
      <CardHeader
        title="Privacy"
        subtitle="What request telemetry stores, and how client addresses are shown"
        icon={<Eye size={16} />}
      />
      <CardBody>
        <Stack gap="16px">
          <div className="settings-field">
            <Select
              label="Telemetry payloads"
              id="privacy-payloads"
              value={settings.telemetryPayloads}
              onValueChange={(value) =>
                mutation.mutate(
                  { telemetryPayloads: value === "full" || value === "metadata" ? value : "none" },
                  {
                    onSuccess: () => toast.success("Payload capture updated"),
                    onError: (error) => toast.error(getErrorMessage(error, "Could not update payload capture.")),
                  },
                )
              }
              options={[
                { value: "none", label: "Off — no payload capture" },
                { value: "metadata", label: "Metadata — method and headers, 15 minutes" },
                { value: "full", label: "Full — redacted bodies, 15 minutes" },
              ]}
            />
            <p className="mt-1 text-badge text-text-tertiary">
              Request metadata is always kept. Bodies stay off until you turn them on, and anything captured is redacted and deleted after 15 minutes.
            </p>
          </div>
          {settings.telemetryPayloads === "full" ? (
            <div className="settings-field">
              <Select
                label="Capture depth"
                id="privacy-payload-depth"
                value={settings.telemetryPayloadDepth}
                onValueChange={(value) =>
                  mutation.mutate(
                    { telemetryPayloadDepth: value === "moderate" || value === "maximum" ? value : "minimum" },
                    {
                      onSuccess: () => toast.success("Capture depth updated"),
                      onError: (error) => toast.error(getErrorMessage(error, "Could not update capture depth.")),
                    },
                  )
                }
                options={[
                  { value: "minimum", label: "Minimum — 1 MiB cap" },
                  { value: "moderate", label: "Moderate — 8 MiB cap" },
                  { value: "maximum", label: "Maximum — 16 MiB cap" },
                ]}
              />
              {settings.telemetryPayloadDepth !== "minimum" ? (
                <Banner tone="warning" surface="raised" className="text-text-secondary">
                  <strong>High CPU and memory while this is on.</strong> Use it to debug, then switch back to Metadata or Minimum.
                </Banner>
              ) : null}
            </div>
          ) : null}
          <div className="settings-field">
            <Select
              label="Client IP display"
              id="privacy-ip"
              value={settings.privacyMode}
              onValueChange={(value) =>
                mutation.mutate(
                  { privacyMode: value === "full" ? "full" : "masked" },
                  {
                    onSuccess: () => toast.success("IP display updated"),
                    onError: (error) => toast.error(getErrorMessage(error, "Could not update IP display.")),
                  },
                )
              }
              options={[
                { value: "masked", label: "Masked — recommended" },
                { value: "full", label: "Show full IP" },
              ]}
            />
            <p className="mt-1 text-badge text-text-tertiary">Raw addresses stay stored. This only changes how they are shown.</p>
          </div>
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * Operational overrides that used to be deployment-only env vars.
 *
 * These are the knobs an operator reaches for while an install is running — a
 * provider misbehaving, a timeout that no longer fits — so they are editable
 * per tenant and take effect without a restart. Each one says plainly what it
 * costs, because the defaults exist for a reason.
 */
function OperationalPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending) return <LoadingState label="Loading operational settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load runtime settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const save = (patch: Parameters<typeof mutation.mutate>[0], message: string): void => {
    mutation.mutate(patch, {
      onSuccess: () => toast.success(message),
      onError: (error) => toast.error(getErrorMessage(error, "Could not update settings.")),
    });
  };

  return (
    <Card className="h-full">
      <CardHeader
        title="Operations"
        subtitle="Routing, timeouts, and telemetry retention for this tenant"
        icon={<Zap size={16} />}
      />
      <CardBody className="flex flex-1 flex-col">
        <Stack gap="14px" className="flex-1">
          <div className="flex items-center justify-between gap-6 rounded-control border border-inner-border px-6 py-5">
            <span className="min-w-0">
              <strong className="block text-body">Force disable cooldown</strong>
              <small className="text-badge text-text-tertiary">
                Route to accounts that are cooling down, including ones already parked.
              </small>
            </span>
            <Switch
              checked={settings.forceDisableCooldown}
              onChange={(next) =>
                save({ forceDisableCooldown: next }, next ? "Cooldowns will be ignored." : "Cooldowns are enforced again.")
              }
              aria-label="Force disable cooldown"
            />
          </div>
          {settings.forceDisableCooldown ? (
            <Banner tone="warning" surface="raised" live="status">
              <strong>This may cause admission failure.</strong> A cooled-down account was parked
              because the upstream refused it, so dialing it anyway reproduces that refusal on every
              attempt — and if every candidate is cooling, the request fails instead of waiting for a
              reset. The cooldown is still recorded and still recovered by the sweep, so turning this
              back off needs no cleanup. Per-model cooldowns are still enforced.
            </Banner>
          ) : null}

          <div className="settings-field">
            <Input
              label="Upstream timeout (seconds)"
              id="upstream-timeout"
              type="number"
              value={settings.upstreamTimeoutSeconds === null ? "" : String(settings.upstreamTimeoutSeconds)}
              placeholder="Deployment default"
              onChange={(e) => {
                const raw = e.target.value.trim();
                save(
                  { upstreamTimeoutSeconds: raw.length === 0 ? null : Number(raw) },
                  "Upstream timeout updated.",
                );
              }}
            />
            <p className="mt-1 text-badge text-text-tertiary">
              5–600 seconds. Blank uses the deployment default. Applied when the request is
              dispatched, so it can only shorten a deadline that has already started.
            </p>
          </div>

          <div className="settings-field">
            <Input
              label="Telemetry compaction age (days)"
              id="compact-after-days"
              type="number"
              value={settings.telemetryCompactAfterDays === null ? "" : String(settings.telemetryCompactAfterDays)}
              placeholder="Deployment default"
              onChange={(e) => {
                const raw = e.target.value.trim();
                save(
                  { telemetryCompactAfterDays: raw.length === 0 ? null : Number(raw) },
                  "Compaction age updated.",
                );
              }}
            />
            <p className="mt-1 text-badge text-text-tertiary">
              1–365 days. Blank uses the default. Past this age, hourly request files are folded into
              daily summaries: totals keep counting, but individual requests are no longer listed.
              Hourly files hold every tenant together, so the largest age across all tenants wins —
              compacting later than asked only costs disk, while compacting earlier would destroy
              rows someone expected to keep.
            </p>
          </div>

          <div className="settings-field">
            <Input
              label="Max attachment size (MB)"
              id="image-clamp-max-bytes"
              type="number"
              value={
                settings.imageClampMaxBytes === null
                  ? ""
                  : String(Math.floor(settings.imageClampMaxBytes / (1024 * 1024)))
              }
              placeholder="Deployment default (10 MB)"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const mb = raw.length === 0 ? null : Number(raw);
                save(
                  {
                    imageClampMaxBytes:
                      mb === null || !Number.isFinite(mb) ? null : Math.round(mb * 1024 * 1024),
                  },
                  "Attachment size limit updated.",
                );
              }}
            />
            <p className="mt-1 text-badge text-text-tertiary">
              Per image, 0.06–100 MB. Blank uses the deployment default. An oversized attachment is
              refused before send rather than after the upstream rejects it — a block too large
              poisons every retry and every replayed turn. Raising this asserts your upstreams accept
              more; lowering it is the safer direction. Applies to the Claude/Messages wire.
            </p>
          </div>
        </Stack>
      </CardBody>
    </Card>
  );
}

function PasswordChangeForm(): ReactNode {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const submit = () => {
    setSuccess(false);
    if (newPassword.length < 8) {
      setFormError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError("New password and confirmation do not match.");
      return;
    }
    setFormError(null);
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setSuccess(true);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        },
        onError: (error) => setFormError(getErrorMessage(error, "Password change failed.")),
      },
    );
  };

  return (
    <Stack gap="12px" className="flex-1">
      <Input id="current-password" label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
      <div className="settings-pair settings-pair-tight">
        <Input id="new-password" label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        <Input id="confirm-password" label="Confirm new password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
      </div>
      {formError ? <p role="alert" className="settings-feedback" data-tone="err">{formError}</p> : null}
      {success ? <p role="status" className="settings-feedback" data-tone="ok">Password updated.</p> : null}
      <div className="mt-auto flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={changePassword.isPending || !currentPassword || !newPassword || !confirmPassword}
        >
          {changePassword.isPending ? "Updating…" : "Update password"}
        </Button>
      </div>
    </Stack>
  );
}

export default function Settings(): ReactNode {
  return (
    <Card>
      <CardHeader
        title="Settings"
        subtitle="Account security, privacy, and tenant data"
        icon={<Shield size={16} />}
      />
      <CardBody className="flex flex-col gap-10">
        <section className="flex flex-col gap-5">
          <h2 className="text-badge font-bold uppercase tracking-label text-text-tertiary">Account</h2>
          <div className="grid grid-cols-2 gap-8 w-full min-w-0 max-medium:grid-cols-1">
            <Card className="h-full">
              <CardHeader title="Security" subtitle="Change the password used to sign in to this console" icon={<Shield size={16} />} />
              <CardBody className="flex flex-1 flex-col">
                <PasswordChangeForm />
              </CardBody>
            </Card>
            <PrivacyPanel />
          </div>
        </section>
        <section className="flex flex-col gap-5">
          <h2 className="text-badge font-bold uppercase tracking-label text-text-tertiary">Data</h2>
          <BackupPanel />
        </section>
        <section className="flex flex-col gap-5">
          <h2 className="text-badge font-bold uppercase tracking-label text-text-tertiary">Operations</h2>
          <OperationalPanel />
        </section>
      </CardBody>
    </Card>
  );
}
