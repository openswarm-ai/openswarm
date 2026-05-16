import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EncryptedFileTokenStore,
  type StoredToken,
  createTokenStore,
} from "../src/token-store.js";

function fixedKey(): Promise<Buffer> {
  return Promise.resolve(Buffer.alloc(32, 7));
}

function sampleToken(): StoredToken {
  return {
    access_token: "IGQVJ.fake.long.lived.token",
    user_id: "17841400000000000",
    expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
    obtained_at: Date.now(),
    granted_scopes: [
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ],
  };
}

describe("EncryptedFileTokenStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "imb-tokenstore-"));
    path = join(dir, "token.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a stored token", async () => {
    const store = new EncryptedFileTokenStore(path, fixedKey);
    const token = sampleToken();
    await store.save(token);
    const loaded = await store.load();
    expect(loaded).toEqual(token);
  });

  it("returns null when no file exists", async () => {
    const store = new EncryptedFileTokenStore(path, fixedKey);
    expect(await store.load()).toBeNull();
  });

  it("clear() removes the file", async () => {
    const store = new EncryptedFileTokenStore(path, fixedKey);
    await store.save(sampleToken());
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("returns null when decrypted with wrong key", async () => {
    const store = new EncryptedFileTokenStore(path, fixedKey);
    await store.save(sampleToken());
    const otherKey = () => Promise.resolve(Buffer.alloc(32, 9));
    const wrong = new EncryptedFileTokenStore(path, otherKey);
    expect(await wrong.load()).toBeNull();
  });

  it("describe() points at the on-disk path", () => {
    const store = new EncryptedFileTokenStore(path, fixedKey);
    expect(store.describe()).toContain(path);
  });
});

describe("createTokenStore factory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "imb-factory-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to encrypted file when forceFile=true", async () => {
    const store = await createTokenStore({
      forceFile: true,
      filePath: join(dir, "token.json"),
      keyProvider: fixedKey,
    });
    expect(store.describe()).toContain("encrypted file");
    await store.save(sampleToken());
    const loaded = await store.load();
    expect(loaded?.user_id).toBe("17841400000000000");
  });
});
