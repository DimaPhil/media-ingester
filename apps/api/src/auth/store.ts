/** All expirations are Unix milliseconds. `take` MUST atomically read and delete. */
export interface AuthStore {
  put(key: string, value: unknown, expiresAt: number): Promise<void>;
  get(key: string): Promise<unknown | null>;
  take(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}

/** For tests and one-process embedding; production uses durable PostgreSQL storage. */
export class MemoryAuthStore implements AuthStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(key: string, value: unknown, expiresAt: number): Promise<void> {
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(entryKey);
    }
    this.entries.set(key, { value: structuredClone(value), expiresAt });
  }

  async get(key: string): Promise<unknown | null> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(entry.value);
  }

  async take(key: string): Promise<unknown | null> {
    // No await between inspection and deletion: atomic within this process.
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry && entry.expiresAt > this.now() ? structuredClone(entry.value) : null;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
