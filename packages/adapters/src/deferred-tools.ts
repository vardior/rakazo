import type { ConnectorTool } from "@rakazo/adapter-kit";
import { CORE_BUILTIN_TOOL_NAMES, deferredToolControls } from "./builtin-tools.js";

export function canonicalToolJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalToolJson(item)]),
    );
  }
  return value;
}

export function splitDeferredTools(authorizedTools: readonly ConnectorTool[]) {
  const ordered = authorizedTools
    .map((tool) => canonicalToolJson(tool) as ConnectorTool)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const core = ordered.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
  const deferredTools = ordered.filter((tool) => !CORE_BUILTIN_TOOL_NAMES.has(tool.name));
  return {
    tools:
      deferredTools.length > 0
        ? [...core, ...deferredToolControls(deferredTools.map((tool) => tool.name))]
        : core,
    deferredTools,
  };
}

export function findDeferredTools(tools: readonly ConnectorTool[], query: string) {
  const keywords = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const matches = tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = keywords.reduce(
        (total, word) => total + (name.includes(word) ? 3 : description.includes(word) ? 1 : 0),
        0,
      );
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.tool.name < right.tool.name
          ? -1
          : left.tool.name > right.tool.name
            ? 1
            : 0,
    )
    .slice(0, 5)
    .map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  return matches.length > 0
    ? { tools: matches }
    : {
        tools: [],
        message: "No matching deferred tools. Search using one of the available names.",
        names: tools.map((tool) => tool.name).sort(),
      };
}

export function resolveDeferredToolCall(
  tools: readonly ConnectorTool[],
  args: Record<string, unknown>,
):
  | { tool: ConnectorTool; args: Record<string, unknown> }
  | { error: string; inputSchema?: Record<string, unknown> } {
  const tool = tools.find((candidate) => candidate.name === args.name);
  if (!tool) return { error: "Unknown or non-deferred tool. Use find_tools to find a tool." };
  if (!args.args || typeof args.args !== "object" || Array.isArray(args.args)) {
    return { error: "Tool args must be an object.", inputSchema: tool.inputSchema };
  }
  return { tool, args: args.args as Record<string, unknown> };
}
