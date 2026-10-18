import { AlertCircle, ArrowDown, ArrowUp, Bot, Brain, Check, ChevronDown, Copy, DatabaseZap, Download, Gauge, Pencil, RotateCcw, Sigma, Timer, Wrench, ZoomIn } from "lucide-react";
import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import type { LabMessage } from "./session";
import { createSvgPreviewDocument } from "./svgPreview";




function modelName(model: string | undefined): string {
  if (model === undefined || model.length === 0) return "";
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

function providerName(model: string | undefined): string {
  if (model === undefined) return "";
  const slash = model.indexOf("/");
  return slash === -1 ? "" : model.slice(0, slash);
}


function duration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function count(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function toolSummary(call: { readonly name: string; readonly arguments: string }): string {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return "Invalid tool arguments";
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "No action details";
  const record = args as Record<string, unknown>;
  const detail = call.name === "web_search" ? record.query : record.prompt;
  return typeof detail === "string" && detail.trim().length > 0
    ? detail.trim().slice(0, 240)
    : "No action details";
}

/**
 * Tool arguments for the expandable detail block.
 *
 * Pretty-printed so a long image prompt is readable instead of one unbroken
 * line. Unparseable JSON is shown verbatim — the operator needs to see what the
 * model actually sent, and reformatting it would hide the defect.
 */
function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}


function thinkingText(text: string): string {
  const trimmed = text.replace(/\r/g, "").trim();
  if (trimmed.length === 0 || /^[.\u2026…]+$/.test(trimmed)) return "";
  return text.replace(/\r/g, "").replace(/^\n+|\n+$/g, "");
}

function markdownText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(markdownText).join("");
  return "";
}

function MarkdownPre({ children }: { readonly children?: ReactNode }): ReactNode {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const code = isValidElement<{ readonly className?: string; readonly children?: ReactNode }>(children)
    ? children
    : undefined;
  const className = code?.props.className ?? "";
  const source = markdownText(code?.props.children ?? children);
  const isSvg = className.split(/\s+/).includes("language-svg");
  const preview = createSvgPreviewDocument(source);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const copyControls = (
    <div className="flex items-center justify-end gap-3">
      <span aria-live="polite" className="text-micro text-text-tertiary">
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : ""}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex h-11 items-center gap-2 rounded-control border border-inner-border bg-surface-2 px-4 text-caption font-semibold text-text-secondary cursor-pointer hover:bg-hover hover:text-text-primary"
      >
        {copyState === "copied" ? <Check size={12} /> : copyState === "failed" ? <AlertCircle size={12} /> : <Copy size={12} />}
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code"}
      </button>
    </div>
  );
  if (!isSvg) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {copyControls}
        <pre className="scroll-region max-w-full max-h-96 overflow-auto">{children}</pre>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {copyControls}
      {preview === undefined ? (
        <p className="m-0 text-caption text-text-tertiary">SVG preview unavailable: invalid or oversized document.</p>
      ) : (
        <iframe
          title="Sandboxed SVG preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={preview}
          className="w-full h-80 svg-preview-frame border border-inner-border rounded-control bg-surface-2"
        />
      )}
      <details>
        <summary className="cursor-pointer text-caption text-text-secondary">Show original SVG source</summary>
        <pre className="scroll-region max-w-full max-h-96 overflow-auto"><code className={className}>{source}</code></pre>
      </details>
    </div>
  );
}

type MediaPreview = { readonly kind: "image" | "video"; readonly name: string; readonly src: string };



/**
 * One turn with a face, not a bare pill.
 *
 * You and the model each get an icon. The bubble shows only the model name
 * that answered that turn; the provider appears on hover. Thinking stays
 * open while it is arriving, five lines at a time, older lines scrolling up,
 * then collapses once the answer starts.
 */
