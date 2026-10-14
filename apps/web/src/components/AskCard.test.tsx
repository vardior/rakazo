// @vitest-environment jsdom

import { selectedAskActionLabel } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { AskCard } from "./AskCard";

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("protected login card", () => {
  it.each([undefined, "User code"])(
    "shows only requested fields and clears them on submit (%s)",
    async (extraFieldLabel) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const onAnswer = vi.fn().mockRejectedValue(new Error("fake-extra-code"));
      try {
        await act(async () =>
          root.render(
            <AskCard
              block={{
                kind: "ask",
                text: "Save login",
                input: "secret",
                purpose: "password",
                status: "pending",
                credential: {
                  name: "site_login",
                  origin: "https://login.example.test",
                  auth: { type: "login", ...(extraFieldLabel ? { extraFieldLabel } : {}) },
                },
              }}
              canAnswer
              onAnswer={onAnswer}
            />,
          ),
        );
        expect(container.querySelectorAll("input")).toHaveLength(extraFieldLabel ? 3 : 2);
        const type = async (label: string, value: string) => {
          const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
          await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
              input,
              value,
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
        };
        await type("Username", " fake-user ");
        await type("Password", "fake-password");
        const button = container.querySelector("button")!;
        if (extraFieldLabel) {
          const extraInput = container.querySelector<HTMLInputElement>(
            'input[aria-label="User code"]',
          )!;
          expect(extraInput.type).toBe("password");
          expect(extraInput.autocomplete).toBe("off");
          expect(button.disabled).toBe(true);
          await type("User code", "fake-extra-code");
        }
        await act(async () => button.click());
        expect(onAnswer).toHaveBeenCalledWith(
          "fake-password",
          "fake-user",
          extraFieldLabel ? "fake-extra-code" : undefined,
        );
        for (const input of container.querySelectorAll("input")) expect(input.value).toBe("");
        expect(container.textContent).toContain("Could not submit this answer");
        expect(container.innerHTML).not.toContain("fake-extra-code");
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
