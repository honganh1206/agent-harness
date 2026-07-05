import type { PluginAPI } from '@ampcode/plugin'

/**
 * dangerous-command-guard
 *
 * Intercepts shell tool calls. For commands that look obviously destructive,
 * shows a confirmation dialog before allowing them. For ambiguous commands,
 * asks the AI for a quick yes/no classification and confirms only when the AI
 * thinks the command is destructive with high confidence.
 *
 * Cheap commands (the vast majority) pass through with no prompt and no AI call.
 */

// Patterns that are obviously dangerous — short-circuit the AI classifier.
const HARD_DANGER_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-rf|-fr)\b/i,
  /\brm\s+-[a-zA-Z]*f.*\s\/(\s|$)/i, // rm -f /
  /\bmkfs\.[a-z0-9]+\b/i,
  /\bdd\s+if=.*\s+of=\/dev\//i,
  /:\s*\(\s*\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, // fork bomb
  /\bgit\s+push\b.*--force(?!-with-lease)/i,
  /\bgit\s+push\b.*\s-f(\s|$)(?!.*--force-with-lease)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+[0-7]{3,4}\s+\//i,
  /\bchown\s+-R\b.*\s\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  />\s*\/dev\/sd[a-z]/i,
]

// Patterns we always allow without any prompt (avoid noise on the common case).
const ALWAYS_SAFE_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|wc|grep|rg|fd|find|file|stat|pwd|echo|which|whereis|whoami|id|date|uname|env|printenv)\b/i,
  /^\s*git\s+(status|log|diff|show|blame|branch|tag|remote|config\s+--get|rev-parse|describe|fetch|ls-files)\b/i,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run|ls|list|outdated|view|info)\b/i,
  /^\s*(go|cargo|python|node|deno|bun)\s+(test|build|check|vet|fmt|version|--version)\b/i,
  /^\s*kubectl\s+(get|describe|logs|explain|version|api-resources)\b/i,
  /^\s*docker\s+(ps|images|inspect|logs|version|info)\b/i,
]

export default function (amp: PluginAPI) {
  amp.on('tool.call', async (event, ctx) => {
    const shell = amp.helpers.shellCommandFromToolCall(event)
    if (!shell?.command) return { action: 'allow' }

    const cmd = shell.command.trim()

    if (ALWAYS_SAFE_PATTERNS.some((re) => re.test(cmd))) {
      return { action: 'allow' }
    }

    // Hard-coded dangerous patterns: always confirm.
    if (HARD_DANGER_PATTERNS.some((re) => re.test(cmd))) {
      const ok = await ctx.ui.confirm({
        title: 'Dangerous command detected',
        message: `Allow this potentially destructive command?\n\n${truncate(cmd, 600)}`,
        confirmButtonText: 'Run it',
      })
      return ok
        ? { action: 'allow' }
        : {
            action: 'reject-and-continue',
            message: 'User declined to run the command. Reconsider a safer approach.',
          }
    }

    // Ambiguous: ask AI. Skip very short or pure-read invocations to save tokens.
    if (cmd.length < 8) return { action: 'allow' }

    let classification
    try {
      classification = await amp.ai.ask(
        `Is the following shell command destructive, irreversible, or likely to affect resources outside the local working directory (e.g. deletes data, force-pushes git, drops databases, modifies system files, sends network requests with side effects)? Command:\n\n${cmd}`,
      )
    } catch {
      // If the classifier fails, fail open — don't block normal work.
      return { action: 'allow' }
    }

    if (classification.result === true && classification.probability >= 0.75) {
      const ok = await ctx.ui.confirm({
        title: 'Possibly destructive command',
        message: `AI says this command may be destructive (${Math.round(
          classification.probability * 100,
        )}% confidence):\n\n${truncate(cmd, 600)}\n\nReason: ${classification.reason}`,
        confirmButtonText: 'Run it',
      })
      return ok
        ? { action: 'allow' }
        : {
            action: 'reject-and-continue',
            message: `User declined: ${classification.reason}`,
          }
    }

    return { action: 'allow' }
  })
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s
}
