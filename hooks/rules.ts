// A basename that is exactly .env or .env.<suffix>; "myproject.environment" does not match.
const ENV_BASENAME = /^\.env(\.[^\\/]*)?$/

// A .env token in a shell command, bounded the way a path component is.
const ENV_TOKEN = /(^|[\s=/"'\\])\.env(\.[A-Za-z0-9_.-]+)?(?=[\s"'\\;|&)>]|$)/
const ENV_EXAMPLE_TOKEN = /(^|[\s=/"'\\])\.env\.example(?=[\s"'\\;|&)>]|$)/g

// A git invocation at line start or after &&.
const GIT_LINE = /^git\s|&&\s*git\s/

// A Grep content/count line whose path ends in a .env basename: "<path>/.env.local:12:..." or "<path>/.env:3".
const ENV_RESULT_LINE = /(^|[\\/])\.env(\.[^\\/:]*)?:/

export const basename = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

export const isEnvPath = (path: string): boolean => ENV_BASENAME.test(basename(path))

// A Grep glob whose last segment names .env files (".env", ".env.*", ".env*", "**/.env.local").
// Negated globs ("!.env") exclude them and pass.
export const isEnvGlob = (glob: string): boolean =>
  glob
    .split(/[\s,{}]+/)
    .filter(part => part !== '' && !part.startsWith('!'))
    .some(part => /^\.env([.*]|$)/.test(basename(part)))

export type BashVerdict = 'allow' | 'deny' | 'deny-git'

export function bashVerdict(command: string): BashVerdict {
  if (!ENV_TOKEN.test(command)) return 'allow'
  const isGit = command.split('\n').some(line => GIT_LINE.test(line))
  if (!isGit) return 'deny'
  return ENV_TOKEN.test(command.replace(ENV_EXAMPLE_TOKEN, '$1')) ? 'deny-git' : 'allow'
}

export const isEnvResultLine = (line: string): boolean => ENV_RESULT_LINE.test(line)
