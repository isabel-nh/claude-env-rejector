import type { Register } from 'claude-code'
import { compileWrapper, envFilesInStatus, splitCommit, STATUS_ARGS } from './commit.ts'
import { bashVerdict, isEnvGlob, isEnvPath, isEnvResultLine, type BashVerdict } from './rules.ts'

const ASK = 'These files commonly contain secrets. Ask the user to share specific values directly if needed.'

const REASON: Record<Exclude<BashVerdict, 'allow'>, string> = {
  deny: `Bash blocked: the command references a .env file. ${ASK}`,
  'deny-git': 'Bash blocked: the git command references a .env file other than .env.example, the only one permitted.',
}

// Fail-closed: a guard that crashes before the tool runs denies; one that crashes after
// withholds the result.
export const register: Register = (on, options) => {
  const wrapper = compileWrapper(options.commitWrapper)

  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    isEnvPath(e.file_path) ? { deny: `${$.plugin.name}: Read blocked: .env files are off-limits (${e.file_path}). ${ASK}` } : next(e),
  ).catch($ => ({ deny: `${$.plugin.name}: its Read guard failed.` }))

  // A commit whose message mentions .env is denied only while git reports a .env file
  // staged, modified or untracked in that repository.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = bashVerdict(e.command)
    if (verdict === 'allow') return next(e)
    const deny = { deny: `${$.plugin.name}: ${REASON[verdict]}` }

    if (!/\bcommit\b/.test(e.command) && !wrapper?.test(e.command)) return deny
    const commit = splitCommit(e.command, await $.session.cwd(), wrapper)
    if (commit === undefined || commit.isUnsafe) return deny
    const restVerdict = bashVerdict(commit.rest)
    if (restVerdict !== 'allow') return { deny: `${$.plugin.name}: ${REASON[restVerdict]}` }

    const status = await $.process.run(STATUS_ARGS(commit.repo), { timeoutMs: 15_000 })
    if (status.exitCode !== 0) return { deny: `${$.plugin.name}: Bash blocked: the commit message mentions .env and git status failed in ${commit.repo}, so no .env file could be ruled out.` }
    const envFiles = envFilesInStatus(status.stdout)
    if (envFiles.length > 0) return { deny: `${$.plugin.name}: Bash blocked: the commit message mentions .env while ${envFiles.join(', ')} ${envFiles.length === 1 ? 'is' : 'are'} staged or modified in ${commit.repo}.` }
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
