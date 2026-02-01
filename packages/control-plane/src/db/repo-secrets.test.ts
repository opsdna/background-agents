import { beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { RepoSecretsStore, RepoSecretsValidationError } from "./repo-secrets";
import { generateEncryptionKey } from "../auth/crypto";

if (!globalThis.crypto) {
  // @ts-expect-error - webcrypto assignment for tests
  globalThis.crypto = webcrypto;
}

type RepoSecretRow = {
  repo_id: number;
  repo_owner: string;
  repo_name: string;
  key: string;
  encrypted_value: string;
  created_at: number;
  updated_at: number;
};

class FakeD1Database {
  private rows = new Map<string, RepoSecretRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  all(query: string, args: unknown[]) {
    if (query.includes("SELECT key FROM repo_secrets")) {
      const repoId = args[0] as number;
      return Array.from(this.rows.values())
        .filter((row) => row.repo_id === repoId)
        .map((row) => ({ key: row.key }));
    }

    if (query.includes("SELECT key, created_at, updated_at FROM repo_secrets")) {
      const repoId = args[0] as number;
      return Array.from(this.rows.values())
        .filter((row) => row.repo_id === repoId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((row) => ({
          key: row.key,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
    }

    if (query.includes("SELECT key, encrypted_value FROM repo_secrets")) {
      const repoId = args[0] as number;
      return Array.from(this.rows.values())
        .filter((row) => row.repo_id === repoId)
        .map((row) => ({ key: row.key, encrypted_value: row.encrypted_value }));
    }

    throw new Error(`Unexpected query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    if (query.includes("INSERT INTO repo_secrets")) {
      const [repoId, repoOwner, repoName, key, encryptedValue, createdAt, updatedAt] = args as [
        number,
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      const rowKey = `${repoId}:${key}`;
      const existing = this.rows.get(rowKey);
      const created_at = existing ? existing.created_at : createdAt;
      this.rows.set(rowKey, {
        repo_id: repoId,
        repo_owner: repoOwner,
        repo_name: repoName,
        key,
        encrypted_value: encryptedValue,
        created_at,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (query.includes("DELETE FROM repo_secrets")) {
      const [repoId, key] = args as [number, string];
      const rowKey = `${repoId}:${key}`;
      const existed = this.rows.delete(rowKey);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    throw new Error(`Unexpected query: ${query}`);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("RepoSecretsStore", () => {
  let db: FakeD1Database;
  let store: RepoSecretsStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new RepoSecretsStore(db as unknown as D1Database, generateEncryptionKey());
  });

  it("encrypts and decrypts values", async () => {
    await store.setSecrets(1, "Owner", "Repo", { FOO: "bar" });
    const secrets = await store.getDecryptedSecrets(1);
    expect(secrets).toEqual({ FOO: "bar" });
  });

  it("normalizes keys and updates existing secrets", async () => {
    const first = await store.setSecrets(1, "Owner", "Repo", { foo: "one" });
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);

    const second = await store.setSecrets(1, "Owner", "Repo", { FOO: "two" });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const secrets = await store.getDecryptedSecrets(1);
    expect(secrets).toEqual({ FOO: "two" });
  });

  it("rejects reserved keys", async () => {
    await expect(store.setSecrets(1, "Owner", "Repo", { PATH: "nope" })).rejects.toBeInstanceOf(
      RepoSecretsValidationError
    );
  });

  it("rejects invalid key patterns", async () => {
    await expect(store.setSecrets(1, "Owner", "Repo", { "1BAD": "nope" })).rejects.toBeInstanceOf(
      RepoSecretsValidationError
    );
  });

  it("enforces value size limits", async () => {
    const bigValue = "a".repeat(16385);
    await expect(store.setSecrets(1, "Owner", "Repo", { BIG: bigValue })).rejects.toBeInstanceOf(
      RepoSecretsValidationError
    );
  });

  it("enforces total size limits", async () => {
    const largeA = "a".repeat(40000);
    const largeB = "b".repeat(30000);
    await expect(
      store.setSecrets(1, "Owner", "Repo", { A: largeA, B: largeB })
    ).rejects.toBeInstanceOf(RepoSecretsValidationError);
  });

  it("enforces per-repo secret limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      many[`KEY_${i}`] = "x";
    }
    await store.setSecrets(1, "Owner", "Repo", many);

    await expect(store.setSecrets(1, "Owner", "Repo", { EXTRA: "y" })).rejects.toBeInstanceOf(
      RepoSecretsValidationError
    );
  });

  it("lists keys with metadata", async () => {
    await store.setSecrets(1, "Owner", "Repo", { ALPHA: "1", BETA: "2" });
    const keys = await store.listSecretKeys(1);
    expect(keys.map((k) => k.key)).toEqual(["ALPHA", "BETA"]);
    expect(keys[0].createdAt).toBeTypeOf("number");
  });

  it("deletes secrets by key", async () => {
    await store.setSecrets(1, "Owner", "Repo", { ALPHA: "1" });
    const deleted = await store.deleteSecret(1, "alpha");
    expect(deleted).toBe(true);
    const secrets = await store.getDecryptedSecrets(1);
    expect(secrets).toEqual({});
  });
});
