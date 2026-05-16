import { z } from "zod";

/**
 * Operational tunables only. NO required env vars — instagram-mcp-buddy boots
 * fine with nothing set and bootstraps OAuth on first `instagram_connect`.
 */
const ConfigSchema = z.object({
  IG_GRAPH_API_VERSION: z.string().default("v21.0"),
  IG_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  IG_REEL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  IG_IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    // Should be impossible — every field has a default. Log and use defaults.
    process.stderr.write(
      `instagram-mcp-buddy: ignoring malformed env var: ${result.error.message}\n`,
    );
    return ConfigSchema.parse({});
  }
  return result.data;
}
