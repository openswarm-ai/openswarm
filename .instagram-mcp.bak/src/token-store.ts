import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

export interface StoredToken {
  access_token: string;
  user_id: string;
  /** Unix epoch ms when the token expires. */
  expires_at: number;
  /** Unix epoch ms when the token was last obtained or refreshed. */
  obtained_at: number;
  /** Scopes granted by the user. */
  granted_scopes: string[];
}

export interface TokenStore {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
  clear(): Promise<void>;
  /** For logging/UX so users know where their token sits. */
  describe(): string;
}

const SERVICE = "instagram-mcp-buddy";
const ACCOUNT = "default";

/* -------------------------------------------------------------------------- */
/* OS keychain (preferred)                                                    */
/* -------------------------------------------------------------------------- */

class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly keytar: {
      getPassword: (s: string, a: string) => Promise<string | null>;
      setPassword: (s: string, a: string, p: string) => Promise<void>;
      deletePassword: (s: string, a: string) => Promise<boolean>;
    },
  ) {}

  async load(): Promise<StoredToken | null> {
    const raw = await this.keytar.getPassword(SERVICE, ACCOUNT);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      log.warn("token_store_parse_failed", { backend: "keychain" });
      return null;
    }
  }

  async save(token: StoredToken): Promise<void> {
    await this.keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify(token));
  }

  async clear(): Promise<void> {
    await this.keytar.deletePassword(SERVICE, ACCOUNT);
  }

  describe(): string {
    return "OS keychain";
  }
}

async function tryLoadKeytar(): Promise<KeychainTokenStore | null> {
  try {
    const mod = (await import("keytar")) as unknown as {
      default?: {
        getPassword: (s: string, a: string) => Promise<string | null>;
        setPassword: (s: string, a: string, p: string) => Promise<void>;
        deletePassword: (s: string, a: string) => Promise<boolean>;
      };
      getPassword?: (s: string, a: string) => Promise<string | null>;
      setPassword?: (s: string, a: string, p: string) => Promise<void>;
      deletePassword?: (s: string, a: string) => Promise<boolean>;
    };
    const api = mod.default ?? mod;
    if (
      typeof api.getPassword !== "function" ||
      typeof api.setPassword !== "function" ||
      typeof api.deletePassword !== "function"
    ) {
      return null;
    }
    // Smoke-test that the native binding actually works on this host.
    await api.getPassword(SERVICE, ACCOUNT);
    return new KeychainTokenStore(
      api as {
        getPassword: (s: string, a: string) => Promise<string | null>;
        setPassword: (s: string, a: string, p: string) => Promise<void>;
        deletePassword: (s: string, a: string) => Promise<boolean>;
      },
    );
  } catch (err) {
    log.info("token_store_keychain_unavailable", {
      reason: (err as Error).message,
    });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Encrypted file (fallback)                                                  */
/* -------------------------------------------------------------------------- */

/** Hard-coded salt — security here comes from machine-id + file location. */
const FILE_SALT = "instagram-mcp-buddy:v1:salt";
const ALGO = "aes-256-gcm";

export class EncryptedFileTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly keyProvider: () => Promise<Buffer>,
  ) {}

  async load(): Promise<StoredToken | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const { iv, tag, ciphertext } = JSON.parse(raw) as {
        iv: string;
        tag: string;
        ciphertext: string;
      };
      const key = await this.keyProvider();
      const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as StoredToken;
    } catch (err) {
      log.warn("token_store_decrypt_failed", { reason: (err as Error).message });
      return null;
    }
  }

  async save(token: StoredToken): Promise<void> {
    const key = await this.keyProvider();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(token), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify({
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      { mode: 0o600 },
    );
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  describe(): string {
    return `encrypted file at ${this.filePath}`;
  }
}

function defaultDataDir(): string {
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, "instagram-mcp-buddy");
  }
  if (platform() === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "instagram-mcp-buddy",
    );
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "instagram-mcp-buddy");
  }
  return join(homedir(), ".local", "share", "instagram-mcp-buddy");
}

async function deriveMachineKey(): Promise<Buffer> {
  let machineId = "unknown";
  try {
    const mod = await import("node-machine-id");
    machineId = await mod.machineId();
  } catch (err) {
    log.warn("machine_id_fallback", { reason: (err as Error).message });
  }
  return createHash("sha256").update(`${FILE_SALT}:${machineId}`).digest();
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateTokenStoreOpts {
  /** Override file path (tests). */
  filePath?: string;
  /** Force the file backend even if keytar is available (tests). */
  forceFile?: boolean;
  /** Override the key derivation (tests). */
  keyProvider?: () => Promise<Buffer>;
}

export async function createTokenStore(
  opts: CreateTokenStoreOpts = {},
): Promise<TokenStore> {
  if (!opts.forceFile) {
    const kc = await tryLoadKeytar();
    if (kc) {
      log.debug("token_store_backend", { backend: "keychain" });
      return kc;
    }
  }
  const filePath = opts.filePath ?? join(defaultDataDir(), "token.json");
  const keyProvider = opts.keyProvider ?? deriveMachineKey;
  log.debug("token_store_backend", { backend: "encrypted_file", filePath });
  return new EncryptedFileTokenStore(filePath, keyProvider);
}
