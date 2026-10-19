import { Globe, KeyRound, Pencil, Save, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ProviderResponse } from "../../../data/contracts";
import { Button } from "../../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { useUpdateProvider } from "../../../hooks/providers";

/** Shows and edits a custom provider's upstream root and points to its API-key account controls. */
export function CustomProviderSettings({
  provider,
}: {
  readonly provider: ProviderResponse;
}): ReactNode {
  const update = useUpdateProvider();
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");

  useEffect(() => {
    setBaseUrl(provider.baseUrl ?? "");
  }, [provider.providerId, provider.baseUrl]);

  const endpointRoot = (provider.baseUrl ?? "").replace(/\/+$/, "");
  const draftRoot = baseUrl.trim().replace(/\/+$/, "");
  const changed = draftRoot !== endpointRoot;
  const canSave = draftRoot.length > 0 && changed && !update.isPending;

  const save = (): void => {
    if (!canSave) return;
    update.mutate(
      { providerId: provider.providerId, request: { baseUrl: draftRoot } },
      { onSuccess: () => setEditing(false) },
    );
  };

  const openAccounts = (): void => {
    const accounts = document.getElementById("provider-accounts");
    accounts?.scrollIntoView({ behavior: "smooth", block: "start" });
    accounts?.focus({ preventScroll: true });
  };

  return (
    <Card>
      <CardHeader
        title="Custom Provider Endpoint"
        subtitle="Upstream base URL"
        icon={<Globe size={16} />}
      />
      <CardBody>
        <Stack gap="12px">
          {editing ? (
            <Input
              label="Base URL"
              id="custom-provider-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              autoFocus
            />
          ) : (
            <div className="min-w-0">
              <div className="text-micro font-semibold uppercase tracking-label text-text-tertiary">
                Base URL
              </div>
              <code className="mt-1 block min-w-0 break-all font-mono text-caption text-text-primary">
                {provider.baseUrl ?? "Not configured"}
              </code>
            </div>
          )}

          <Inline gap="8px" className="w-full flex-wrap" justify="end">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Save size={13} />}
                  disabled={!canSave}
                  loading={update.isPending}
                  onClick={save}
                >
                  Save endpoint
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<X size={13} />}
                  disabled={update.isPending}
                  onClick={() => {
                    setBaseUrl(provider.baseUrl ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={<Pencil size={13} />}
                onClick={() => setEditing(true)}
              >
                Edit endpoint
              </Button>
            )}
            {provider.requiresAccount ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<KeyRound size={13} />}
                onClick={openAccounts}
              >
                Manage API keys
              </Button>
            ) : null}
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
