import { expect, test } from 'claude-code/testing'
import { isSafeValue, redactEnv } from '../hooks/redact.ts'

const SAMPLE = [
  '# Database',
  'DB_HOST=db.internal.example.com',
  'DB_PORT=5432',
  'DB_PASSWORD=hunter2',
  'export DEBUG=true',
  'FEATURE_X="false"',
  "RETRIES='3'",
  'TIMEOUT_MS=30000 # thirty seconds',
  'EMPTY=',
  'NULLISH=null',
  'PIN_CODE=1234',
  'ACCOUNT_NUMBER=123456789012',
  'BIG=12345678901234',
  'RATIO=0.75',
  'HEX=0xdeadbeef',
  'URL=${BASE}/path',
  'PRIVATE_KEY="-----BEGIN KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  '-----END KEY-----"',
  'AFTER=yes',
  '# LOG_LEVEL=2',
  '# old token was abc123',
  'garbage line sk-live-abcdef',
  '',
].join('\r\n')

test('redactEnv keeps non-string values and line count, redacts the rest', () => {
  const out = redactEnv(SAMPLE).split('\n')
  expect(out).toEqual([
    '# [redacted comment]',
    'DB_HOST=[redacted]',
    'DB_PORT=5432',
    'DB_PASSWORD=[redacted]',
    'export DEBUG=true',
    'FEATURE_X="false"',
    "RETRIES='3'",
    'TIMEOUT_MS=30000',
    'EMPTY=',
    'NULLISH=null',
    'PIN_CODE=[redacted]',
    'ACCOUNT_NUMBER=[redacted]',
    'BIG=[redacted]',
    'RATIO=0.75',
    'HEX=[redacted]',
    'URL=[redacted]',
    'PRIVATE_KEY=[redacted]',
    '[redacted multiline value]',
    '[redacted multiline value]',
    'AFTER=yes',
    '# LOG_LEVEL=2',
    '# [redacted comment]',
    '[redacted line]',
    '',
  ])
  for (const secret of ['hunter2', 'MIIE', 'abc123', 'sk-live', 'db.internal', 'deadbeef']) expect(out.join('\n')).not.toContain(secret)
})

test('redactEnv: an unclosed quote redacts every following line', () => {
  expect(redactEnv('A="open\nB=1\nC=true')).toBe('A=[redacted]\n[redacted multiline value]\n[redacted multiline value]')
})

test('redactEnv: escaped quote inside a double-quoted value does not close it', () => {
  expect(redactEnv('A="x\\"\nB=1"\nC=2')).toBe('A=[redacted]\n[redacted multiline value]\nC=2')
})

test('isSafeValue: numbers under secret-like keys are redacted', () => {
  expect(isSafeValue('PORT', '8080')).toBe(true)
  expect(isSafeValue('API_KEY', '8080')).toBe(false)
  expect(isSafeValue('OTP_SEED', '123456')).toBe(false)
  expect(isSafeValue('API_KEY_ENABLED', 'true')).toBe(true)
  expect(isSafeValue('NAME', 'True')).toBe(true)
  expect(isSafeValue('NAME', 'alice')).toBe(false)
})

const readResult = (content: string) => ({
  type: 'text',
  file: { filePath: '/repo/.env', content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length },
})

test('Read of a .env file returns redacted content', async ($, on) => {
  let seen: any
  on('tool.call', (_$: any, e: any) => ((seen = e), { result: readResult('A=1\nB=secret\nC=false') }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/repo/.env' } as any)
  expect((r.result as any).file.content).toBe('A=1\nB=[redacted]\nC=false')
  expect(String(r.context)).toContain('redacted')
  expect(seen.file_path).toBe('/repo/.env')
})

test('Read of a .env file with offset/limit reads whole, then windows the redacted text', async ($, on) => {
  let seen: any
  on('tool.call', (_$: any, e: any) => ((seen = e), { result: readResult('K="a\nb"\nC=1\nD=2') }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/repo/.env.local', offset: 2, limit: 2 } as any)
  expect(seen.offset).toBe(undefined)
  expect(seen.limit).toBe(undefined)
  const file = (r.result as any).file
  expect(file.content).toBe('[redacted multiline value]\nC=1')
  expect(file.startLine).toBe(2)
  expect(file.numLines).toBe(2)
})

test('Read of a .env file with non-text content is withheld', async ($, on) => {
  on('tool.call', () => ({ result: { type: 'image', file: { base64: 'x', type: 'image/png', originalSize: 1 } } }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/repo/.env' } as any)
  expect(String(r.deny)).toContain('withheld')
})

test('Edit and Write of a .env file are denied before the tool runs', async ($, on) => {
  let ran = false
  on('tool.call', () => ((ran = true), { result: 'ran' }))
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/.env', old_string: 'a', new_string: 'b' } as any)
  const write = await $.tool.call({ tool: 'Write', file_path: 'C:\\repo\\.env.prod', content: 'X=1' } as any)
  expect(String(edit.deny)).toContain('Edit blocked')
  expect(String(write.deny)).toContain('Write blocked')
  expect(ran).toBe(false)
})
