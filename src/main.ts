#!/usr/bin/env bun

import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { streamText } from "ai"
import { openai } from "@ai-sdk/openai"
import type { Logger } from "1focus"
import { startChatInterface } from "./chat-tui.tsx"
import {
  loadOneFConfig,
  ONE_F_CONFIG_FILENAME,
  type OneFAppConfig,
  type OneFConfig,
  type OneFSecretConfig,
  type OneFTaskConfig,
} from "./config.ts"

type CommandHandler = () => Promise<void>

type CommandCatalogEntry = {
  name: string
  description: string
}

type CommandPaletteResult =
  | { kind: "command"; args: string[] }
  | { kind: "cancel"; code: number }
  | { kind: "fallback" }

const execFileAsync = promisify(execFile)
const FLOW_VERSION = "1.0.0"
const DEFAULT_COMMAND_NAME = "fast"
const DEFAULT_SUMMARY = "fast is CLI to move faster in software projects"
const COMMIT_MODEL_NAME = "openai/gpt-5.1-instant"
const CHAT_MODEL_NAME = "gpt-4.1-mini"
const CHAT_SYSTEM_PROMPT =
  "You are the fast CLI assistant. Help users move faster in their projects with concise, actionable answers."
const MAX_COMMIT_DIFF_CHARS = 12_000
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
const BLADE_DB_RELATIVE_PATH = path.join(
  ".blade",
  "state",
  "databases",
  "main",
  "db.sqlite"
)
const TABLEPLUS_APP = "TablePlus"
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 50
const TELEMETRY_DEBUG_FLAG = (
  process.env.FLOW_TELEMETRY_DEBUG ?? ""
).toLowerCase()
const TELEMETRY_DEBUG_ENABLED =
  TELEMETRY_DEBUG_FLAG === "1" || TELEMETRY_DEBUG_FLAG === "true"

let commandName = DEFAULT_COMMAND_NAME
let commandSummary = DEFAULT_SUMMARY
let cachedOpenAIKey = ""
let telemetryLogger: Logger | undefined
let telemetryNoticeShown = false
let reportedVersion = FLOW_VERSION
type OneFocusModule = typeof import("1focus")
let createLoggerFactory: OneFocusModule["createLogger"] | null = null

const commandRegistry = new Map<string, CommandHandler>()
const commandCatalog: CommandCatalogEntry[] = [
  { name: "help", description: "Help about any command" },
]

