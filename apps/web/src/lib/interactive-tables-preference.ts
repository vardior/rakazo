export const INTERACTIVE_TABLES_STORAGE_KEY = "rakazo.interactiveTables";

const listeners = new Set<() => void>();
let memoryPreference: boolean | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readStored(): boolean {
  try {
    return (
      getLocalStorage()?.getItem(INTERACTIVE_TABLES_STORAGE_KEY)?.trim().toLowerCase() === "on"
    );
  } catch {
    return false;
  }
}

export function getInteractiveTablesEnabled(): boolean {
  return memoryPreference ?? readStored();
}

export function setInteractiveTablesEnabled(enabled: boolean): boolean {
  memoryPreference = enabled;
  try {
    getLocalStorage()?.setItem(INTERACTIVE_TABLES_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Ignore quota / private-mode failures; the in-memory preference still applies.
  }
  for (const listener of listeners) listener();
  return enabled;
}

export function subscribeInteractiveTables(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
