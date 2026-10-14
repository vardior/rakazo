// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FailedRunNotice } from "../components/failed-run-notice";
import { rpc } from "./api";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ActivityIndicator: () => null,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      children,
    ),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => tokensForAppearance("light"),
  native: { label: tokensForAppearance("light").foreground },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./api", () => ({ rpc: vi.fn() }));

it("attributes the failure to the bot and runs the same Retry RPC on mobile", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockResolvedValue({ taskId: "retry-task", runId: "retry-run" });
  vi.mocked(rpc).mockRejectedValueOnce(new Error("Could not retry"));
  const container = document.createElement("div");
  const root = createRoot(container);
  const refresh = vi.fn(async () => undefined);
  const block = {
    kind: "text" as const,
    text: "I didn't finish because the model provider is unavailable.",
    runFailure: { runId: "run" },
  };
  try {
    act(() =>
      root.render(
        <FailedRunNotice
          target={{ botId: "bot" }}
          block={block}
          speaker="Writer"
          canRetry
          onRefresh={refresh}
        />,
      ),
    );
    expect(container.textContent).toContain("Writer");
    expect(container.textContent).toContain(block.text);
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Retry");
    await act(async () => {
      button?.click();
    });
    expect(container.textContent).toContain("Could not retry");
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button?.click();
    });
    expect(rpc).toHaveBeenCalledWith("threads/retry", { botId: "bot", runId: "run" });
    expect(refresh).toHaveBeenCalledOnce();
    expect(container.querySelector("button")).toBeNull();
    act(() =>
      root.render(
        <FailedRunNotice
          target={{ botId: "bot" }}
          block={block}
          speaker="Writer"
          canRetry={false}
          onRefresh={refresh}
        />,
      ),
    );
    expect(container.textContent).toContain(block.text);
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