function lookupNonEmptyEnv(key: string) {
  const raw = process.env[key]
  if (!raw) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function applyCommandIdentity(
  candidate: string | undefined,
  summaryLocked: boolean
) {
  if (!candidate) return
  const trimmed = candidate.trim()
  if (!trimmed) return

  const base =
    path.basename(trimmed).replace(path.extname(trimmed), "") || trimmed
  commandName = base
  if (!summaryLocked) {
    commandSummary = `${base} is CLI to move faster in software projects`
  }
}

type IdentityLocks = {
  nameLocked: boolean
  summaryLocked: boolean
}

function configureCommandIdentity(): IdentityLocks {
  const summary = lookupNonEmptyEnv("FLOW_COMMAND_SUMMARY")
  const summaryLocked = Boolean(summary)
  if (summary) {
    commandSummary = summary
  }

  const name = lookupNonEmptyEnv("FLOW_COMMAND_NAME")
  const nameLocked = Boolean(name)
  if (name) {
    applyCommandIdentity(name, summaryLocked)
    return { nameLocked, summaryLocked }
  }

  applyCommandIdentity(process.argv[1] ?? DEFAULT_COMMAND_NAME, summaryLocked)
  return { nameLocked: false, summaryLocked }
}

function applyAppMetadata(
  app: OneFAppConfig | undefined,
  locks: IdentityLocks
) {
  if (!app) return
  const appName = typeof app.name === "string" ? app.name.trim() : undefined
  const appDescription =
    typeof app.description === "string" ? app.description.trim() : undefined

  if (appName && !locks.nameLocked) {
    applyCommandIdentity(
      appName,
      locks.summaryLocked || Boolean(appDescription)
    )
  }

  if (!locks.summaryLocked) {
    if (appDescription) {
      commandSummary = appDescription
    } else if (appName) {
      commandSummary = `${appName} is CLI to move faster in software projects`
    }
  }

  if (typeof app.version === "string" && app.version.trim()) {
    reportedVersion = app.version.trim()
  }
}

async function initializeTelemetry() {
  try {
    const createLogger = await ensureCreateLogger()
    telemetryLogger = createLogger({
      metadata: {
        cli: commandName,
        version: FLOW_VERSION,
      },
    })
  } catch (error) {
    handleTelemetryFailure(error)
  }
}

function registerCommand(
  name: string,
  description: string,
  handler: CommandHandler
) {
  commandCatalog.push({ name, description })
  commandRegistry.set(name, () => executeCommandWithTelemetry(name, handler))
}

async function executeCommandWithTelemetry(
  name: string,
  handler: CommandHandler
) {
  const startedAt = Date.now()
  trackTelemetry("info", "command_start", { command: name })
  try {
    await handler()
    trackTelemetry("info", "command_success", {
      command: name,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    trackTelemetry("error", "command_failure", {
      command: name,
      durationMs: Date.now() - startedAt,
      error: serializeErrorForTelemetry(error),
    })
    throw error
  }
}

async function main() {
  const identityLocks = configureCommandIdentity()
  await initializeTelemetry()
  trackTelemetry("info", "cli_invocation", {
    args: process.argv.slice(2),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  })

  registerCommand(
    "commit",
    "Generate a commit message with GPT-5 nano, create the commit, and push it",
    async () => runCommitPushWorkflow("commit")
  )
  registerCommand(
    "commitPush",
    "Generate a commit message with GPT-5 nano, create the commit, and push it",
    async () => runCommitPushWorkflow("commitPush")
  )
  registerCommand(
    "dbOpen",
    "Open the project SQLite database in TablePlus",
    runDBOpen
  )
  registerCommand(
    "dbClear",
    "Remove all data from the project SQLite database",
    runDBClear
  )
  registerCommand(
    "update",
    "Update dependencies (bun) and pull latest git changes",
    runUpdate
  )
  registerCommand(
    "setup",
    "Validate required secrets and run the setup task from 1f.toml",
    runSetup
  )
  registerCommand("tasks", "List tasks defined in 1f.toml", runTasksList)
  registerCommand(
    "test",
    "Fuzzy select a test file under tests/ then run bun --watch",
    runTestWatch
  )
  registerCommand(
    "chat",
    "Open a ChatGPT-like TUI for quick requests",
    runChatTui
  )
  registerCommand("version", "Print the current fast release", async () => {
    console.log(reportedVersion)
  })

  const config = await loadOneFConfig()
  applyAppMetadata(config?.app, identityLocks)
  registerConfigTasks(config)

  let args = process.argv.slice(2)

  if (args.length === 0) {
    const selection = await selectCommandArgs()
    if (selection.kind === "command") {
      args = selection.args
    } else if (selection.kind === "cancel") {
      if (selection.code !== 0) {
        process.exit(selection.code)
      }
      return
    } else {
      printRootHelp()
      return
    }
  }

  if (handleTopLevel(args)) {
    return
  }

  const commandKey = args[0]
  if (!commandKey) {
    printRootHelp()
    return
  }
  const handler = commandRegistry.get(commandKey)
  if (!handler) {
    trackTelemetry("warn", "command_not_found", { command: commandKey })
    console.error(`Unknown command: ${commandKey}`)
    printRootHelp()
    process.exit(1)
  }

  if (args.includes("--help") || args.includes("-h")) {
    if (!printCommandHelp(commandKey)) {
      printRootHelp()
    }
    return
  }

  try {
    await handler()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

function handleTopLevel(args: string[]) {
  if (args.length === 0) {
    printRootHelp()
    return true
  }

  const primary = args[0]
  if (!primary) {
    printRootHelp()
    return true
  }

  switch (primary) {
    case "--help":
    case "-h":
    case "h":
      printRootHelp()
      return true
    case "--version":
      console.log(reportedVersion)
      return true
    case "help": {
      if (args.length === 1) {
        printRootHelp()
        return true
      }
      const topic = args[1]
      if (!topic) {
        printRootHelp()
        return true
      }
      if (printCommandHelp(topic)) {
        return true
      }
      console.error(`Unknown help topic ${JSON.stringify(topic)}`)
      return true
    }
  }

  if (args.length > 1) {
    const last = args[args.length - 1]
    if (last === "--help" || last === "-h") {
      if (printCommandHelp(primary)) {
        return true
      }
      printRootHelp()
      return true
    }
  }

  return false
}

function printCommandHelp(name: string) {
  switch (name) {
    case "help":
      console.log("Help about any command\n")
      console.log("Usage:")
      console.log(`  ${commandName} help [command]`)
      return true
    case "commit":
    case "commitPush":
      console.log(
        "Generate a commit message with GPT-5 nano, create the commit, and push it\n"
      )
      console.log("Usage:")
      console.log(`  ${commandName} ${name}`)
      return true
    case "dbOpen":
      console.log("Open the project SQLite database in TablePlus\n")
      console.log("Usage:")
      console.log(`  ${commandName} dbOpen`)
      return true
    case "dbClear":
      console.log("Remove all data from the project SQLite database\n")
      console.log("Usage:")
      console.log(`  ${commandName} dbClear`)
      return true
    case "update":
      console.log("Update dependencies and sync the repository\n")
      console.log("Usage:")
      console.log(`  ${commandName} update`)
      return true
    case "setup":
      console.log("Validate secrets then run the setup task from 1f.toml\n")
      console.log("Usage:")
      console.log(`  ${commandName} setup`)
      return true
    case "tasks":
      console.log("List tasks defined in 1f.toml\n")
      console.log("Usage:")
      console.log(`  ${commandName} tasks`)
      return true
    case "test":
      console.log("Fuzzy select a test from tests/ and run bun --watch\n")
      console.log("Usage:")
      console.log(`  ${commandName} test`)
      return true
    case "chat":
      console.log("Open a chat-style TUI powered by GPT\n")
      console.log("Usage:")
      console.log(`  ${commandName} chat`)
      return true
    case "version":
      console.log("Print the current fast release\n")
      console.log("Usage:")
      console.log(`  ${commandName} version`)
      return true
  }
  return false
}

function printRootHelp() {
  console.log(commandSummary)
  console.log("\nUsage:")
  console.log(`  ${commandName} [command]\n`)
  console.log(
    `Run \`${commandName}\` without arguments to open the interactive command palette.\n`
  )
  console.log("Available Commands:")
  console.log("  help             Help about any command")
  console.log(
    "  commit           Generate a commit message with GPT-5 nano, create the commit, and push it"
  )
  console.log(
    "  commitPush       Generate a commit message with GPT-5 nano, create the commit, and push it"
  )
  console.log(
    "  dbOpen           Open the project SQLite database in TablePlus"
  )
  console.log(
    "  dbClear          Remove all data from the project SQLite database"
  )
  console.log(
    "  update           Update dependencies (bun) and pull latest git changes"
  )
  console.log(
    "  setup           Validate secrets and run the setup task from 1f.toml"
  )
  console.log("  tasks            Show tasks defined in 1f.toml")
  console.log(
    "  test             Fuzzy select a test file under tests/ then run bun --watch"
  )
  console.log("  chat             ChatGPT-like TUI for quick requests")
  console.log("  version          Print the current fast release\n")
  console.log("Flags:")
  console.log(`  -h, --help   help for ${commandName}\n`)
  console.log(
    `Use \"${commandName} [command] --help\" for more information about a command.`
  )
}

async function selectCommandArgs(): Promise<CommandPaletteResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { kind: "fallback" }
  }
  const hasFzf = await commandExists("fzf")
  if (!hasFzf) {
    return { kind: "fallback" }
  }

  const options = [
    "--height=40%",
    "--layout=reverse-list",
    "--border=rounded",
    "--prompt",
    `${commandName}> `,
    "--info=inline",
    "--no-multi",
    "--header",
    `Select an ${commandName} command (Enter to run, ESC to cancel)`,
  ]

  return new Promise<CommandPaletteResult>((resolve) => {
    const child = spawn("fzf", options, { stdio: ["pipe", "pipe", "inherit"] })
    let stdout = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    child.on("error", () => {
      resolve({ kind: "fallback" })
    })

    child.on("close", (code) => {
      if (code === 0) {
        const firstLine = stdout
          .split(/\r?\n/)
          .find((line) => line.trim().length > 0)
        if (!firstLine) {
          resolve({ kind: "fallback" })
          return
        }
        const selection = firstLine.split("\t")[0]?.trim()
        if (!selection) {
          resolve({ kind: "fallback" })
          return
        }
        resolve({ kind: "command", args: [selection] })
        return
      }
      resolve({ kind: "cancel", code: code ?? 1 })
    })

    for (const entry of commandCatalog) {
      child.stdin?.write(`${entry.name}\t${entry.description}\n`)
    }
    child.stdin?.end()
  })
}

async function runCommitPushWorkflow(label: string) {
  if (label !== "commit" && label !== "commitPush") {
    throw new Error(`Unsupported commit workflow: ${label}`)
  }

  const payload = await prepareCommit()
  printProposedMessage(payload.message)
  await commitWithPayload(payload)
  printCommitSuccess(payload)
  await runGitCommandStreaming(["push"])
  console.log("✔️ Pushed")
}

async function runChatTui() {
  const apiKey = await resolveOpenAIKey()
  await startChatInterface({
    apiKey,
    model: CHAT_MODEL_NAME,
    systemPrompt: CHAT_SYSTEM_PROMPT,
  })
}

async function runSetup() {
  const config = await loadOneFConfig()
  if (!config) {
    console.log(`No ${ONE_F_CONFIG_FILENAME} found. Nothing to validate.`)
    return
  }

  const secretResults = validateSecrets(config)
  for (const line of secretResults.lines) {
    console.log(line)
  }

  if (secretResults.missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${secretResults.missing.join(", ")}`
    )
  }

  if (config.tasks?.setup) {
    console.log("Running setup task commands...")
    await runConfiguredTask("setup", config.tasks.setup)
  } else {
    console.log("No setup task defined; environment looks good.")
  }
}

async function runTasksList() {
  const config = await loadOneFConfig()
  if (!config?.tasks || Object.keys(config.tasks).length === 0) {
    console.log(`No tasks defined in ${ONE_F_CONFIG_FILENAME}.`)
    return
  }

  const entries = Object.entries(config.tasks)
  const longestName = entries.reduce(
    (max, [name]) => Math.max(max, name.length),
    0
  )

  console.log(`Tasks defined in ${ONE_F_CONFIG_FILENAME}:\n`)
  for (const [taskName, taskConfig] of entries) {
    const padded = taskName.padEnd(longestName)
    const cmdCount = taskConfig.cmds?.length ?? 0
    const desc = taskConfig.desc ?? "(no description)"
    const suffix = ` (${cmdCount} cmd${cmdCount === 1 ? "" : "s"})`
    console.log(`  ${padded}  ${desc}${suffix}`)
  }
}

async function runTestWatch() {
  const repoRoot = process.cwd()
  const testsDir = path.join(repoRoot, "tests")

  let stats
  try {
    stats = await fs.stat(testsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("tests/ directory not found at repository root.")
    }
    throw error
  }
  if (!stats.isDirectory()) {
    throw new Error("tests/ exists but is not a directory.")
  }

  const testFiles = await collectTypeScriptTestFiles(testsDir, repoRoot)
  if (testFiles.length === 0) {
    console.log("No TypeScript test files found under tests/.")
    return
  }

  if (!(await commandExists("fzf"))) {
    throw new Error(
      "Command 'fzf' is required for fuzzy selection. Install it from https://github.com/junegunn/fzf."
    )
  }

  const selected = await selectTestFile(testFiles)
  if (!selected) {
    console.log("Selection cancelled.")
    return
  }

  console.log(`Watching ${selected}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["--watch", selected], {
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      if (signal || code === 0) {
        resolve()
      } else {
        reject(
          new Error(`bun --watch exited with code ${code ?? -1} for ${selected}`)
        )
      }
    })
  })
}

async function collectTypeScriptTestFiles(dir: string, root: string) {
  const collected: string[] = []
  await walk(dir)
  collected.sort((a, b) => a.localeCompare(b))
  return collected

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        collected.push(path.relative(root, fullPath))
      }
    }
  }
}

