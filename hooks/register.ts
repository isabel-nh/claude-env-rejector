import type { Register } from 'claude-code'
import { bashVerdict, isEnvGlob, isEnvPath, isEnvResultLine } from './rules.ts'

const ASK = 'These files commonly contain secrets. Ask the user to share specific values directly if needed.'

// Fail-closed: a guard that crashes before the tool runs denies; one that crashes after
// withholds the result.
export const register: Register = on => {
  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    isEnvPath(e.file_path) ? { deny: `${$.plugin.name}: Read blocked: .env files are off-limits (${e.file_path}). ${ASK}` } : next(e),
  ).catch($ => ({ deny: `${$.plugin.name}: its Read guard failed.` }))

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const verdict = bashVerdict(e.command)
    if (verdict === 'deny') return { deny: `${$.plugin.name}: Bash blocked: the command references a .env file. ${ASK}` }
    if (verdict === 'deny-git') return { deny: `${$.plugin.name}: Bash blocked: the git command references a .env file other than .env.example, the only one permitted.` }
    return next(e)
  }).catch($ => ({ deny: `${$.plugin.name}: its Bash guard failed.` }))

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    if (e.path !== undefined && isEnvPath(e.path)) return { deny: `${$.plugin.name}: Grep blocked: .env files are off-limits (${e.path}). ${ASK}` }
    if (e.glob !== undefined && isEnvGlob(e.glob)) return { deny: `${$.plugin.name}: Grep blocked: the glob ${e.glob} targets .env files. ${ASK}` }

    // A directory search still reaches .env files: strip their hits from the result.
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const r = ran.result
    const filenames = r.filenames.filter(f => !isEnvPath(f))
    const lines = r.content?.split('\n')
    const kept = lines?.filter(line => !isEnvResultLine(line))
    if (filenames.length === r.filenames.length && kept?.length === lines?.length) return ran

    const result = { ...r, filenames, numFiles: filenames.length }
    if (kept !== undefined) {
      result.content = kept.join('\n')
      result.numLines = kept.filter(line => line !== '').length
      if (r.mode === 'count') result.numMatches = kept.reduce((sum, line) => sum + Number(/:(\d+)$/.exec(line)?.[1] ?? 0), 0)
    }
    return { result, context: [...(ran.context ?? []), `${$.plugin.name}: matches inside .env files were removed from this result.`] }
  }).catch(($, e, next) => (next.called ? { deny: `${$.plugin.name}: its Grep filter failed; result withheld.` } : { deny: `${$.plugin.name}: its Grep guard failed.` }))
}
