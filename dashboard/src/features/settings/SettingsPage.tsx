import { Shield } from "lucide-react";
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
import {
  useRuntimeSettings,
  useUpdateRuntimeSettings,
} from "../../hooks/settings";
import { getErrorMessage } from "../../data/api";

/**
 * The values the operational dropdowns offer.
 *
 * Each is a bounded number the backend clamps anyway, so offering the range as
 * choices says what is actually reachable instead of accepting anything and
 * correcting it out of sight. The lists are deliberately short and land on the
 * round values an operator would type; a deployment default is a separate
 * option, because "unset" is a real state rather than one of the numbers.
 */
const TIMEOUT_CHOICES = [5, 15, 30, 60, 120, 300, 600] as const;
const COMPACTION_CHOICES = [1, 3, 7, 14, 30, 90, 365] as const;
const ATTACHMENT_CHOICES = [1, 5, 10, 25, 50, 100] as const;

/**
 * Options for a bounded-number dropdown, including the operator's own value.
 *
 * A stored value need not be one we offer — it may predate this list, or have
 * been set by another surface. Dropping it would render the trigger empty for
 * a setting that is very much in force, which reads as "unset" and invites the
 * operator to change something that is already right. So the current value is
 * appended when it is not among the choices, and sorted back into place.
 */
export function boundedOptions(
  choices: readonly number[],
  current: number | null,
  suffix: (value: number) => string,
): { value: string; label: string }[] {
  const values =
    current === null || choices.includes(current)
      ? [...choices]
      : [...choices, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: suffix(value) }));
}

/**
 * One titled band of settings.
 *
 * `id` anchors deep links (#operations) — with every section rendered, the
 * anchor is what keeps a link from elsewhere in the console useful.
 */
function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section id={id} aria-label={title} className="min-w-0 scroll-mt-4">
      <h2 className="text-subtitle font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-badge text-text-tertiary">{description}</p>
      <div className="mt-7 min-w-0">{children}</div>
    </section>
  );
}

function PrivacyPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending)
    return <LoadingState label="Loading privacy settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(
          query.error,
          "Failed to load runtime settings",
        )}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <Stack gap="16px">
      <div className="settings-field">
        <Select
          label="Telemetry payloads"
          id="privacy-payloads"
          value={settings.telemetryPayloads}
          onValueChange={(value) =>
            mutation.mutate(
              {
                telemetryPayloads:
                  value === "full" || value === "metadata" ? value : "none",
              },
              {
                onSuccess: () => toast.success("Payload capture updated"),
                onError: (error) =>
                  toast.error(
                    getErrorMessage(error, "Could not update payload capture."),
                  ),
              },
            )
          }
          options={[
            { value: "none", label: "Off — no payload capture" },
            {
              value: "metadata",
              label: "Metadata — method and headers, 15 minutes",
            },
            { value: "full", label: "Full — redacted bodies, 15 minutes" },
          ]}
        />
        <p className="mt-1 text-badge text-text-tertiary">
          Request metadata is always kept. Bodies stay off until you turn them
          on, and anything captured is redacted and deleted after 15 minutes.
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
                {
                  telemetryPayloadDepth:
                    value === "moderate" || value === "maximum"
                      ? value
                      : "minimum",
                },
                {
                  onSuccess: () => toast.success("Capture depth updated"),
                  onError: (error) =>
                    toast.error(
                      getErrorMessage(error, "Could not update capture depth."),
                    ),
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
            <Banner
              tone="warning"
              surface="raised"
              className="text-text-secondary"
            >
              <strong>High CPU and memory while this is on.</strong> Use it to
              debug, then switch back to Metadata or Minimum.
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
                onError: (error) =>
                  toast.error(
                    getErrorMessage(error, "Could not update IP display."),
                  ),
              },
            )
          }
          options={[
            { value: "masked", label: "Masked — recommended" },
            { value: "full", label: "Show full IP" },
          ]}
        />
        <p className="mt-1 text-badge text-text-tertiary">
          Raw addresses stay stored. This only changes how they are shown.
        </p>
      </div>
    </Stack>
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
  if (query.isPending)
    return <LoadingState label="Loading operational settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(
          query.error,
          "Failed to load runtime settings",
        )}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const save = (
    patch: Parameters<typeof mutation.mutate>[0],
    message: string,
  ): void => {
    mutation.mutate(patch, {
      onSuccess: () => toast.success(message),
      onError: (error) =>
        toast.error(getErrorMessage(error, "Could not update settings.")),
    });
  };

  return (
    <Stack gap="14px">
      <div className="flex items-center justify-between gap-6 rounded-control border border-inner-border px-6 py-5">
        <span className="min-w-0">
          <strong className="block text-body">Force disable cooldown</strong>
          <small className="text-badge text-text-tertiary">
            Route to accounts that are cooling down, including ones already
            parked.
          </small>
        </span>
        <Switch
          checked={settings.forceDisableCooldown}
          onChange={(next) =>
            save(
              { forceDisableCooldown: next },
              next
                ? "Cooldowns will be ignored."
                : "Cooldowns are enforced again.",
            )
          }
          aria-label="Force disable cooldown"
        />
      </div>
      {settings.forceDisableCooldown ? (
        <Banner tone="warning" surface="raised" live="status">
          <strong>This may cause admission failure.</strong> A cooled-down
          account was parked because the upstream refused it, so dialing it
          anyway reproduces that refusal on every attempt — and if every
          candidate is cooling, the request fails instead of waiting for a
          reset. The cooldown is still recorded and still recovered by the
          sweep, so turning this back off needs no cleanup. Per-model cooldowns
          are still enforced.
        </Banner>
      ) : null}

      {/*
       * Three bounded numbers in a grid, each a fixed set rather than a free
       * number field. An operator picking a timeout is choosing among values
       * that make sense, and a dropdown cannot hold a typo the backend then
       * silently clamps — "6000" in a number box reads as accepted until it is
       * quietly stored as 600.
       */}
      <div className="grid grid-cols-3 gap-8 w-full min-w-0 max-medium:grid-cols-1">
        <div className="settings-field">
          <Select
            label="Upstream timeout"
            id="upstream-timeout"
            value={settings.upstreamTimeoutSeconds?.toString() ?? ""}
            placeholder="Deployment default"
            onValueChange={(value) =>
              save(
                {
                  upstreamTimeoutSeconds:
                    value === "" ? null : Number(value),
                },
                "Upstream timeout updated.",
              )
            }
            options={[
              ...boundedOptions(
                TIMEOUT_CHOICES,
                settings.upstreamTimeoutSeconds,
                (v) => `${v} seconds`,
              ),
              { value: "", label: "Deployment default" },
            ]}
          />
          <p className="mt-1 text-badge text-text-tertiary">
            5–600 seconds. Applied when the request is dispatched, so it can
            only shorten a deadline that has already started.
          </p>
        </div>

        <div className="settings-field">
          <Select
            label="Telemetry compaction age"
            id="compact-after-days"
            value={settings.telemetryCompactAfterDays?.toString() ?? ""}
            placeholder="Deployment default"
            onValueChange={(value) =>
              save(
                {
                  telemetryCompactAfterDays: value === "" ? null : Number(value),
                },
                "Compaction age updated.",
              )
            }
            options={[
              ...boundedOptions(
                COMPACTION_CHOICES,
                settings.telemetryCompactAfterDays,
                (v) => (v === 1 ? "1 day" : `${v} days`),
              ),
              { value: "", label: "Deployment default" },
            ]}
          />
          <p className="mt-1 text-badge text-text-tertiary">
            1–365 days. Past this age, hourly request files are folded into
            daily summaries: totals keep counting, but individual requests are
            no longer listed. Hourly files hold every tenant together, so the
            largest age across all tenants wins — compacting later than asked
            only costs disk, while compacting earlier would destroy rows
            someone expected to keep.
          </p>
        </div>

        <div className="settings-field">
          <Select
            label="Max attachment size"
            id="image-clamp-max-bytes"
            value={
              settings.imageClampMaxBytes === null
                ? ""
                : String(Math.round(settings.imageClampMaxBytes / (1024 * 1024)))
            }
            placeholder="Deployment default (10 MB)"
            onValueChange={(value) =>
              save(
                {
                  imageClampMaxBytes:
                    value === "" ? null : Number(value) * 1024 * 1024,
                },
                "Attachment size limit updated.",
              )
            }
            options={[
              ...boundedOptions(
                ATTACHMENT_CHOICES,
                settings.imageClampMaxBytes === null
                  ? null
                  : Math.round(settings.imageClampMaxBytes / (1024 * 1024)),
                (v) => `${v} MB`,
              ),
              { value: "", label: "Deployment default (10 MB)" },
            ]}
          />
          <p className="mt-1 text-badge text-text-tertiary">
            Per image. An oversized attachment is refused before send rather
            than after the upstream rejects it — a block too large poisons every
            retry and every replayed turn. Raising this asserts your upstreams
            accept more; lowering it is the safer direction. Applies to the
            Messages and Gemini wires.
          </p>
        </div>
      </div>
    </Stack>
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
        onError: (error) =>
          setFormError(getErrorMessage(error, "Password change failed.")),
      },
    );
  };

  return (
    <Stack gap="12px" className="flex-1">
      <Input
        id="current-password"
        label="Current password"
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
      />
      <div className="settings-pair settings-pair-tight">
        <Input
          id="new-password"
          label="New password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
        <Input
          id="confirm-password"
          label="Confirm new password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      {formError ? (
        <p role="alert" className="settings-feedback" data-tone="err">
          {formError}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="settings-feedback" data-tone="ok">
          Password updated.
        </p>
      ) : null}
      <div className="mt-auto flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={
            changePassword.isPending ||
            !currentPassword ||
            !newPassword ||
            !confirmPassword
          }
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
      {/*
       * Every section is on the page at once. Nothing is behind a tab or a
       * disclosure, so an operator can see the whole surface in one scroll and
       * find a setting by looking rather than by guessing which heading hides
       * it. The sections carry ids so a link to #operations still lands in the
       * right place.
       */}
      <CardBody className="flex flex-col gap-12">
        <SettingsSection
          id="security"
          title="Security"
          description="Change the password used to sign in to this console."
        >
          <PasswordChangeForm />
        </SettingsSection>
        <SettingsSection
          id="privacy"
          title="Privacy"
          description="What request telemetry stores, and how client addresses are shown."
        >
          <PrivacyPanel />
        </SettingsSection>
        <SettingsSection
          id="operations"
          title="Operations"
          description="Routing, timeouts, and telemetry retention for this tenant."
        >
          <OperationalPanel />
        </SettingsSection>
        <SettingsSection
          id="data"
          title="Data"
          description="Export or restore this tenant's configuration and history."
        >
          <BackupPanel />
        </SettingsSection>
      </CardBody>
    </Card>
  );
}
