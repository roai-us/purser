import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./store.js";

export interface ConnectorTest {
  ok: boolean;
  at: string;
  latencyMs?: number | undefined;
  error?: string | undefined;
  /** The provider said this key is no good, so nobody can use it. */
  rejected?: boolean | undefined;
}

/** A replaced key. Only its hint is kept, never the key. */
export interface OldKey {
  hint: string;
  replacedAt: string;
}

export interface VaultEntry {
  apiKey?: string | undefined;
  /** For connectors whose upstream differs per customer, such as an Azure resource URL. */
  upstream?: string | undefined;
  updatedAt?: string | undefined;
  lastTest?: ConnectorTest | undefined;
  /** Keys replaced here that someone still has to delete at the provider. */
  oldKeys?: OldKey[] | undefined;
}

/**
 * Provider keys set through the admin API. Kept in `<dataDir>/vault.json`,
 * readable only by the user who runs Purser, and replaced in one step on each
 * write. The desktop app will keep them in the operating system's keychain
 * instead. Without a data directory the vault lives in memory only.
 */
export class Vault {
  private entries: Record<string, VaultEntry> = {};

  constructor(private readonly dataDir: string | null = null) {
    if (dataDir) {
      const file = join(dataDir, "vault.json");
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          providers?: Record<string, VaultEntry>;
        };
        this.entries = parsed.providers ?? {};
      }
    }
  }

  get(id: string): VaultEntry | undefined {
    return this.entries[id];
  }

  set(id: string, patch: VaultEntry): VaultEntry {
    const next = { ...this.entries[id], ...patch };
    this.entries[id] = next;
    this.save();
    return next;
  }

  /** Forgets the stored key, keeping any upstream URL. */
  removeKey(id: string): void {
    const entry = this.entries[id];
    if (!entry) return;
    const { apiKey: _apiKey, lastTest: _lastTest, ...rest } = entry;
    this.entries[id] = rest;
    this.save();
  }

  private save(): void {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    writeAtomic(
      join(this.dataDir, "vault.json"),
      JSON.stringify({ providers: this.entries }, null, 2),
    );
  }
}
