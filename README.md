# claude-env-rejector

Claude Code mod to prevent accidental secret exfiltration through `.env` files.

| Tool | Behavior |
| --- | --- |
| Read | Denies any file named `.env` or `.env.*` (`.env.example` included). |
| Bash | Denies any command naming a `.env` / `.env.*` file. Git commands may name `.env.example` only. |
| Grep | Denies a `path` that is a `.env` file or a `glob` targeting `.env` files. Directory searches run, and hits from `.env` files are removed from the result before the model reads it. |

If a guard fails, the call is denied, never passed through.

## Limits

- A Bash command that searches a directory (`rg PASSWORD .`, `grep -r KEY .`) still reaches `.env` files: only `.env` names typed in the command are matched.
- MCP tools that read files are not covered.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install env-rejector --marketplace isabel-nh/claude-env-rejector
```

From a shell:

```bash
claude plugin install env-rejector --marketplace isabel-nh/claude-env-rejector
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `isabel-nh/claude-env-rejector`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope (user scope applies to every session).

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod and written `.claude-plugin/types/`.
