# fast

> CLI to move faster in software projects

## Install

1. Run `task setup` to install dependencies (preferring Bun, falling back to npm).
2. Run `task deploy` to compile the Bun entrypoint, copy the resulting binary to `~/bin/fast`, and optionally add `~/bin` to your shell's `PATH`.

`task deploy` also:

- regenerates `readme.install.md` with the latest `fast --help` output.
- writes `~/.config/fish/conf.d/fast-dot.fish` (when Fish is present) so `. tasks` executes `fast tasks` while still allowing `. ./env.fish` style sourcing.

## Usage

Running `fast --help` prints the built-in help. Running `fast` with no arguments opens an fzf-powered palette (if `fzf` is available in your terminal); otherwise it falls back to the help text.

### Core commands

- `fast commit` / `fast commitPush` &mdash; use GPT-5 nano to propose a commit message, create the commit, and push the branch. Requires `OPENAI_API_KEY`.
- `fast dbOpen` / `fast dbClear` &mdash; open or wipe the local SQLite database using the TablePlus app.
- `fast update` &mdash; update Bun dependencies and pull the latest git changes.
- `fast setup` &mdash; validate secrets listed in `1f.toml` and run the `tasks.setup` command list.
- `fast tasks` &mdash; enumerate the commands defined under `[tasks.*]` in `1f.toml`.
- `fast chat` &mdash; OpenTUI powered GPT chat window for quick prompts (also requires `OPENAI_API_KEY`).
- `fast version` &mdash; print the CLI version declared in `1f.toml`.

### Environment setup via `1f.toml`

`fast` reads `1f.toml` at startup:

1. `[app]` fields override the CLI name, description, and version.
2. `[secrets.*]` entries describe environment variables that `fast setup` validates before running any setup commands.
3. `[tasks.*]` entries turn into reusable commands. In this repo they expose:
   - `fast dev` &mdash; run `bun dev`.
   - `fast script` &mdash; run `bun --watch scripts/run.ts`.

Add additional tasks by editing `1f.toml`; the next invocation of `fast` automatically surfaces them under `fast tasks`.

### Chat TUI

`fast chat` launches an OpenTUI session with these bindings:

- `Enter` sends your prompt, `Shift+Enter` inserts a newline, `Esc`/`Ctrl+C` closes the session.
- Responses stream back with color-coded roles.
- You must export `OPENAI_API_KEY` (same requirement as `fast commit`).

### Fish `.` shortcut

When Fish is installed, rerunning `task deploy` refreshes `~/.config/fish/conf.d/fast-dot.fish`. After sourcing that file:

- Typing `. tasks` executes the compiled `fast` binary (`fast tasks`).
- Typing `. ./env` or `. ~/script.fish` still performs the original `source` workflow.
- Remove or edit the generated file to disable or customize the shortcut.