async function selectTestFile(files: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "fzf",
      ["--prompt=test> ", "--height=40%", "--reverse"],
      {
        stdio: ["pipe", "pipe", "inherit"],
      }
    )
    let output = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      output += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim())
        return
      }
      if (code === 130 || code === 1) {
        resolve("")
      } else {
        reject(new Error(`fzf exited with code ${code ?? -1}`))
      }
    })
    child.stdin?.write(files.join("\n"))
    child.stdin?.end()
  })
}

function registerConfigTasks(config: OneFConfig | null) {
  if (!config?.tasks) {
    return
  }
  for (const [taskName, taskConfig] of Object.entries(config.tasks)) {
    if (commandRegistry.has(taskName)) {
      continue
    }
    registerCommand(
      taskName,
      taskConfig.desc ?? `Run ${taskName} task from ${ONE_F_CONFIG_FILENAME}`,
      async () => {
        await runConfiguredTask(taskName, taskConfig)
      }
    )
  }
}

async function runConfiguredTask(
  name: string,
  configOverride?: OneFTaskConfig
) {
  const config = configOverride ?? (await loadOneFConfig())?.tasks?.[name]
  if (!config) {
    throw new Error(`Task '${name}' not found in ${ONE_F_CONFIG_FILENAME}`)
  }
  const commands = config.cmds ?? []
  if (commands.length === 0) {
    throw new Error(`Task '${name}' has no commands to run`)
  }
  for (const command of commands) {
    await executeTaskCommand(command, name)
  }
}

