// Hosted web-search tool identity.
import type { ToolDefinition } from "../../protocol/canonical-model";

/**
 * Returns whether a declaration is a provider-hosted search tool.
 *
 * Client-side tools such as Codex's plain `WebSearch` name are not hosted
 * declarations and must pass through untouched.
 */
export function isWebSearchTool(
  tool: Pick<ToolDefinition, "name" | "native_type" | "tool_type">,
): boolean {
  if (tool.native_type?.startsWith("web_search_") === true) return true;
  return tool.tool_type === "web_search";
}
