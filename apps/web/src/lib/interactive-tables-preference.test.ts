import { afterEach, describe, expect, it, vi } from "vitest";

describe("web interactive tables preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders standard tables until the reader turns interactive tables on", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    const {
      INTERACTIVE_TABLES_STORAGE_KEY,
      getInteractiveTablesEnabled,
      setInteractiveTablesEnabled,
      subscribeInteractiveTables,
    } = await import("./interactive-tables-preference");
    expect(getInteractiveTablesEnabled()).toBe(false);

    const listener = vi.fn();
    subscribeInteractiveTables(listener);
    setInteractiveTablesEnabled(true);
    expect(getInteractiveTablesEnabled()).toBe(true);
    expect(store.get(INTERACTIVE_TABLES_STORAGE_KEY)).toBe("on");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("reads a saved choice", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "on",
      setItem: () => {},
    });
    const { getInteractiveTablesEnabled } = await import("./interactive-tables-preference");
    expect(getInteractiveTablesEnabled()).toBe(true);
  });
});
