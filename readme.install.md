# fast

```
fast --help
fast is CLI to move faster in software projects

Usage:
  fast [command]

Run `fast` without arguments to open the interactive command palette.

Available Commands:
  help             Help about any command
  commit           Generate a commit message with GPT-5 nano, create the commit, and push it
  commitPush       Generate a commit message with GPT-5 nano, create the commit, and push it
  dbOpen           Open the project SQLite database in TablePlus
  dbClear          Remove all data from the project SQLite database
  update           Update dependencies (bun) and pull latest git changes
  setup           Validate secrets and run the setup task from 1f.toml
  tasks            Show tasks defined in 1f.toml
  chat             ChatGPT-like TUI for quick requests
  version          Print the current fast release

Flags:
  -h, --help   help for fast

Use "fast [command] --help" for more information about a command.
```

## Notes

Running `fast` without arguments opens an fzf-powered command palette.

For `fast commit`, export `OPENAI_API_KEY` so the CLI can talk to OpenAI. Telemetry via 1focus requires AXIOM_TOKEN and AXIOM_DATASET.