export function ChatBubble({
  message,
  onEdit,
  onRetry,
  onQuestionAnswer,
  onQuestionCancel,
  onToolApproval,
  retryDisabled = false,
  questionDisabled = false,
  continuation = false,
  showStats = false,
}: {
  readonly message: LabMessage;
  readonly onEdit?: (text: string) => void;
  readonly onRetry?: () => void;
  readonly onQuestionAnswer?: (message: LabMessage, optionId: string) => void;
  readonly onQuestionCancel?: (message: LabMessage) => void;
  readonly onToolApproval?: (message: LabMessage, approved: boolean) => void;
  readonly retryDisabled?: boolean;
  readonly questionDisabled?: boolean;
  /**
   * This turn continues the assistant turn directly above it, so its model
   * header is suppressed. A follow-up reply after generated media is still the
   * same turn to the reader — repeating the model name made one answer look
   * like two.
   */
  readonly continuation?: boolean;
  /**
   * This bubble ends the assistant's turn, so it carries the turn's usage
   * figures. Only one bubble per turn shows them.
   */
  readonly showStats?: boolean;
}): ReactNode {
  const mine = message.role === "user";
  const thinking = thinkingText(message.reasoning ?? "");
  // The final paint omits the flat list and carries the rounds instead, so a
  // completed media turn would lose its tool detail. Derive it from the rounds
  // whenever the flat one is absent — one source, whichever the writer used.
  const toolCalls = message.toolCalls ?? message.toolRounds?.flatMap((round) => round.toolCalls) ?? [];
  const live = message.pending === true && message.error !== true;
  const waiting = live && message.text.length === 0 && thinking.length === 0 && message.mediaPending === undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [copied, setCopied] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [questionExpanded, setQuestionExpanded] = useState(message.selectedOption === undefined);
  const [thinkingOpen, setThinkingOpen] = useState(thinking.length > 0 && message.text.length === 0);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const thinkingAtBottomRef = useRef(true);
  const name = modelName(message.model);
  const provider = providerName(message.model);
  // Usage belongs to the turn, not to every bubble in it: a media turn renders
  // a preview bubble and then the written answer, and repeating the figures
  // under each made one answer look like several billed requests.
  const totalTokens = (message.usage?.inputTokens ?? 0) + (message.usage?.outputTokens ?? 0);
  const total = message.usage?.inputTokens === undefined && message.usage?.outputTokens === undefined ? null : count(totalTokens);
  const tokenSpeed =
    message.usage?.outputTokens !== undefined && message.usage?.completionMs !== undefined && message.usage.completionMs > 0
      ? `${Math.round(message.usage.outputTokens / (message.usage.completionMs / 1000))}/s`
      : null;
  const metrics = mine || !showStats
    ? []
    : [
        duration(message.usage?.ttftMs) === null ? null : { icon: <Timer size={10} />, label: "Time to first token", value: duration(message.usage?.ttftMs) ?? "" },
        count(message.usage?.inputTokens) === null ? null : { icon: <ArrowUp size={10} />, label: "Input tokens", value: count(message.usage?.inputTokens) ?? "" },
        count(message.usage?.cachedTokens) === null ? null : { icon: <DatabaseZap size={10} />, label: "Cached tokens", value: count(message.usage?.cachedTokens) ?? "" },
        count(message.usage?.outputTokens) === null ? null : { icon: <ArrowDown size={10} />, label: "Output tokens", value: count(message.usage?.outputTokens) ?? "" },
        total === null ? null : { icon: <Sigma size={10} />, label: "Total tokens", value: total },
        tokenSpeed === null ? null : { icon: <Gauge size={10} />, label: "Token speed", value: tokenSpeed },
        duration(message.usage?.completionMs) === null ? null : { icon: <Check size={10} />, label: "Done", value: duration(message.usage?.completionMs) ?? "" },
      ].filter((item) => item !== null);
  useEffect(() => {
    if (thinking.length > 0 && message.text.length === 0) setThinkingOpen(true);
    if (message.text.length > 0) setThinkingOpen(false);
  }, [thinking.length, message.text.length]);

  useEffect(() => {
    if (message.selectedOption !== undefined) setQuestionExpanded(false);
  }, [message.selectedOption]);

  useEffect(() => {
    const panel = thinkingRef.current;
    if (!thinkingOpen || panel === null || !thinkingAtBottomRef.current) return;
    panel.scrollTop = panel.scrollHeight;
  }, [thinking, thinkingOpen]);

  const copy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={mine ? "mlab-turn flex flex-col w-full max-w-380 gap-2 items-end ml-auto animate-message-in motion-reduce:animate-none" : "mlab-turn flex flex-col w-full max-w-380 gap-2 items-start mr-auto animate-message-in motion-reduce:animate-none"}>
      {mine || continuation ? null : (
        <div className="flex items-center gap-3 min-h-12 text-text-tertiary text-caption">
          <span className="grid place-items-center w-11 h-11 rounded-control border border-inner-border bg-surface-2 text-text-secondary" aria-hidden="true">
            <Bot size={13} />
          </span>
          <span className="font-bold text-text-secondary" title={provider.length > 0 ? provider : undefined}>{name || "Model"}</span>
        </div>
      )}

      {thinking.length > 0 ? (
        <div className="flex flex-col gap-3 w-full max-w-280 text-text-tertiary font-sans text-caption">
          <button type="button" className="inline-flex items-center gap-2.5 w-fit h-12 px-4 border border-inner-border rounded-pill bg-surface-2 text-text-secondary font-sans text-badge font-semibold cursor-pointer hover:border-border-strong hover:bg-hover hover:text-text-primary [&_svg]:flex-none [&_svg[data-open=true]]:rotate-180" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen((current) => {
            if (!current) thinkingAtBottomRef.current = true;
            return !current;
          })}>
            <Brain size={12} />
            <span>{live && message.text.length === 0 ? "Thinking" : "Thought"}</span>
            <ChevronDown size={12} data-open={thinkingOpen ? "true" : "false"} />
          </button>
          {thinkingOpen ? (
            <div
              ref={thinkingRef}
              onScroll={(event) => {
                const panel = event.currentTarget;
                thinkingAtBottomRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24;
              }}
              className="scroll-region thinking-clamp overflow-auto px-5 py-4 border border-inner-border rounded-control bg-surface-2 text-text-secondary leading-normal select-text cursor-text [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className={
          mine
            ? "max-w-full max-medium:max-w-bubble-narrow text-lead leading-chat wrap-break-word px-7 py-4 border border-border-strong rounded-hero rounded-br-tiny bg-surface-active text-text-primary whitespace-pre-wrap"
            : message.error === true
              ? "max-w-full max-medium:max-w-bubble-narrow text-lead leading-chat wrap-break-word py-1 pr-1 text-red"
              : "max-w-full max-medium:max-w-bubble-narrow text-lead leading-chat wrap-break-word py-1 pr-1 text-text-primary"
        }
      >
        {waiting ? (
          <span className="inline-flex items-center gap-2 h-11 px-2 text-text-tertiary text-caption" aria-label="Model is thinking">
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none" />
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none [animation-delay:0.15s]" />
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none [animation-delay:0.3s]" />
            <span>Thinking…</span>
          </span>
        ) : editing ? (
          <form
            className="flex flex-col gap-4 min-w-140 max-w-bubble-form"
            onSubmit={(event) => {
              event.preventDefault();
              onEdit?.(draft);
              setEditing(false);
            }}
          >
            <textarea value={draft} aria-label="Edit message" onChange={(event) => setDraft(event.target.value)} className="w-full min-h-32 border-0 outline-none resize-y bg-transparent text-text-primary caret-text-primary font-sans" />
            <span className="flex justify-end gap-3">
              <button type="button" onClick={() => setEditing(false)} className="h-13 px-5 border-0 rounded-pill bg-hover text-text-secondary text-caption font-semibold cursor-pointer hover:bg-surface-hover">Cancel</button>
              <button type="submit" className="h-13 px-5 border-0 rounded-pill bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer">Send</button>
            </span>
          </form>
        ) : (
          <>
            {message.mediaPending !== undefined ? (
              <div
                role="status"
                aria-label={
                  message.mediaStage === "planning"
                    ? `Calling generate_${message.mediaPending}`
                    : `Generating ${message.mediaPending}`
                }
                className={`relative mb-3 grid w-full max-w-120 place-items-center overflow-hidden rounded-control border border-inner-border bg-surface-2 ${
                  message.mediaPending === "image" ? "aspect-square" : "aspect-video"
                }`}
              >
                <div className="absolute inset-0 animate-pulse bg-linear-to-r from-surface-2 via-hover to-surface-2 motion-reduce:animate-none" />
                <div className="relative flex flex-col items-center gap-3 px-5 text-center text-caption text-text-secondary">
                  <span className="h-3 w-3 rounded-full bg-accent animate-typing-bounce motion-reduce:animate-none" aria-hidden="true" />
                  <span className="font-semibold">
                    {message.mediaStage === "planning"
                      ? `Calling generate_${message.mediaPending}…`
                      : `Generating ${message.mediaPending}…`}
                  </span>
                  <span className="text-text-tertiary">
                    {message.mediaStage === "planning"
                      ? "The planner is preparing the worker request."
                      : "Your preview will appear here when it’s ready."}
                  </span>
                </div>
              </div>
            ) : null}
            {mine ? (
              message.text.length > 0 ? message.text : null
            ) : message.text.length > 0 ? (
              <div className="min-w-0 font-sans text-body-lg leading-normal [&_p]:m-0 [&_p]:mb-4 [&_ul]:m-0 [&_ul]:mb-4 [&_ol]:m-0 [&_ol]:mb-4 [&_pre]:m-0 [&_pre]:mb-4 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0 [&_pre:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:px-6 [&_pre]:py-5 [&_pre]:rounded-control [&_pre]:bg-surface-muted [&_pre]:font-mono [&_pre]:text-caption [&_code]:font-mono [&_svg]:flex-none [&_svg]:mt-1.5">
                {message.error === true ? <AlertCircle size={14} aria-hidden="true" /> : null}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: MarkdownPre,
                    table: ({ children }) => (
                      <div className="my-4 max-w-full overflow-x-auto rounded-control border border-inner-border">
                        <table className="w-full border-collapse text-left text-caption">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border-b border-inner-border bg-surface-2 px-4 py-3 text-left font-semibold text-text-primary">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border-b border-inner-border px-4 py-3 align-top text-text-secondary [&>p]:my-0">
                        {children}
                      </td>
                    ),
                  }}
                >
                  {message.text}
                </ReactMarkdown>
                {live ? <span className="ml-1 inline-block text-accent animate-stream-caret" aria-hidden="true">▋</span> : null}
              </div>
            ) : null}
      {toolCalls.length > 0 && !live ? (
        <div className="flex flex-col gap-3 items-start w-full max-w-280 text-text-tertiary font-sans text-caption">
          {toolCalls.map((call) => (
            // Collapsed this is a pill sized to the tool's name; expanded it
            // grows to fit the arguments instead of stretching the column.
            // Rendered only once the turn settles: while it is still running the
            // arguments are the planner's own draft, and showing them mid-flight
            // leaked a half-formed prompt into the transcript before the call
            // had even been made. "Running <tool>…" covers that window.
            <details
              key={call.id}
              className="w-fit max-w-full border border-inner-border rounded-control bg-surface-2"
            >
              <summary className="cursor-pointer select-none list-none flex items-center gap-2.5 h-12 px-4 text-text-secondary text-badge font-semibold hover:text-text-primary [&::-webkit-details-marker]:hidden">
                <Wrench size={12} aria-hidden="true" className="text-accent flex-none" />
                <span>Tool call · {call.name}</span>
                <ChevronDown size={14} aria-hidden="true" className="flex-none [details[open]_&]:rotate-180" />
              </summary>
              <div className="px-5 pb-4 pt-1 flex flex-col gap-3 max-w-280">
                <span className="text-micro uppercase tracking-label text-text-tertiary">Arguments</span>
                <pre className="scroll-region overflow-auto max-h-80 px-5 py-4 border border-inner-border rounded-control bg-surface-1 text-text-secondary leading-normal select-text cursor-text whitespace-pre-wrap wrap-anywhere">
                  {prettyArguments(call.arguments)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      ) : null}
            {(message.images?.length ?? 0) > 0 ? (
              <div className="flex flex-wrap gap-2 mb-1">
                {message.images?.map((image) => (
                  mine ? (
                    <img
                      key={image.dataUrl}
                      src={image.dataUrl}
                      alt={image.name}
                      referrerPolicy="no-referrer"
                      className="w-20 h-20 object-cover rounded-control border border-inner-border"
                    />
                  ) : (
                    <button
                      key={image.dataUrl}
                      type="button"
                      aria-label={`Open image preview: ${image.name}`}
                      title="Open image preview"
                      onClick={() => setMediaPreview({ kind: "image", name: image.name, src: image.dataUrl })}
                      className="block aspect-square w-full max-w-120 cursor-zoom-in border-0 bg-surface-2 p-0 focus-visible:outline-2 focus-visible:outline-focus-ring"
                    >
                      <img
                        src={image.dataUrl}
                        alt={image.name}
                        referrerPolicy="no-referrer"
                        className="h-full w-full rounded-control border border-inner-border object-contain"
                      />
                    </button>
                  )
                ))}
              </div>
            ) : null}
            {(message.videos?.length ?? 0) > 0 ? (
              <div className="flex flex-col gap-3 mb-3 w-full">
                {message.videos?.map((video) => (
                  <div key={video.src} className="flex flex-col items-start gap-2">
                      <div className="aspect-video w-full max-w-120 rounded-control border border-inner-border bg-surface-2">
                        <video
                          controls
                          preload="metadata"
                          aria-label={video.name}
                          src={video.src}
                          className="h-full w-full rounded-control object-contain"
                        />
                      </div>
                    <button
                      type="button"
                      onClick={() => setMediaPreview({ kind: "video", name: video.name, src: video.src })}
                      className="inline-flex h-11 items-center gap-2 rounded-control border border-inner-border bg-surface-2 px-4 text-caption font-semibold text-text-secondary cursor-pointer hover:bg-hover hover:text-text-primary"
                    >
                      <ZoomIn size={13} aria-hidden="true" />
                      Open video preview
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {(message.workerModels?.length ?? 0) > 0 ? (
              <div className="flex flex-wrap gap-2 mb-3">
                {message.workerModels?.map((worker) => (
                  <span key={worker} className="inline-flex items-center h-10 px-3 border border-inner-border rounded-pill bg-surface-2 text-text-tertiary text-micro font-mono">
                    Media worker · {worker}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      {message.pendingToolCalls === undefined &&
      (message.status === "Running approved tools…" || message.status === "Skipping tools…") ? (
        <p role="status" className="m-0 text-caption text-text-tertiary">{message.status}</p>
      ) : null}
      {message.pendingToolCalls !== undefined ? (
        <section className="flex w-full max-w-280 flex-col gap-3 rounded-control border border-inner-border bg-surface-2 p-5" aria-label="Tool approval">
          <h3 className="m-0 text-body-lg font-semibold text-text-primary">Allow these actions?</h3>
          <p role="status" className="m-0 text-caption text-text-tertiary">
            {message.status ?? "Waiting for approval"}
          </p>
          <ul className="m-0 flex flex-col gap-3 pl-5 text-caption text-text-secondary">
            {message.pendingToolCalls.map((call) => (
              <li key={call.id}>
                <span className="font-semibold">{call.name.replaceAll("_", " ")}</span>
                <p className="m-0 mt-1 whitespace-pre-wrap break-words text-text-tertiary">{toolSummary(call)}</p>
              </li>
            ))}
          </ul>
          {message.toolApprovalError ? (
            <p role="alert" className="m-0 text-caption text-red">{message.toolApprovalError}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={questionDisabled}
              onClick={() => onToolApproval?.(message, true)}
            >
              Allow and run
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={questionDisabled}
              onClick={() => onToolApproval?.(message, false)}
            >
              Deny
            </Button>
          </div>
        </section>
      ) : null}
      {message.question !== undefined ? (
        <section className="flex w-full max-w-280 flex-col gap-3 rounded-control border border-inner-border bg-surface-2 p-5" aria-label="Planner question">
          {message.selectedOption === undefined ? (
            <h3 className="m-0 text-body-lg font-semibold text-text-primary">{message.question.question}</h3>
          ) : (
            <button
              type="button"
              aria-expanded={questionExpanded}
              onClick={() => setQuestionExpanded((expanded) => !expanded)}
              className="flex w-full items-start justify-between gap-4 border-0 bg-transparent p-0 text-left cursor-pointer"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-body-lg font-semibold text-text-primary">{message.question.question}</span>
                <span className="text-caption text-text-tertiary">
                  {message.selectedOption === "cancelled"
                    ? "Question skipped"
                    : `Answer: ${message.question.options.find((option) => option.id === message.selectedOption)?.label ?? message.selectedOption}`}
                </span>
              </span>
              <ChevronDown
                size={16}
                className={`mt-1 shrink-0 text-text-tertiary transition-transform ${questionExpanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
          {questionExpanded ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {message.question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={questionDisabled || message.selectedOption !== undefined}
                    aria-pressed={message.selectedOption === option.id}
                    onClick={() => onQuestionAnswer?.(message, option.id)}
                    className="flex min-h-14 flex-col items-start gap-1 rounded-control border border-inner-border bg-surface-1 px-4 py-3 text-left text-caption text-text-primary cursor-pointer hover:border-accent hover:bg-accent-soft disabled:cursor-default disabled:opacity-60"
                  >
                    <span className="font-semibold">{option.label}</span>
                    {option.description ? <span className="text-text-tertiary">{option.description}</span> : null}
                    {message.selectedOption === option.id ? <span className="text-accent">Selected</span> : null}
                  </button>
                ))}
              </div>
              {message.selectedOption === undefined ? (
                <button
                  type="button"
                  disabled={questionDisabled}
                  onClick={() => onQuestionCancel?.(message)}
                  className="h-10 w-fit border-0 bg-transparent px-2 text-caption text-text-tertiary underline cursor-pointer hover:text-text-primary disabled:cursor-default disabled:opacity-60"
                >
                  Skip this question
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {(mine || onRetry !== undefined) && !editing ? (
        <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover:opacity-100 [.mlab-turn:hover_&]:opacity-100 [.mlab-turn:focus-within_&]:opacity-100">
          {mine ? (
            <button type="button" aria-label="Copy message" title="Copy" onClick={() => void copy()} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          ) : null}
          {mine && onEdit !== undefined ? (
            <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={() => { setDraft(message.text); setEditing(true); }} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary">
              <Pencil size={12} />
            </button>
          ) : null}
          {onRetry !== undefined ? (
            <button type="button" aria-label="Retry response" title="Retry response" disabled={retryDisabled} onClick={onRetry} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-default">
              <RotateCcw size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {showStats && !mine && !live && (metrics.length > 0 || message.text.length > 0) ? (
        <div className="inline-flex items-center h-8 rounded-tiny bg-surface-muted text-text-tertiary overflow-hidden [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1 [&>span]:h-8 [&>span]:px-2.5 [&>span]:border-0 [&>span]:border-r [&>span]:border-r-inner-border [&>span]:bg-transparent [&>span]:text-inherit [&>span]:font-sans [&>span]:text-micro [&>span]:leading-none [&>span]:tabular-nums [&>span:last-child]:border-r-0 [&_svg]:flex-none [&>button]:cursor-pointer">
          {metrics.map((item) => (
            <span key={item.label} title={item.label}>
              {item.icon}
              <span>{item.value}</span>
            </span>
          ))}
          {message.text.length > 0 ? (
            <button type="button" aria-label="Copy message" title="Copy" onClick={() => void copy()}>
              {copied ? <Check size={10} /> : <Copy size={10} />}
            </button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={mediaPreview !== null}
        onClose={() => setMediaPreview(null)}
        title={mediaPreview?.name ?? "Media preview"}
        description="Full-size generated media preview"
        size="xl"
        footer={(
          <>
            {mediaPreview === null ? null : (
              <a
                href={mediaPreview.src}
                download={mediaPreview.name}
                target={mediaPreview.src.startsWith("https:") ? "_blank" : undefined}
                rel="noreferrer"
                className="inline-flex h-14 items-center gap-2 rounded-control border border-inner-border bg-surface-2 px-5 text-caption font-semibold text-text-primary no-underline hover:bg-hover"
              >
                <Download size={14} aria-hidden="true" />
                Download
              </a>
            )}
            <Button variant="secondary" type="button" onClick={() => setMediaPreview(null)}>
              Close
            </Button>
          </>
        )}
      >
        {mediaPreview === null ? null : (
          <div className="grid min-h-0 place-items-center">
            {mediaPreview.kind === "image" ? (
              <img
                src={mediaPreview.src}
                alt={mediaPreview.name}
                referrerPolicy="no-referrer"
                className="media-preview-frame max-w-full w-auto h-auto object-contain"
              />
            ) : (
              <video
                controls
                preload="metadata"
                aria-label={mediaPreview.name}
                src={mediaPreview.src}
                className="media-preview-frame max-w-full w-auto h-auto object-contain"
              />
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
