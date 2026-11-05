import { expect, test } from 'claude-code/testing'
import { bashVerdict, isEnvGlob, isEnvPath } from '../hooks/rules.ts'

const answered = (on: any, result: unknown = 'ran') => on('tool.call', () => ({ result }))

test('isEnvPath: .env and .env.* basenames only', () => {
  for (const p of ['/repo/.env', 'C:\\repo\\.env.local', '.env.example', 'a/.env.production/']) expect(isEnvPath(p)).toBe(true)
  for (const p of ['/repo/src/Program.cs', 'myproject.environment', '/repo/.envrc', '/repo/env', 'C:/x/prod.env']) expect(isEnvPath(p)).toBe(false)
})

test('isEnvGlob: positive .env globs only', () => {
  for (const g of ['.env', '.env*', '**/.env.*', '{*.cs,.env}']) expect(isEnvGlob(g)).toBe(true)
  for (const g of ['*.cs', '!.env', '**/*.ts', '*.environment']) expect(isEnvGlob(g)).toBe(false)
})

test('bashVerdict: non-git commands deny, git allows only .env.example', () => {
  expect(bashVerdict('ls -la /tmp')).toBe('allow')
  expect(bashVerdict('cat .env.production')).toBe('deny')
  expect(bashVerdict('head -5 "C:/repo/.env"')).toBe('deny')
  expect(bashVerdict('cp .env /tmp/x')).toBe('deny')
  expect(bashVerdict('git diff .env.example')).toBe('allow')
  expect(bashVerdict('cd repo && git add .env.example')).toBe('allow')
  expect(bashVerdict('git diff .env.production')).toBe('deny-git')
  expect(bashVerdict('git diff .env.example .env')).toBe('deny-git')
  expect(bashVerdict('echo preventing myproject.environment')).toBe('allow')
})

test('Read of a .env file is denied before the tool runs', async ($, on) => {
  let ran = false
  on('tool.call', () => ((ran = true), { result: 'ran' }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/repo/.env' } as any)
  expect(String(r.deny)).toContain('Read blocked')
  expect(ran).toBe(false)
})

test('Read of an ordinary file passes', async ($, on) => {
  answered(on)
  const r = await $.tool.call({ tool: 'Read', file_path: '/repo/src/Program.cs' } as any)
  expect(r.result).toBe('ran')
})

test('Bash cat .env is denied; git on .env.example passes', async ($, on) => {
  answered(on)
  const denied = await $.tool.call({ tool: 'Bash', command: 'cat .env' } as any)
  expect(String(denied.deny)).toContain('Bash blocked')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'git diff .env.example' } as any)
  expect(allowed.result).toBe('ran')
})

test('Grep with a .env path or glob is denied', async ($, on) => {
  answered(on)
  const byPath = await $.tool.call({ tool: 'Grep', pattern: 'KEY', path: 'C:/repo/.env.local' } as any)
  expect(String(byPath.deny)).toContain('Grep blocked')
  const byGlob = await $.tool.call({ tool: 'Grep', pattern: 'KEY', glob: '**/.env*' } as any)
  expect(String(byGlob.deny)).toContain('Grep blocked')
})

test('Grep over a directory strips .env hits from files and content', async ($, on) => {
  answered(on, {
    mode: 'content',
    numFiles: 2,
    filenames: ['C:\\repo\\.env', 'C:\\repo\\src\\a.cs'],
    content: 'C:\\repo\\.env:3:DB_PASSWORD=hunter2\nC:\\repo\\src\\a.cs:9:var DB_PASSWORD = Get();',
    numLines: 2,
  })
  const r = await $.tool.call({ tool: 'Grep', pattern: 'DB_PASSWORD', path: 'C:/repo', output_mode: 'content' } as any)
  const result = r.result as any
  expect(result.filenames).toEqual(['C:\\repo\\src\\a.cs'])
  expect(result.numFiles).toBe(1)
  expect(result.content).toBe('C:\\repo\\src\\a.cs:9:var DB_PASSWORD = Get();')
  expect(result.numLines).toBe(1)
  expect(String(result.content)).not.toContain('hunter2')
})

test('Grep count mode recomputes numMatches', async ($, on) => {
  answered(on, { mode: 'count', numFiles: 2, filenames: [], content: '/r/.env.local:4\n/r/a.ts:2', numMatches: 6 })
  const r = await $.tool.call({ tool: 'Grep', pattern: 'x', output_mode: 'count' } as any)
  expect((r.result as any).numMatches).toBe(2)
  expect((r.result as any).content).toBe('/r/a.ts:2')
})

test('Grep with no .env hits returns the result untouched', async ($, on) => {
  const clean = { mode: 'files_with_matches', numFiles: 1, filenames: ['/r/a.ts'] }
  answered(on, clean)
  const r = await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
  expect(r.result).toEqual(clean)
})