function executeTaskCommand(command: string, name: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      stdio: "inherit",
    })
    child.on("error", (error) => reject(error))
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(`Task '${name}' command exited with code ${code ?? -1}`)
        )
      }
    })
  })
}

function validateSecrets(config: OneFConfig) {
  const lines: string[] = []
  const missing: string[] = []
  const secrets = config.secrets
  if (!secrets || Object.keys(secrets).length === 0) {
    lines.push(`No secrets defined in ${ONE_F_CONFIG_FILENAME}.`)
    return { lines, missing }
  }

  for (const [envName, secretConfig] of Object.entries(secrets)) {
    const label = secretConfig.label ?? envName
    const required = secretConfig.required ?? false
    const envValue = lookupNonEmptyEnv(envName)
    if (envValue) {
      lines.push(`✔️ ${label} (${envName}) is set`)
      continue
    }

    if (required) {
      if (secretConfig.default !== undefined) {
        lines.push(
          `⚠️ ${label} (${envName}) missing; default '${secretConfig.default}' will be used`
        )
      } else {
        lines.push(
          `❌ ${label} (${envName}) is required: ${
            secretConfig.description ?? "no description provided"
          }`
        )
        missing.push(envName)
      }
    } else {
      lines.push(`• ${label} (${envName}) not set (optional)`)
    }
  }

  return { lines, missing }
}

