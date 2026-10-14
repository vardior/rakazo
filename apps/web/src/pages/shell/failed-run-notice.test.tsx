// @vitest-environment jsdom

import type { ThreadMessage } from "@rakazo/contracts";
import { canRetryFailedRun } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { FailedRunNotice } from "./message-cards";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/rpc", () => ({ rpc: { threads: { retry: vi.fn() } } }));

it("renders the durable notice and retries once, hiding Retry after newer requests", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const message: ThreadMessage = {
    id: "notice",
    threadId: "thread",
    role: "bot",
    botId: "bot",
    runId: "run",
    seq: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    blocks: [
      {
        kind: "text",
        text: "I didn't finish because the connection dropped.",
        runFailure: { runId: "run" },
      },
    ],
  };
  const block = message.blocks[0];
  if (block?.kind !== "text") throw new Error("Expected a text notice");
  const container = document.createElement("div");
  const root = createRoot(container);
  const refresh = vi.fn(async () => undefined);
  let resolve!: () => void;
  vi.mocked(rpc.threads.retry).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = () => done({ taskId: "retry-task", runId: "retry-run" });
      }),
  );
  try {
    act(() =>
      root.render(
        <FailedRunNotice
          target={{ botId: "bot" }}
          block={block}
          canRetry={canRetryFailedRun(message, [message])}
          onRefresh={refresh}
        />,
      ),
    );
    expect(container.textContent).toContain(block.text);
    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Retry");
    await act(async () => {
      retry?.click();
    });
    expect(retry?.disabled).toBe(true);
    expect(rpc.threads.retry).toHaveBeenCalledWith({ botId: "bot", runId: "run" });
    await act(async () => {
      resolve();
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(container.querySelector("button")).toBeNull();
    expect(canRetryFailedRun(message, [message, { ...message, role: "user", seq: 3 }])).toBe(false);
    expect(canRetryFailedRun(message, [message], ["bot"])).toBe(false);
    expect(canRetryFailedRun(message, [message], ["other-bot"])).toBe(true);
    expect(
      canRetryFailedRun(
        { ...message, blocks: [{ ...block, runFailure: { runId: "run", retried: true } }] },
        [message],
      ),
    ).toBe(false);
    expect(canRetryFailedRun(message, [message, { ...message, botId: "other-bot", seq: 3 }])).toBe(
      true,
    );
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the notice and Retry available when the RPC fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.threads.retry).mockRejectedValue(new Error("Could not retry"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <FailedRunNotice
          target={{ groupId: "group" }}
          block={{
            kind: "text",
            text: "I didn't finish because the connection dropped.",
            runFailure: { runId: "run" },
          }}
          canRetry
          onRefresh={async () => undefined}
        />,
      ),
    );
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not retry");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(rpc.threads.retry).toHaveBeenLastCalledWith({ groupId: "group", runId: "run" });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
