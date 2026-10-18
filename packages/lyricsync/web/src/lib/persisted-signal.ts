// packages/lyricsync/web/src/lib/persisted-signal.ts
// LocalStorage-backed reactive signals in SolidJS without external dependencies.
import { createSignal, type Setter, type Signal } from "solid-js";

export function persistedSignal<T>(key: string, initialValue: T, options?: {
  serialize?: (v: T) => string;
  deserialize?: (raw: string) => T;
}): Signal<T> {
  const serialize = options?.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize = (raw: string): T => {
    try {
      return options?.deserialize ? options.deserialize(raw) : (JSON.parse(raw) as T);
    } catch {
      return initialValue;
    }
  };
  const stored = typeof window !== "undefined" ? localStorage.getItem(key) : null;
  const initial = stored !== null ? deserialize(stored) : initialValue;
  const [val, setVal] = createSignal<T>(initial);

  // Persist on write. A createEffect would need a reactive owner; these signals are created at module scope.
  const persist = (...args: Parameters<Setter<T>>) => {
    const next = setVal(...args);
    try {
      localStorage.setItem(key, serialize(next));
    } catch {
      // quota exceeded / private mode
    }
    return next;
  };

  return [val, persist as Setter<T>]; // Setter<T> is an overload set no single function signature satisfies
}

export function parsePersistedId<T extends string>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? (parsed as T) : fallback;
  } catch {
    return raw ? (raw as T) : fallback;
  }
}

export function parsePersistedString(raw: string, fallback: string): string {
  return parsePersistedId(raw, fallback);
}
