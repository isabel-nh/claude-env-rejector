# claude-env-rejector

Claude Code mod to prevent accidental secret exfiltration through `.env` files.

| Tool | Behavior |
| --- | --- |
| Read | Denies any file named `.env` or `.env.*` (`.env.example` included). |
| Bash | Denies any command naming a `.env` / `.env.*` file. Git commands may name `.env.example` only. A commit whose message mentions `.env` runs unless git reports a `.env` file staged, modified or untracked in that repository. |
| Grep | Denies a `path` that is a `.env` file or a `glob` targeting `.env` files. Directory searches run, and hits from `.env` files are removed from the result before the model reads it. |

If a guard fails, the call is denied, never passed through.

## Commit messages

A `.env` mention inside commit-message text does not read anything, so it is judged against the repository instead of the command text:

- Message text: `-m` / `--message` values (including `-m "$(cat <<'EOF' … EOF)"`), the heredoc of `git commit -F -`, and the quoted arguments of a configured commit wrapper.
- Repository: the last `git -C <dir>`, else a leading `cd <dir>`, else the session's directory.
- The commit is denied while `git status` lists any `.env` / `.env.*` file other than `.env.example` (staged, modified or untracked), when `git status` fails, or when the message expands a `.env` read (`-m "$(cat .env)"`).
- Anything outside the message text is held to the ordinary Bash rule: `cat .env && git commit -m x` and `git commit -F .env` are denied.

### Option: `commitWrapper`

A regular expression matched against each line of a Bash command; a matching line is treated like `git commit`, its quoted arguments as message text. Empty (the default): only `git commit` is recognized. Set it in `settings.json`:

```json
"pluginConfigs": {
  "env-rejector@isabel-nh": {
    "options": { "commitWrapper": "format-commit-message.*\\s-c(\\s|$)" }
  }
}
```

## Limits

- A Bash command that searches a directory (`rg PASSWORD .`, `grep -r KEY .`) still reaches `.env` files: only `.env` names typed in the command are matched.
- MCP tools that read files are not covered.

## Install

The plugin is published through the [isabel-nh marketplace](https://github.com/isabel-nh/marketplace).

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add isabel-nh/marketplace
/plugin install env-rejector@isabel-nh
```

From a shell:

```bash
claude plugin marketplace add isabel-nh/marketplace
```

```bash
claude plugin install env-rejector@isabel-nh
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `isabel-nh/marketplace`, then Add plugin.

Pick a scope when prompted (user scope applies to every session).

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod and written `.claude-plugin/types/`.
