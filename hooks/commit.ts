import { basename, isEnvPath } from './rules.ts'

// Commit detection follows isabel-nh/claude-sentinel's classify(): git, any global
// options (-C dir, -c k=v, --no-pager), then commit; the repository from the last -C,
// else a leading cd, else the session's directory.
const WORD = `(?:"([^"]+)"|'([^']+)'|([^\\s;&|)]+))`
const CD = new RegExp(`^\\s*[({]?\\s*(?:cd|pushd)\\s+(?:--\\s+)?${WORD}`)
const GIT_OPTION = `(?:-C\\s+${WORD}|-c\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?)`
const GIT_COMMIT = new RegExp(`(?:^|[^\\w./-])git\\s+(?:${GIT_OPTION}\\s+)*commit(?=[\\s"')]|$)`, 'g')
const DIR_FLAG = new RegExp(`\\s-C\\s+${WORD}`, 'g')

const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g
const CAT_HEREDOC = /\$\(\s*cat\s*<<-?\s*(['"]?)[A-Za-z_]\w*\1\s*\)/g
const SUBSTITUTION = /\$\(|`/
// What may stand before a command: start, a separator, a subshell or group opener.
const COMMAND_POSITION = /(^|[;&|({\n]|\$\()\s*$/

type Range = { start: number; end: number }
type Heredoc = { opener: Range; body: Range; text: string; quoted: boolean }
type Token = Range & { raw: string }
type Message = { text: string; expands: boolean }

export type CommitSplit = {
  repo: string
  // The command with commit-message text cut out; judged by the ordinary Bash rules.
  rest: string
  // A message whose shell expansion would itself read a .env file: `-m "$(cat .env)"`.
  isUnsafe: boolean
}

export function normalizeDrive(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const posix = /^\/([A-Za-z])(\/|$)/.exec(s)
  if (posix) s = `${posix[1]!.toUpperCase()}:/${s.slice(3)}`
  return s.length > 3 ? s.replace(/\/+$/, '') : s
}

const word = (m: RegExpExecArray, at: number): string | undefined => m[at] ?? m[at + 1] ?? m[at + 2]

function resolve(p: string, cwd: string): string {
  const expanded = normalizeDrive(p)
  const abs = /^([A-Za-z]:\/|\/)/.test(expanded) ? expanded : `${normalizeDrive(cwd)}/${expanded}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '.' || (seg === '' && out.length > 0)) continue
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else out.push(seg)
  }
  return normalizeDrive(out.join('/') || '/')
}

export function compileWrapper(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

function findHeredocs(text: string): Heredoc[] {
  const found: Heredoc[] = []
  let cursor = 0
  for (const m of text.matchAll(HEREDOC)) {
    const openerEnd = m.index + m[0].length
    if (openerEnd <= cursor) continue
    const delimiter = m[3]!
    const firstNewline = text.indexOf('\n', Math.max(openerEnd, cursor))
    if (firstNewline < 0) break
    const bodyStart = firstNewline + 1
    let at = bodyStart
    let end = text.length
    while (at <= text.length) {
      const lineEnd = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at)
      const line = text.slice(at, lineEnd)
      if ((m[1] === '-' ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === delimiter) {
        end = lineEnd
        break
      }
      if (lineEnd >= text.length) break
      at = lineEnd + 1
    }
    found.push({ opener: { start: m.index, end: openerEnd }, body: { start: bodyStart, end }, text: text.slice(bodyStart, end), quoted: m[2] !== '' })
    cursor = end
  }
  return found
}

const within = (i: number, r: Range): boolean => i >= r.start && i < r.end

// Index -> true where the character sits inside a quoted span; heredoc bodies are skipped.
function quoteMask(text: string, bodies: readonly Range[]): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const body = bodies.find(b => within(i, b))
    if (body !== undefined) {
      for (let j = i; j < body.end; j++) mask[j] = quote !== null
      i = body.end - 1
      continue
    }
    const c = text[i]
    if (quote === null) {
      if (c === '"' || c === "'") quote = c
    } else {
      mask[i] = true
      if (quote === '"' && c === '\\') {
        mask[i + 1] = true
        i++
      } else if (c === quote) quote = null
    }
  }
  return mask
}

// Shell words from `from` to the end of that command (an unquoted ; & | or newline).
function tokens(text: string, from: number, mask: readonly boolean[], bodies: readonly Range[]): Token[] {
  const out: Token[] = []
  const isEnd = (i: number) => !mask[i] && /[;&|\n]/.test(text[i]!)
  let i = from
  while (i < text.length) {
    const body = bodies.find(b => within(i, b))
    if (body !== undefined && !mask[i]) {
      i = body.end
      continue
    }
    if (!mask[i] && /[ \t\r]/.test(text[i]!)) {
      i++
      continue
    }
    if (isEnd(i)) break
    const start = i
    while (i < text.length && (mask[i] || (!/[ \t\r]/.test(text[i]!) && !isEnd(i)))) i++
    out.push({ start, end: i, raw: text.slice(start, i) })
  }
  return out
}