interface CommitPayload {
  message: string
  paragraphs: string[]
}

async function prepareCommit(): Promise<CommitPayload> {
  await ensureGitRepository()
  const apiKey = await resolveOpenAIKey()

  await runGitCommandStreaming(["add", "."])

  const diff = await runGitCapture(["diff", "--cached"])
  if (!diff.trim()) {
    throw new Error("No staged changes to commit; stage files with git add")
  }

  const { truncatedDiff, truncated } = truncateDiffForCommit(diff)
  let status = ""
  try {
    status = await runGitCapture(["status", "--short"])
  } catch {
    status = ""
  }

  const message = await generateCommitMessage(
    apiKey,
    truncatedDiff,
    status,
    truncated
  )
  const trimmedMessage = trimMatchingQuotes(message.trim())
  if (!trimmedMessage) {
    throw new Error("Commit message is empty")
  }

  const paragraphs = splitCommitMessageParagraphs(trimmedMessage)
  if (!paragraphs.length) {
    throw new Error("Commit message is empty after formatting")
  }

  return { message: trimmedMessage, paragraphs }
}

async function resolveOpenAIKey() {
  if (cachedOpenAIKey) {
    return cachedOpenAIKey
  }
  const value = lookupNonEmptyEnv(OPENAI_API_KEY_ENV)
  if (!value) {
    throw new Error(
      `${OPENAI_API_KEY_ENV} is not set; export it before running ${commandName} commit`
    )
  }
  cachedOpenAIKey = value
  return value
}

