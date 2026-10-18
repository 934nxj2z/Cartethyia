import { Check, Copy, Globe } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { useClipboard } from "../../hooks/use-clipboard";
import { toast } from "../../lib/toast";


function ApiEndpointCard() {
  const { copied, copy } = useClipboard(2000);
  // The endpoint is served from the same origin the dashboard is, so the origin
  // is used exactly as the browser sees it. It used to be rewritten to the
  // gateway's default port, which broke every deployment that listens on
  // another port or sits behind a TLS-terminating proxy — the dashboard loads
  // over one authority and the card advertised a different one.
  const endpoint = `${window.location.origin}/v1`;
  const copyEndpoint = async () => {
    if (await copy(endpoint)) {
      toast.success("Gateway endpoint copied", endpoint);
      return;
    }
    toast.error("Clipboard unavailable on this origin");
  };
  return (
    <Card>
      <CardHeader
        title="Gateway Endpoint"
        subtitle="Universal OpenAI & Anthropic Wire API Endpoint Compatible"
        icon={<Globe size={16} />}
      />
      <CardBody>
        <Stack gap="10px">
          <div className="nested-panel flex items-center gap-4 rounded-control border border-inner-border bg-code-surface px-7 py-5 font-mono text-body font-semibold tabular-nums">
            <code className="min-w-0 flex-1 truncate" title={endpoint}>{endpoint}</code>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              aria-label="Copy endpoint"
              title="Copy endpoint"
              onClick={() => void copyEndpoint()}
              className="shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-caption leading-normal text-text-secondary">
            Point any SDK, CLI, or agent (e.g. OpenCode, Pi, OMP, Kilo, Cline, Droid and more clients) to this same-origin base URL.
            <span className="mt-1 block text-text-tertiary">
              You may not put <code className="font-mono">/v1</code> on Claude Code — the CLI appends it itself.
            </span>
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}


export default function Overview(): ReactNode {
  return (
    <Stack gap="16px">
      <ApiEndpointCard />
      <CompressionPanel />
      <ApiKeysPanel />
    </Stack>
  );
}
