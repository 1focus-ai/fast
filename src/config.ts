import { parse as parseToml } from "@iarna/toml"
import { promises as fs } from "node:fs"
import path from "node:path"

export const ONE_F_CONFIG_FILENAME = "1f.toml"

export interface OneFAppConfig {
  name?: string
  description?: string
  version?: string
}

export interface OneFSecretConfig {
  label?: string
  required?: boolean
  description?: string
  default?: string
}

export interface OneFTaskConfig {
  desc?: string
  silent?: boolean
  cmds?: string[]
}

export interface OneFConfig {
  app?: OneFAppConfig
  secrets?: Record<string, OneFSecretConfig>
  tasks?: Record<string, OneFTaskConfig>
}

type ConfigCache = {
  cwd: string
  value: OneFConfig | null
}

let configCache: ConfigCache | null = null

export function clearOneFConfigCache() {
  configCache = null
}

export function parseOneFConfig(rawToml: string): OneFConfig {
  const parsed = parseToml(rawToml) as unknown
  return normalizeOneFConfig(parsed)
}

export async function loadOneFConfig(options?: {
  cwd?: string
  useCache?: boolean
}): Promise<OneFConfig | null> {
  const cwd = options?.cwd ?? process.cwd()
  const useCache = options?.useCache ?? cwd === process.cwd()

  if (useCache && configCache && configCache.cwd === cwd) {
    return configCache.value
  }

  const configPath = path.join(cwd, ONE_F_CONFIG_FILENAME)
  try {
    const raw = await fs.readFile(configPath, "utf8")
    const config = parseOneFConfig(raw)
    if (useCache) {
      configCache = { cwd, value: config }
    }
    return config
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (useCache) {
        configCache = { cwd, value: null }
      }
      return null
    }
    throw error
  }
}

export function normalizeOneFConfig(config: unknown): OneFConfig {
  if (!config || typeof config !== "object") {
    throw new Error(`Invalid ${ONE_F_CONFIG_FILENAME}: expected an object`)
  }
  const typed = config as Record<string, unknown>
  return {
    app:
      typeof typed.app === "object" && typed.app !== null
        ? (typed.app as OneFAppConfig)
        : undefined,
    secrets:
      typeof typed.secrets === "object" && typed.secrets !== null
        ? (typed.secrets as Record<string, OneFSecretConfig>)
        : undefined,
    tasks:
      typeof typed.tasks === "object" && typed.tasks !== null
        ? (typed.tasks as Record<string, OneFTaskConfig>)
        : undefined,
  }
}
