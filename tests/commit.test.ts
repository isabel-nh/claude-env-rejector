import { expect, test } from 'claude-code/testing'
import { envFilesInStatus, splitCommit } from '../hooks/commit.ts'

const CWD = 'C:/repo'
const WRAPPER = /format-commit-message.*\s-c(\s|$)/
const z = (...entries: string[]) => entries.map(e => `${e}\0`).join('')

const HEREDOC_MESSAGE = [
  `git commit -m "$(cat <<'EOF'`,
  '🔥 Retire bash .env hooks',
  '',
  'Body mentioning .env.local too.',
  'EOF',
  ')"',
].join('\n')

test('splitCommit: -m message text is cut from the rest', () => {
  const s = splitCommit('git commit -m "Ignore .env files"', CWD)!
  expect(s.repo).toBe('C:/repo')
  expect(s.rest).not.toContain('.env')
  expect(s.isUnsafe).toBe(false)
})

test('splitCommit: --message= and -am forms', () => {
  expect(splitCommit('git commit --message="drop .env"', CWD)!.rest).not.toContain('.env')
  expect(splitCommit("git commit -am 'drop .env'", CWD)!.rest).not.toContain('.env')
})

test('splitCommit: heredoc inside -m substitution is message text', () => {
  const s = splitCommit(HEREDOC_MESSAGE, CWD)!
  expect(s.rest).not.toContain('.env')
  expect(s.isUnsafe).toBe(false)
})

test('splitCommit: -F - heredoc is message text', () => {
  const s = splitCommit("git commit -F - <<'EOF'\nRemove .env\nEOF", CWD)!
  expect(s.rest).not.toContain('.env')
})

test('splitCommit: repository from -C, then cd, then cwd', () => {
  expect(splitCommit('git -C "C:/other repo" commit -m ".env"', CWD)!.repo).toBe('C:/other repo')
  expect(splitCommit('cd sub && git commit -m ".env"', CWD)!.repo).toBe('C:/repo/sub')
  expect(splitCommit('git commit -m ".env"', 'C:\\work\\x')!.repo).toBe('C:/work/x')
})

test('splitCommit: a .env read beside the commit stays in the rest', () => {
  expect(splitCommit('cat .env && git commit -m "x"', CWD)!.rest).toContain('.env')
  expect(splitCommit('git commit -m "x" && cat ".env"', CWD)!.rest).toContain('.env')
  expect(splitCommit('git commit -F .env', CWD)!.rest).toContain('.env')
  expect(splitCommit('git add .env && git commit -m "add .env"', CWD)!.rest).toContain('.env')
})

test('splitCommit: a message that expands a .env read is unsafe', () => {
  expect(splitCommit('git commit -m "$(cat .env)"', CWD)!.isUnsafe).toBe(true)
  expect(splitCommit('git commit -m "`cat .env`"', CWD)!.isUnsafe).toBe(true)
  expect(splitCommit("git commit -m '$(cat .env)'", CWD)!.isUnsafe).toBe(false)
  expect(splitCommit('git commit -F - <<EOF\n$(cat .env)\nEOF', CWD)!.isUnsafe).toBe(true)
})

test('splitCommit: git commit quoted inside another command is not a commit', () => {
  expect(splitCommit('cat "git commit -m" .env', CWD)).toBeUndefined()
  expect(splitCommit('cat .env', CWD)).toBeUndefined()
})

test('splitCommit: wrapper quoted arguments are message text', () => {
  const s = splitCommit('format-commit-message.sh -c -q -C C:/r "Retire .env hooks"', CWD, WRAPPER)!
  expect(s.repo).toBe('C:/r')
  expect(s.rest).not.toContain('.env')
  expect(splitCommit('format-commit-message.sh -c -q -C C:/r "Retire .env hooks"', CWD)).toBeUndefined()
})

test('envFilesInStatus: staged, modified, untracked and renamed .env files; .env.example exempt', () => {
  expect(envFilesInStatus(z('M  src/a.cs', '?? notes.txt'))).toEqual([])
  expect(envFilesInStatus(z('A  .env.example'))).toEqual([])
  expect(envFilesInStatus(z('A  .env', ' M app/.env.local', '?? cfg/.env.production'))).toEqual(['.env', 'app/.env.local', 'cfg/.env.production'])
  expect(envFilesInStatus(z('R  config/.env', 'config/settings.txt'))).toEqual(['config/.env'])
})

// Hook-level: a fake engine answers session.cwd and process.run (git status).
function setup(on: any, status: string | null) {
  const ran: string[] = []
  const gitCalls: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_: unknown, e: any) => {
    gitCalls.push([...e.argv])
    return { value: status === null ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } : { exitCode: 0, stdout: status, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.command)
    return { result: 'ran' }
  })
  return { ran, gitCalls }
}

test('commit mentioning .env runs when no .env file is staged or modified', async ($, on) => {
  const { ran, gitCalls } = setup(on, z('M  hooks/register.ts'))
  const r = await $.tool.call({ tool: 'Bash', command: HEREDOC_MESSAGE } as any)
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual([HEREDOC_MESSAGE])
  expect(gitCalls).toEqual([['git', '-C', 'C:/repo', 'status', '--porcelain=v1', '-z', '--untracked-files=normal']])
})

test('commit mentioning .env is denied while a .env file is staged', async ($, on) => {
  const { ran } = setup(on, z('A  .env', 'M  a.ts'))
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add .env"' } as any)
  expect(String(r.deny)).toContain('.env is staged or modified in C:/repo')
  expect(ran).toEqual([])
})

test('commit mentioning .env is denied while a .env file is modified in the working tree', async ($, on) => {
  setup(on, z(' M app/.env.local'))
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Tidy .env handling"' } as any)
  expect(String(r.deny)).toContain('app/.env.local')
})

test('commit mentioning .env is denied when git status fails', async ($, on) => {
  setup(on, null)
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Tidy .env handling"' } as any)
  expect(String(r.deny)).toContain('git status failed')
})

test('a .env read chained to a commit is denied without consulting git', async ($, on) => {
  const { gitCalls } = setup(on, z())
  const r = await $.tool.call({ tool: 'Bash', command: 'cat .env && git commit -m "x"' } as any)
  expect(String(r.deny)).toContain('references a .env file')
  expect(gitCalls).toEqual([])
})

test('a message expanding a .env read is denied', async ($, on) => {
  setup(on, z())
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "$(cat .env)"' } as any)
  expect(r.deny).toBeDefined()
})

test('configured wrapper commit mentioning .env runs with a clean tree', { options: { commitWrapper: 'format-commit-message.*\\s-c(\\s|$)' } }, async ($, on) => {
  const { ran } = setup(on, z())
  const cmd = 'format-commit-message.sh -c -q -C C:/r "Retire .env hooks"'
  const r = await $.tool.call({ tool: 'Bash', command: cmd } as any)
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual([cmd])
})

test('without a wrapper configured the same command is denied', async ($, on) => {
  setup(on, z())
  const r = await $.tool.call({ tool: 'Bash', command: 'format-commit-message.sh -c -q -C C:/r "Retire .env hooks"' } as any)
  expect(r.deny).toBeDefined()
})
