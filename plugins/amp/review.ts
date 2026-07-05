import type { PluginAPI } from '@ampcode/plugin'
import { execSync } from 'node:child_process'

/**
 * review
 *
 * Opinionated code-review command. Lets the user pick a review target
 * (uncommitted changes, base branch, commit, or folder), then injects a
 * detailed review rubric + target-specific instructions as a user message
 * so the agent produces prioritized, actionable findings.
 *
 * Companion commands:
 *   - `review: fix`        — tell the agent to implement findings in priority order
 *   - `review: summarize`  — collapse findings into a structured handoff
 *
 * Inspired by mitsuhiko/agent-stuff/extensions/review.ts (which itself is
 * inspired by Codex's review feature). Adapted for Amp's flat thread model
 * (no session tree, so we skip branch/return semantics and the session-state
 * persistence; review state lives only in the conversation).
 */

type Target =
  | { kind: 'uncommitted' }
  | { kind: 'baseBranch'; baseBranch: string; mergeBase: string }
  | { kind: 'commit'; sha: string; title: string }
  | { kind: 'folder'; paths: string[] }

const REVIEW_RUBRIC = `You are acting as a senior code reviewer. Be precise, terse, and useful. Do not flatter.

What to flag
- Only call out things that are actionable, provably introduced or affected by the changes under review, and likely to cause real harm (correctness, security, data integrity, performance regressions, operational risk).
- Do not nitpick style, formatting, or naming unless it actively obscures intent.
- Do not flag intentional design choices unless they are wrong.
- Do not invent bugs you cannot ground in the diff or surrounding code.

Untrusted user input
- Open redirects, SQL/command injection, SSRF, path traversal, missing escaping/encoding, missing authn/authz checks, secrets in logs.

Fail-fast error handling
- Reject try/catch that silently swallows errors. Errors should propagate or be logged loudly with context.
- JSON.parse, network calls, and subprocess invocations must fail loudly on unexpected input.
- No empty catch blocks; no catch-and-return-default unless the default is documented as the contract.

Review priorities (highest → lowest)
- Data migrations, auth/authz changes, destructive operations, back-pressure / queue handling, concurrency, error handling, then everything else.

Required human callouts (non-blocking, but list them)
- New dependencies, lockfile changes, schema migrations, breaking API changes, destructive ops, auth changes.

Comments
- Brief. Cite file:line. When you propose a code change, show it as a fenced \`suggestion\` block. No flattery.

Priority tags
- [P0] drop everything (data loss, security, broken prod path)
- [P1] must fix before merge
- [P2] should fix before merge
- [P3] nice to have / follow-up

Output format
- Start with a one-line **Verdict**: \`correct\` or \`needs attention\`.
- Then **Findings**, ordered by priority, each: \`[Px] path/to/file:line — short title\`, followed by 1–3 lines of *why* and *what*, plus an optional \`suggestion\` block.
- Then **Human Reviewer Callouts** (bulleted list, may be empty).
- Then **Fix Queue**: an ordered checklist of exact actions in priority order.`

const REVIEW_SUMMARY_PROMPT = `Summarize the latest review into a structured handoff. Use exactly these sections, in order:

1. **Review Scope** — one line describing what was reviewed.
2. **Verdict** — \`correct\` or \`needs attention\`.
3. **Findings** — each item: \`[Px] path:line — title\`, then 1–3 lines describing why and what to do.
4. **Fix Queue** — ordered checklist of concrete actions, highest priority first.
5. **Constraints & Preferences** — any constraints discovered during review (frameworks, conventions, perf budgets).
6. **Human Reviewer Callouts** — items that need a human decision (new deps, migrations, breaking changes, destructive ops, auth changes).

Do not add commentary outside these sections.`

const REVIEW_FIX_PROMPT = `Use the latest review findings in this thread and implement them now.

Rules:
- Fix in priority order: P0 → P1 → P2. Skip P3 unless trivial.
- After each meaningful change, run the project's test or check command and verify it passes.
- Apply fail-fast error handling: errors must propagate or be logged loudly, never silently swallowed.
- If a finding is wrong or based on a misreading, say so explicitly and skip it — do not invent fixes.
- When done, post a short report listing each finding and its disposition (fixed / skipped + reason).`

