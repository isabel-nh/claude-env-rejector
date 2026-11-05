// Redacts a dotenv file line by line, keeping line count so Read's line numbers stay true.
// Kept verbatim: blank lines, key names, and values that are empty, a boolean/null word, or a
// short number under a key that does not look secret. Everything else becomes a marker.

export const REDACTED = '[redacted]'
export const REDACTED_LINE = '[redacted line]'
export const REDACTED_COMMENT = '# [redacted comment]'
export const REDACTED_CONTINUATION = '[redacted multiline value]'

const KEEP_WORD = /^(true|false|yes|no|on|off|null|none|nil|undefined)$/i
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const MAX_DIGITS = 10
// A number under such a key (PIN, OTP, account id) is treated as a secret.
const SECRET_KEY = /SECRET|TOKEN|PASS|PWD|PIN|OTP|KEY|AUTH|CRED|PRIVATE|SALT|SIGN|CERT|SESSION|COOKIE|ACCOUNT|SSN|CARD|IBAN|ROUTING/i
const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/
const QUOTES = new Set(['"', "'", '`'])

export const isSafeValue = (key: string, value: string): boolean => {
  if (value === '' || KEEP_WORD.test(value)) return true
  if (!NUMBER.test(value) || SECRET_KEY.test(key)) return false
  return (value.match(/\d/g)?.length ?? 0) <= MAX_DIGITS
}

// Index of the closing quote in s at or after from; backslash escapes only inside double quotes.
const closingQuote = (s: string, quote: string, from: number): number => {
  for (let i = from; i < s.length; i++) {
    if (quote === '"' && s[i] === '\\') i++
    else if (s[i] === quote) return i
  }
  return -1
}

type Line = { text: string; open?: string }

// One line; `open` is the quote still unclosed at its end.
const redactLine = (line: string): Line => {
  if (line.trim() === '') return { text: line }
  const comment = /^(\s*)#\s?(.*)$/.exec(line)
  if (comment !== null) {
    const inner = redactLine(comment[2] ?? '')
    const isAssignment = inner.open === undefined && ASSIGNMENT.test(comment[2] ?? '')
    return { text: isAssignment ? `${comment[1]}# ${inner.text}` : `${comment[1]}${REDACTED_COMMENT}` }
  }
  const m = ASSIGNMENT.exec(line)
  if (m === null) return { text: REDACTED_LINE }
  const [, indent = '', exported = '', key = '', eq = '', raw = ''] = m
  const head = `${indent}${exported}${key}${eq}`
  const quote = raw[0]
  if (quote !== undefined && QUOTES.has(quote)) {
    const end = closingQuote(raw, quote, 1)
    if (end === -1) return { text: `${head}${REDACTED}`, open: quote }
    const value = raw.slice(1, end)
    return { text: isSafeValue(key, value) ? `${head}${quote}${value}${quote}` : `${head}${REDACTED}` }
  }
  const value = raw.replace(/\s+#.*$/, '').trim()
  return { text: isSafeValue(key, value) ? `${head}${value}` : `${head}${REDACTED}` }
}

export function redactEnv(content: string): string {
  const out: string[] = []
  let open: string | undefined
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (open !== undefined) {
      out.push(REDACTED_CONTINUATION)
      if (closingQuote(line, open, 0) !== -1) open = undefined
      continue
    }
    const r = redactLine(line)
    out.push(r.text)
    open = r.open
  }
  return out.join('\n')
}
