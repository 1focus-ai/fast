import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseOneFConfig } from "../src/config.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, "fixtures")

test("parses the sample 1f.toml config", async () => {
  const [rawToml, goldenJson] = await Promise.all([
    readFile(path.join(fixturesDir, "linsa.1f.toml"), "utf8"),
    readFile(path.join(fixturesDir, "linsa.1f.golden.json"), "utf8"),
  ])
  const parsed = parseOneFConfig(rawToml)
  expect(parsed).toEqual(JSON.parse(goldenJson))
})