export default function (amp: PluginAPI) {
  amp.registerCommand(
    'start',
    {
      title: 'Start code review',
      category: 'review',
      description: 'Run an opinionated code review on uncommitted changes, a base-branch diff, a commit, or a folder.',
    },
    async (ctx) => {
      if (!ctx.thread) {
        await ctx.ui.notify('review: no active thread.')
        return
      }
      if (!isGitRepo()) {
        await ctx.ui.notify('review: not in a git repository.')
        return
      }

      const choice = await ctx.ui.select({
        title: 'Review target',
        message: 'What should be reviewed?',
        options: [
          'uncommitted — staged, unstaged, and untracked working-tree changes',
          'base branch — PR-style diff against a local branch',
          'commit — a specific commit SHA',
          'folder — snapshot review of specific paths (no diff)',
        ],
      })
      if (!choice) return

      let target: Target
      try {
        if (choice.startsWith('uncommitted')) {
          if (!hasUncommittedChanges()) {
            await ctx.ui.notify('review: no uncommitted changes detected.')
            return
          }
          target = { kind: 'uncommitted' }
        } else if (choice.startsWith('base branch')) {
          const fallback = detectDefaultBranch()
          const baseBranch = await ctx.ui.input({
            title: 'Base branch',
            helpText: `Local branch to diff against. Default detected: ${fallback}`,
            submitButtonText: 'Use branch',
          })
          const branch = (baseBranch?.trim() || fallback).trim()
          if (!branch) return
          let mergeBase: string
          try {
            mergeBase = git(`merge-base HEAD ${shellEscape(branch)}`).trim()
          } catch {
            await ctx.ui.notify(`review: could not find merge base with '${branch}'.`)
            return
          }
          if (!mergeBase) {
            await ctx.ui.notify(`review: empty merge base with '${branch}'.`)
            return
          }
          target = { kind: 'baseBranch', baseBranch: branch, mergeBase }
        } else if (choice.startsWith('commit')) {
          const recent = recentCommitsList()
          const shaInput = await ctx.ui.input({
            title: 'Commit SHA',
            helpText: recent ? `Full or short SHA. Recent:\n${recent}` : 'Full or short SHA.',
            submitButtonText: 'Review commit',
          })
          const sha = shaInput?.trim()
          if (!sha) return
          let title = ''
          try {
            title = git(`log -1 --pretty=%s ${shellEscape(sha)}`).trim()
          } catch {
            await ctx.ui.notify(`review: unknown commit '${sha}'.`)
            return
          }
          target = { kind: 'commit', sha, title }
        } else {
          const pathInput = await ctx.ui.input({
            title: 'Paths',
            helpText: 'Space-separated file or directory paths to review.',
            submitButtonText: 'Review paths',
          })
          const paths = (pathInput ?? '').split(/\s+/).map((p) => p.trim()).filter(Boolean)
          if (paths.length === 0) return
          target = { kind: 'folder', paths }
        }
      } catch (err) {
        await ctx.ui.notify(`review: ${(err as Error).message}`)
        return
      }

      const prompt = `${REVIEW_RUBRIC}\n\n---\n\n${buildTargetPrompt(target)}`
      await ctx.thread.append([{ type: 'user-message', content: prompt }])
      await ctx.ui.notify(`review: started (${target.kind}).`)
    },
  )

  amp.registerCommand(
    'fix',
    {
      title: 'Apply review findings',
      category: 'review',
      description: 'Have the agent implement the latest review findings in priority order.',
    },
    async (ctx) => {
      if (!ctx.thread) return
      await ctx.thread.append([{ type: 'user-message', content: REVIEW_FIX_PROMPT }])
      await ctx.ui.notify('review: implementing findings.')
    },
  )

  amp.registerCommand(
    'summarize',
    {
      title: 'Summarize review findings',
      category: 'review',
      description: 'Collapse the latest review into a structured handoff.',
    },
    async (ctx) => {
      if (!ctx.thread) return
      await ctx.thread.append([{ type: 'user-message', content: REVIEW_SUMMARY_PROMPT }])
      await ctx.ui.notify('review: summarizing.')
    },
  )
}

function buildTargetPrompt(target: Target): string {
  switch (target.kind) {
    case 'uncommitted':
      return [
        'Review the current working-tree changes (staged, unstaged, and untracked files) and provide prioritized findings.',
        'Use `git status --porcelain`, `git diff`, `git diff --staged`, and `git ls-files --others --exclude-standard` to enumerate the changes.',
      ].join(' ')
    case 'baseBranch':
      return [
        `Review the code changes against the base branch '${target.baseBranch}'.`,
        `The merge base commit for this comparison is ${target.mergeBase}.`,
        `Run \`git diff ${target.mergeBase}\` to inspect the changes, then read surrounding code as needed for context.`,
      ].join(' ')
    case 'commit':
      return [
        `Review the code changes introduced by commit ${target.sha}${target.title ? ` ("${target.title}")` : ''}.`,
        `Run \`git show ${target.sha}\` to inspect the change, then read surrounding code as needed.`,
      ].join(' ')
    case 'folder': {
      const list = target.paths.map((p) => `\`${p}\``).join(', ')
      return [
        `Review the code in the following paths: ${list}.`,
        'This is a snapshot review (not a diff). Read the files directly and assess them holistically against the rubric.',
      ].join(' ')
    }
  }
}

function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function hasUncommittedChanges(): boolean {
  try {
    return git('status --porcelain').trim().length > 0
  } catch {
    return false
  }
}

function detectDefaultBranch(): string {
  try {
    const ref = git('symbolic-ref refs/remotes/origin/HEAD --short').trim()
    return ref.replace(/^origin\//, '') || 'main'
  } catch {
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        git(`rev-parse --verify ${candidate}`)
        return candidate
      } catch {
        // try next
      }
    }
    return 'main'
  }
}

function recentCommitsList(): string {
  try {
    return git('log --oneline -n 10').trim()
  } catch {
    return ''
  }
}

function shellEscape(s: string): string {
  // Conservative: only allow safe chars; otherwise single-quote.
  if (/^[a-zA-Z0-9._\/-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
