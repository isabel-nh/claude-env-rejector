import type { EngineInterface, HookFailure, Register } from 'claude-code'
import { compileWrapper, envFilesInStatus, splitCommit, STATUS_ARGS } from './commit.ts'
import { redactEnv } from './redact.ts'
import { bashVerdict, isEnvGlob, isEnvPath, isEnvResultLine, type BashVerdict } from './rules.ts'

const ASK = 'These files commonly contain secrets. Ask the user to share specific values directly if needed.'

const REASON: Record<Exclude<BashVerdict, 'allow'>, string> = {
  deny: `Bash blocked: the command references a .env file. Read it instead: Read returns it with secret values redacted. ${ASK}`,
  'deny-git': 'Bash blocked: the git command references a .env file other than .env.example, the only one permitted.',
}

// A path whose name, or whose symlink target's name, is a .env file.
async function targetsEnv($: EngineInterface, path: string): Promise<boolean> {
  if (isEnvPath(path)) return true
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.realPath !== undefined && isEnvPath(stat.realPath)
}

// Why a guard failed, for its deny reason.
const cause = (error: HookFailure): string => `${error.kind}${error.message === undefined ? '' : `: ${error.message}`}`

// Fail-closed: a guard that crashes before the tool runs denies; one that crashes after
// withholds the result. A Bash failure after next was called replays what the command
// settled to, since the guard had already allowed it.
export const register: Register = (on, options) => {
  const wrapper = compileWrapper(options.commitWrapper)

  // A .env Read runs on the whole file so a multiline value opened before `offset` stays
  // redacted, then the requested window is cut from the redacted text.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!(await targetsEnv($, e.file_path))) return next(e)
    const { offset, limit, ...whole } = e
    const ran = await next(whole)
    if (ran.deny !== undefined || ran.isError) return ran
    if (ran.result.type !== 'text') return { deny: `${$.plugin.name}: Read of ${e.file_path} returned ${ran.result.type} content, which cannot be redacted; result withheld.` }

    const lines = redactEnv(ran.result.file.content).split('\n')
    const startLine = Math.max(1, offset ?? 1)
    const window = lines.slice(startLine - 1, limit === undefined ? undefined : startLine - 1 + limit)
    const file = { ...ran.result.file, content: window.join('\n'), numLines: window.length, startLine }
    return { result: { ...ran.result, file }, context: [`${$.plugin.name}: ${e.file_path} was redacted: only key names, booleans, null words, empty values and short numbers under non-secret keys are shown. ${ASK}`] }
  }).catch(($, e, next) => (next.called ? { deny: `${$.plugin.name}: its Read redaction failed (${cause(next.error)}); result withheld.` } : { deny: `${$.plugin.name}: its Read guard failed (${cause(next.error)}).` }))

  // Edit and Write echo file contents back and would overwrite values the model never saw.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = 'file_path' in e ? e.file_path : e.notebook_path
    return (await targetsEnv($, path)) ? { deny: `${$.plugin.name}: ${e.tool} blocked: .env files are read-only through redacted Read. Ask the user to make the change.` } : next(e)
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: its edit guard failed (${cause(next.error)}).` }))

  // A .env mention in a gh / az PR title or body runs. A commit whose message mentions .env
  // is denied only while git reports a .env file staged, modified or untracked in that repository.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = bashVerdict(e.command)
    if (verdict === 'allow') return next(e)
    const deny = { deny: `${$.plugin.name}: ${REASON[verdict]}` }

    if (!/\b(commit|pr)\b/.test(e.command) && !wrapper?.test(e.command)) return deny
    const commit = splitCommit(e.command, await $.session.cwd(), wrapper)
    if (commit === undefined || commit.isUnsafe) return deny
    const restVerdict = bashVerdict(commit.rest)
    if (restVerdict !== 'allow') return { deny: `${$.plugin.name}: ${REASON[restVerdict]}` }
    if (commit.repo === undefined) return next(e)

    const status = await $.process.run(STATUS_ARGS(commit.repo), { timeoutMs: 15_000 })
    if (status.exitCode !== 0) return { deny: `${$.plugin.name}: Bash blocked: the commit message mentions .env and git status failed in ${commit.repo}, so no .env file could be ruled out.` }
    const envFiles = envFilesInStatus(status.stdout)
    if (envFiles.length > 0) return { deny: `${$.plugin.name}: Bash blocked: the commit message mentions .env while ${envFiles.join(', ')} ${envFiles.length === 1 ? 'is' : 'are'} staged or modified in ${commit.repo}.` }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its Bash guard failed before the command ran (${cause(next.error)}). The command did not run; it is safe to retry.` },
  )

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    if (e.path !== undefined && isEnvPath(e.path)) return { deny: `${$.plugin.name}: Grep blocked: search .env files with Read, which redacts secret values (${e.path}). ${ASK}` }
    if (e.glob !== undefined && isEnvGlob(e.glob)) return { deny: `${$.plugin.name}: Grep blocked: the glob ${e.glob} targets .env files; Read them instead, which redacts secret values. ${ASK}` }

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
  }).catch(($, e, next) => (next.called ? { deny: `${$.plugin.name}: its Grep filter failed (${cause(next.error)}); result withheld.` } : { deny: `${$.plugin.name}: its Grep guard failed (${cause(next.error)}).` }))
}