function truncateDiffForCommit(diff: string) {
  if (diff.length <= MAX_COMMIT_DIFF_CHARS) {
    return { truncatedDiff: diff, truncated: false }
  }
  const truncatedDiff = `${diff.slice(
    0,
    MAX_COMMIT_DIFF_CHARS
  )}\n\n[Diff truncated to the first ${MAX_COMMIT_DIFF_CHARS} characters]`
  return { truncatedDiff, truncated: true }
}

async function generateCommitMessage(
  apiKey: string,
  diff: string,
  status: string,
  truncated: boolean
) {
  const systemPrompt =
    "You are an expert software engineer who writes clear, concise git commit messages. Use imperative mood, keep the subject line under 72 characters, and include an optional body with bullet points if helpful. Never wrap the message in quotes. Never include secrets, credentials, or file contents from .env files, environment variables, keys, or other sensitive data—even if they appear in the diff."

  let userPrompt =
    "Write a git commit message for the staged changes.\n\nGit diff:\n"
  userPrompt += diff
  if (truncated) {
    userPrompt += "\n\n[Diff truncated to fit within prompt]"
  }
  const trimmedStatus = status.trim()
  if (trimmedStatus) {
    userPrompt += `\n\nGit status --short:\n${trimmedStatus}`
  }

  const result = streamText({
    model: openai(resolveOpenAIModelId(COMMIT_MODEL_NAME), { apiKey }),
    system: systemPrompt,
    prompt: userPrompt,
  })

  const message = (await result.text).trim()
  if (!message) {
    throw new Error("Model returned an empty commit message")
  }

  return message
}

function resolveOpenAIModelId(spec: string) {
  return spec.startsWith("openai/") ? spec.slice("openai/".length) : spec
}

async function commitWithPayload(payload: CommitPayload) {
  const args = ["commit"]
  for (const paragraph of payload.paragraphs) {
    args.push("-m", paragraph)
  }
  await runGitCommandStreaming(args)
}

function printProposedMessage(message: string) {
  console.log("Proposed commit message:\n" + message + "\n")
}

function printCommitSuccess(payload: CommitPayload) {
  if (payload.paragraphs.length) {
    console.log(`✔️ Committed with message: ${payload.paragraphs[0]}`)
  }
}

async function ensureGitRepository() {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    {
      maxBuffer: DEFAULT_MAX_BUFFER,
    }
  )
  if (stdout.toString().trim() !== "true") {
    throw new Error("Not inside a git repository")
  }
}

async function runGitCommandStreaming(args: string[]) {
  await runCommandStreaming("git", args)
}

async function runGitCapture(args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    maxBuffer: DEFAULT_MAX_BUFFER,
  })
  return stdout.toString()
}