function unquote(raw: string): Message {
  const single = /^'[^']*'$/.test(raw)
  return { text: raw.replace(/^(['"])([\s\S]*)\1$/, '$2'), expands: !single }
}

function commitStarts(text: string, masked: string, mask: readonly boolean[], cwd: string, wrapper: RegExp | undefined) {
  const starts: { at: number; repo: string; isWrapper: boolean }[] = []
  const lineOf = (i: number) => text.slice(text.lastIndexOf('\n', i - 1) + 1, i)
  for (const m of masked.matchAll(GIT_COMMIT)) {
    const gitAt = m.index + m[0].indexOf('git')
    if (mask[gitAt] || !COMMAND_POSITION.test(masked.slice(0, gitAt))) continue
    let dir: string | undefined
    for (const d of m[0].matchAll(DIR_FLAG)) dir = word(d, 1)
    const cd = CD.exec(lineOf(gitAt))
    const cdDir = cd ? word(cd, 1) : undefined
    starts.push({ at: m.index + m[0].length, repo: resolve(dir ?? cdDir ?? cwd, cwd), isWrapper: false })
  }
  if (wrapper !== undefined) {
    let offset = 0
    for (const line of masked.split('\n')) {
      const hit = line.search(wrapper)
      if (hit >= 0 && !mask[offset + hit]) {
        const dir = new RegExp(`\\s-C\\s+${WORD}`).exec(line.slice(hit))
        const flagDir = dir ? word(dir, 1) : undefined
        const cd = CD.exec(line)
        const cdDir = cd ? word(cd, 1) : undefined
        starts.push({ at: offset + hit, repo: resolve(flagDir ?? cdDir ?? cwd, cwd), isWrapper: true })
      }
      offset += line.length + 1
    }
  }
  return starts
}

// Looser than the command rule: inside a substitution `.env` may abut a backtick.
const LOOSE_ENV = /(^|[^\w.])\.env\b/

const isUnsafeExpansion = (m: Message): boolean => {
  if (!m.expands) return false
  const t = m.text.replace(CAT_HEREDOC, '')
  return SUBSTITUTION.test(t) && LOOSE_ENV.test(t)
}

// Splits commit-message text out of a command holding one git commit (or a configured
// wrapper), so a .env mention in a message can be told apart from a .env read.
// Undefined when the command holds no commit, or more than one repository's.
export function splitCommit(command: string, cwd: string, wrapper?: RegExp): CommitSplit | undefined {
  const heredocs = findHeredocs(command)
  const bodies = heredocs.map(h => h.body)
  const mask = quoteMask(command, bodies)
  const masked = [...command].map((c, i) => (bodies.some(b => within(i, b)) && c !== '\n' ? ' ' : c)).join('')
  const starts = commitStarts(command, masked, mask, cwd, wrapper)
  if (starts.length === 0 || new Set(starts.map(s => s.repo)).size > 1) return undefined

  const cut: Range[] = []
  const messages: Message[] = []
  // A message's own text, heredoc bodies inside it left out (they are judged on their own).
  const textOf = (r: Range) => [...command.slice(r.start, r.end)].filter((_, i) => !bodies.some(b => within(r.start + i, b))).join('')
  for (const s of starts) {
    const toks = tokens(command, s.at, mask, bodies)
    let readsStdin = false
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!
      if (s.isWrapper) {
        if (/^["']/.test(t.raw)) {
          cut.push(t)
          messages.push(unquote(textOf(t)))
        }
        continue
      }
      const attached = /^(--message=|-[A-Za-z]*m(?=\S))/.exec(t.raw)
      if (/^(-[A-Za-z]*m|--message)$/.test(t.raw) && toks[k + 1] !== undefined) {
        const next = toks[++k]!
        cut.push(next)
        messages.push(unquote(textOf(next)))
      } else if (attached !== null) {
        const value = { start: t.start + attached[0].length, end: t.end }
        cut.push(value)
        messages.push(unquote(textOf(value)))
      } else if (t.raw === '--file=-' || ((t.raw === '-F' || t.raw === '--file') && toks[k + 1]?.raw === '-')) {
        readsStdin = true
      }
    }
    // Heredoc bodies that are message text: inside a cut message, or stdin of `commit -F -`.
    const segmentEnd = toks.length > 0 ? toks[toks.length - 1]!.end : s.at
    for (const h of heredocs) {
      const inMessage = cut.some(r => within(h.opener.start, r))
      const isStdin = readsStdin && h.opener.start >= s.at && h.opener.start <= segmentEnd
      if (!inMessage && !isStdin) continue
      cut.push(h.body)
      messages.push({ text: h.text, expands: !h.quoted })
    }
  }

  const rest = [...command].filter((_, i) => !cut.some(r => within(i, r))).join('')
  return { repo: starts[0]!.repo, rest, isUnsafe: messages.some(isUnsafeExpansion) }
}

// Paths git reports as staged, modified or untracked whose basename is a .env file;
// .env.example is a template and does not count. Input: `git status --porcelain=v1 -z`.
export function envFilesInStatus(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0').filter(e => e !== '')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    paths.push(entry.slice(3))
    if (/^[RC]/.test(entry) && entries[i + 1] !== undefined) paths.push(entries[++i]!)
  }
  return paths.filter(p => isEnvPath(p) && basename(p) !== '.env.example')
}

export const STATUS_ARGS = (repo: string): string[] => ['git', '-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=normal']
