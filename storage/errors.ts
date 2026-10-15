import { messages } from "../locales/en.ts";

const descriptions = {
  unavailable: messages.storageFailed,
  corrupt: messages.storageCorrupt,
  lock_release: messages.storageLockRelease,
  indeterminate: messages.storageIndeterminate,
} as const;

export class StorageError extends Error {
  readonly code: keyof typeof descriptions;
  readonly operationCompleted: boolean | "unknown";
  readonly committed: boolean | "unknown";
  constructor(code: keyof typeof descriptions, completed?: "read" | "write") {
    super(completed === "write" ? messages.storageSavedButLocked : descriptions[code]);
    this.name = "StorageError";
    this.code = code;
    this.operationCompleted = code === "indeterminate" ? "unknown" : completed !== undefined;
    this.committed = code === "indeterminate" ? "unknown" : completed === "write";
  }
}

export function cancellationError(): DOMException {
  return new DOMException(messages.storageCancelled, "AbortError");
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A user-facing validation failure raised by a transaction callback; nothing was committed. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}