async function runCommandStreaming(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.on("error", (error) => reject(error))
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`)
        )
      }
    })
  })
}

function splitCommitMessageParagraphs(message: string) {
  const lines = message.split(/\r?\n/)
  const paragraphs: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) {
        paragraphs.push(current.join("\n").trimEnd())
        current = []
      }
      continue
    }
    current.push(line.replace(/[\t ]+$/, ""))
  }

  if (current.length) {
    paragraphs.push(current.join("\n").trimEnd())
  }
  return paragraphs
}

function trimMatchingQuotes(input: string) {
  if (input.length >= 2) {
    const first = input[0]
    const last = input[input.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return input.slice(1, -1)
    }
  }
  return input
}

async function runDBOpen() {
  const cwd = process.cwd()
  const dbPath = await locateBladeDatabase(cwd)
  const displayPath = formatDisplayPath(dbPath)
  const absPath = path.resolve(dbPath)

  await runCommandStreaming("open", ["-a", TABLEPLUS_APP, absPath])
  console.log(`✔️ Opening ${displayPath} in ${TABLEPLUS_APP}`)
}

async function runDBClear() {
  const cwd = process.cwd()
  const dbPath = await locateBladeDatabase(cwd)
  const displayPath = formatDisplayPath(dbPath)

  await clearSQLiteDatabase(dbPath)
  console.log(`✔️ Removed all data from ${displayPath}`)
}

async function runUpdate() {
  console.log("⬆️ bun update --latest")
  await runCommandStreaming("bun", ["update", "--latest"])
  console.log("⬆️ git pull")
  await runCommandStreaming("git", ["pull"])
  console.log("✔️ Dependencies and repository are up to date")
}

async function locateBladeDatabase(start: string) {
  let dir = start
  while (true) {
    const candidate = path.join(dir, BLADE_DB_RELATIVE_PATH)
    try {
      const stats = await fs.stat(candidate)
      if (stats.isFile()) {
        return candidate
      }
      if (stats.isDirectory()) {
        throw new Error(`Blade database path ${candidate} is a directory`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }

    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  throw new Error(
    `Could not find ${BLADE_DB_RELATIVE_PATH} starting from ${start}`
  )
}

async function clearSQLiteDatabase(dbPath: string) {
  const tables = await listSQLiteTables(dbPath)
  if (!tables.length) {
    return
  }

  const statements = ["BEGIN;"]
  for (const table of tables) {
    statements.push(`DELETE FROM ${quoteSQLiteIdentifier(table)};`)
  }
  statements.push("COMMIT;")

  await runSqliteScript(dbPath, statements.join("\n"))
  try {
    await runSqliteScript(dbPath, "DELETE FROM sqlite_sequence;")
  } catch (error) {
    if (!isSQLiteNoSuchTableError(error)) {
      throw error
    }
  }
}

async function runSqliteScript(dbPath: string, script: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sqlite3", [dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => reject(error))

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr || `sqlite3 exited with code ${code}`))
      }
    })

    child.stdin?.write(script)
    if (!script.endsWith("\n")) {
      child.stdin?.write("\n")
    }
    child.stdin?.end()
  })
}

async function listSQLiteTables(dbPath: string) {
  const query =
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';"
  const { stdout } = await execFileAsync("sqlite3", [dbPath, query], {
    maxBuffer: DEFAULT_MAX_BUFFER,
  })
  return stdout
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function quoteSQLiteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`
}

function isSQLiteNoSuchTableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }
  return error.message.toLowerCase().includes("no such table")
}

function formatDisplayPath(filePath: string) {
  const relative = path.relative(process.cwd(), filePath)
  if (relative && !relative.startsWith("..")) {
    return relative
  }
  return filePath
}

type TelemetryLevel = "debug" | "info" | "warn" | "error"

function trackTelemetry(
  level: TelemetryLevel,
  event: string,
  fields: Record<string, unknown> = {}
) {
  if (!telemetryLogger) {
    return
  }
  const payload = {
    event,
    commandName,
    version: FLOW_VERSION,
    ...fields,
  }

  let operation: Promise<void>
  switch (level) {
    case "debug":
      operation = telemetryLogger.debug(payload)
      break
    case "warn":
      operation = telemetryLogger.warn(payload)
      break
    case "error":
      operation = telemetryLogger.error(payload)
      break
    default:
      operation = telemetryLogger.info(payload)
      break
  }

  operation.catch((error) => {
    handleTelemetryFailure(error)
  })
}

function handleTelemetryFailure(error: unknown) {
  if (TELEMETRY_DEBUG_ENABLED && !telemetryNoticeShown) {
    console.warn(
      `[telemetry] disabled: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    telemetryNoticeShown = true
  }
  telemetryLogger = undefined
}

async function ensureCreateLogger() {
  if (createLoggerFactory) {
    return createLoggerFactory
  }
  const restoreWarnings = silenceMockJazzWarnings()
  try {
    const module: OneFocusModule = await import("1focus")
    createLoggerFactory = module.createLogger
    return createLoggerFactory
  } finally {
    restoreWarnings()
  }
}

function silenceMockJazzWarnings() {
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    const [first] = args
    if (
      typeof first === "string" &&
      first.startsWith("1focus: falling back to mock Jazz")
    ) {
      return
    }
    originalWarn(...args)
  }
  return () => {
    console.warn = originalWarn
  }
}

function serializeErrorForTelemetry(error: unknown) {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    }
    if (error.stack) {
      serialized.stack = error.stack
    }
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause !== undefined && cause !== error) {
      serialized.cause = serializeValueForTelemetry(cause)
    }
    return serialized
  }
  return serializeValueForTelemetry(error)
}

function serializeValueForTelemetry(value: unknown) {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return { value: null }
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { value }
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return { value: String(value) }
  }
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return { value: String(value) }
    }
  }
  return { value: String(value) }
}

async function commandExists(name: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("which", [name])
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
