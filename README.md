# claude-env-rejector

Claude Code mod to prevent accidental secret exfiltration through `.env` files.

| Tool | Behavior |
| --- | --- |
| Read | A file named `.env` or `.env.*` (`.env.example` included), or a symlink resolving to one, is returned redacted (see below). |
| Edit, Write, NotebookEdit | Denied on `.env` files and symlinks to them: an edit result echoes file contents, and a write would overwrite values the model never saw. |
| Bash | Denies any command naming a `.env` / `.env.*` file. Git commands may name `.env.example` only. A commit whose message mentions `.env` runs unless git reports a `.env` file staged, modified or untracked in that repository. A `gh` / `az` PR title or body mentioning `.env` runs. |
| Grep | Denies a `path` that is a `.env` file or a `glob` targeting `.env` files. Directory searches run, and hits from `.env` files are removed from the result before the model reads it. |

If a guard fails, the call is denied, never passed through. If redaction fails after the file was read, the result is withheld.

## Redacted Read

Each line keeps its position, so line numbers match the file. Key names and `export` prefixes are kept; values are kept only when they are:

- empty (`KEY=`);
- a boolean or null word: `true`, `false`, `yes`, `no`, `on`, `off`, `null`, `none`, `nil`, `undefined` (any case);
- a number of at most 10 digits (`5432`, `0.75`, `1e3`), unless the key name contains `SECRET`, `TOKEN`, `PASS`, `PWD`, `PIN`, `OTP`, `KEY`, `AUTH`, `CRED`, `PRIVATE`, `SALT`, `SIGN`, `CERT`, `SESSION`, `COOKIE`, `ACCOUNT`, `SSN`, `CARD`, `IBAN` or `ROUTING`.

Quotes around a kept value are kept. Everything else is replaced:

| Input | Output |
| --- | --- |
| `DB_PASSWORD=hunter2`, `URL=${BASE}/x`, `HEX=0xff` | `KEY=[redacted]` |
| continuation lines of a multiline quoted value (an unclosed quote redacts to end of file) | `[redacted multiline value]` |
| `# LOG_LEVEL=2` (commented-out assignment) | redacted as an assignment, `#` kept |
| any other comment | `# [redacted comment]` |
| a line that is not `KEY=VALUE` | `[redacted line]` |
| inline comment after a value | dropped |

`offset` / `limit` are applied after redacting the whole file, so a multiline value opened above the window stays redacted.

## Commit messages

A `.env` mention inside commit-message text does not read anything, so it is judged against the repository instead of the command text:

- Message text: `-m` / `--message` values (including `-m "$(cat <<'EOF' … EOF)"`), the heredoc of `git commit -F -`, and the quoted arguments of a configured commit wrapper.
- Repository: the last `git -C <dir>`, else a leading `cd <dir>`, else the session's directory.
- The commit is denied while `git status` lists any `.env` / `.env.*` file other than `.env.example` (staged, modified or untracked), when `git status` fails, or when the message expands a `.env` read (`-m "$(cat .env)"`).
- Anything outside the message text is held to the ordinary Bash rule: `cat .env && git commit -m x` and `git commit -F .env` are denied.

## PR titles and bodies

A `.env` mention in the text of a pull-request command runs without a `git status` check, since a PR carries only what is already pushed:

| Command | Message text |
| --- | --- |
| `gh pr create`, `edit`, `comment`, `review`, `merge` | `-t` / `--title`, `-b` / `--body`, `--subject` values (and their `=` forms); the heredoc of `-F -` / `--body-file -` |
| `az repos pr create`, `update` | `--title` value; every word after `-d` / `--description` up to the next flag (and the `=` forms) |

The binary may be named by an unquoted path (`/c/tools/gh.exe`). Denied as before: a body read from a file (`--body-file .env`), text that expands a `.env` read (`--body "$(cat .env)"`), and a `.env` name anywhere else in the command.

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
- A hard link to a `.env` file under another name is not detected; symlinks are.

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
