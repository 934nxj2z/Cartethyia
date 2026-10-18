/**
 * Reads a gateway SSE response and reports each visible text delta.
 * The caller owns the assistant bubble; this only walks the wire.
 */

import { errorMessage, reasoningDelta, takeSseEvents, textDelta, toolCallName, usageDelta, type LabProtocol, type LabToolCall, type LabUsageDelta } from "./protocol";

export async function readLabStream(
  response: Response,
  protocol: LabProtocol,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
  onUsage: (usage: LabUsageDelta) => void,
  onTool: (name: string) => void,
  signal: AbortSignal,
): Promise<readonly LabToolCall[]> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(errorMessage(payload, response.status));
  }
  if (response.body === null) throw new Error("The gateway returned an empty stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const handleEvent = (event: { readonly event: string; readonly data: string }): boolean => {
    if (event.data === "[DONE]") return true;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return false;
    }
    const delta = textDelta(protocol, event.event, payload);
    if (delta.length > 0) onDelta(delta);
    const thought = reasoningDelta(protocol, event.event, payload);
    if (thought.length > 0) onReasoning(thought);
    const usage = usageDelta(protocol, event.event, payload);
    if (usage.inputTokens !== undefined || usage.cachedTokens !== undefined || usage.outputTokens !== undefined || usage.reasoningTokens !== undefined || usage.status !== undefined) {
      onUsage(usage);
    }
    const tool = toolCallName(protocol, event.event, payload);
    if (tool.length > 0) onTool(tool);
    if (protocol === "chat") appendChatToolCalls(payload, pendingToolCalls);
    return false;
  };
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Stopped");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Stopped");
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const taken = takeSseEvents(buffer);
      buffer = taken.rest;
      for (const event of taken.events) {
        if (handleEvent(event)) return collectedToolCalls(pendingToolCalls);
      }
    }
    buffer += decoder.decode();
    const final = takeSseEvents(`${buffer}\n\n`);
    for (const event of final.events) {
      if (handleEvent(event)) return collectedToolCalls(pendingToolCalls);
    }
    return collectedToolCalls(pendingToolCalls);
  } finally {
    reader.releaseLock();
  }
}

function appendChatToolCalls(
  payload: unknown,
  calls: Map<number, { id: string; name: string; arguments: string }>,
): void {
  if (payload === null || typeof payload !== "object") return;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (choice === null || typeof choice !== "object") continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (delta === null || typeof delta !== "object") continue;
    const toolCalls = (delta as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const item of toolCalls) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const index = typeof record.index === "number" ? record.index : calls.size;
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof record.id === "string") call.id += record.id;
      const fn = record.function;
      if (fn !== null && typeof fn === "object") {
        const fields = fn as Record<string, unknown>;
        if (typeof fields.name === "string") call.name = appendDelta(call.name, fields.name);
        if (typeof fields.arguments === "string") call.arguments += fields.arguments;
      }
      calls.set(index, call);
    }
  }
}

function appendDelta(previous: string, delta: string): string {
  if (delta.length === 0 || previous.endsWith(delta)) return previous;
  if (delta.startsWith(previous)) return delta;
  if (previous.startsWith(delta)) return previous;
  let overlap = Math.min(previous.length, delta.length);
  while (overlap > 0 && !previous.endsWith(delta.slice(0, overlap))) overlap -= 1;
  return `${previous}${delta.slice(overlap)}`;
}

function collectedToolCalls(
  calls: ReadonlyMap<number, { readonly id: string; readonly name: string; readonly arguments: string }>,
): readonly LabToolCall[] {
  return Array.from(calls.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id.length > 0 ? call.id : `model-lab-tool-${index}`,
      name: call.name,
      arguments: call.arguments,
    }))
    .filter((call) => call.name.length > 0);
}
