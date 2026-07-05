import type { PluginAPI } from '@ampcode/plugin'

/**
 * auto-loop
 *
 * Drives the agent in a continuous cycle until a breakout condition is met.
 * Inspired by mitsuhiko/agent-stuff/extensions/loop.ts.
 *
 * Usage:
 *   1. Run command palette: `auto-loop: start`
 *   2. Pick a mode (tests / custom / self) and provide a goal.
 *   3. The plugin re-injects a follow-up prompt on every agent.end until
 *      the agent calls `signal_loop_done` (registered tool below) or the
 *      max iteration count is reached.
 *   4. Stop early with: `auto-loop: stop`
 *
 * Limitations vs pi's version:
 *   - No persistent UI widget (Amp lacks setWidget). Status is delivered
 *     via notify() only.
 *   - State is held in-memory per plugin process (lost on plugin reload).
 */

type LoopMode = 'tests' | 'custom' | 'self'

interface LoopState {
  mode: LoopMode
  goal: string
  // Optional shell command (tests mode) to run between iterations
  testCommand?: string
  iteration: number
  maxIterations: number
}

const MAX_ITERATIONS_DEFAULT = 25

export default function (amp: PluginAPI) {
  // One active loop per thread.
  const loops = new Map<string, LoopState>()

  amp.registerTool({
    name: 'signal_loop_done',
    description:
      "Call this tool when the auto-loop's breakout condition is satisfied (e.g. tests pass, custom condition met, or self-judged complete). Calling this stops the auto-loop.",
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'A short explanation of why the loop is done.',
        },
      },
      required: ['reason'],
    },
    async execute(input) {
      const reason = (input.reason as string) ?? 'done'
      // Note: we cannot directly look up which thread this came from here
      // without ctx; we rely on agent.end clearing the loop state when no
      // continuation is desired. The agent calling this tool means its
      // next agent.end should NOT continue.
      // We use a sentinel via the global most-recent intent — see agent.end below.
      lastSignalReason = reason
      return `Loop signaled done: ${reason}`
    },
  })

  let lastSignalReason: string | null = null

  amp.registerCommand(
    'start',
    {
      title: 'Start auto-loop',
      category: 'auto-loop',
      description: 'Drive the agent in a continuous loop until a breakout condition is met.',
    },
    async (ctx) => {
      if (!ctx.thread) {
        await ctx.ui.notify('auto-loop: no active thread.')
        return
      }
      const threadId = ctx.thread.id
      if (loops.has(threadId)) {
        const replace = await ctx.ui.confirm({
          title: 'Loop already running',
          message: 'Replace the existing loop for this thread?',
          confirmButtonText: 'Replace',
        })
        if (!replace) return
      }

      const mode = (await ctx.ui.select({
        title: 'Loop mode',
        message: 'How should the loop decide when to stop?',
        options: ['tests — run tests until they pass', 'custom — natural-language condition', 'self — agent decides when it is done'],
      })) as string | undefined
      if (!mode) return

      const parsedMode: LoopMode = mode.startsWith('tests')
        ? 'tests'
        : mode.startsWith('custom')
          ? 'custom'
          : 'self'

      const goal = await ctx.ui.input({
        title: 'Loop goal',
        helpText:
          parsedMode === 'tests'
            ? 'What should the agent accomplish? (e.g. "make all tests pass after my refactor")'
            : parsedMode === 'custom'
              ? 'Describe the breakout condition in natural language.'
              : 'Describe the task. The agent will judge when it is complete.',
        submitButtonText: 'Start loop',
      })
      if (!goal) return

      let testCommand: string | undefined
      if (parsedMode === 'tests') {
        testCommand = await ctx.ui.input({
          title: 'Test command (optional)',
          helpText: 'Shell command the agent should run to verify (e.g. "npm test"). Leave blank to let the agent decide.',
          submitButtonText: 'OK',
        })
      }

      const state: LoopState = {
        mode: parsedMode,
        goal,
        testCommand: testCommand?.trim() || undefined,
        iteration: 0,
        maxIterations: MAX_ITERATIONS_DEFAULT,
      }
      loops.set(threadId, state)
      lastSignalReason = null

      await ctx.thread.append([
        {
          type: 'user-message',
          content: buildInitialPrompt(state),
        },
      ])
      await ctx.ui.notify(`auto-loop started (${parsedMode}). Use "auto-loop: stop" to cancel.`)
    },
  )

  amp.registerCommand(
    'stop',
    {
      title: 'Stop auto-loop',
      category: 'auto-loop',
      description: 'Stop the auto-loop running in this thread.',
    },
    async (ctx) => {
      if (!ctx.thread) return
      const had = loops.delete(ctx.thread.id)
      await ctx.ui.notify(had ? 'auto-loop stopped.' : 'auto-loop: no active loop in this thread.')
    },
  )

  amp.registerCommand(
    'status',
    {
      title: 'Show auto-loop status',
      category: 'auto-loop',
      description: 'Show whether an auto-loop is active in this thread.',
    },
    async (ctx) => {
      if (!ctx.thread) return
      const state = loops.get(ctx.thread.id)
      if (!state) {
        await ctx.ui.notify('auto-loop: not active.')
        return
      }
      await ctx.ui.notify(
        `auto-loop active\nmode: ${state.mode}\niteration: ${state.iteration}/${state.maxIterations}\ngoal: ${state.goal}`,
      )
    },
  )

  amp.on('agent.end', (event, ctx) => {
    if (!ctx.thread) return
    const state = loops.get(ctx.thread.id)
    if (!state) return

    // Did the agent call signal_loop_done this turn?
    const toolCalls = amp.helpers.toolCallsInMessages(event.messages)
    const signaled = toolCalls.some((tc: any) => tc?.tool === 'signal_loop_done' || tc?.name === 'signal_loop_done')
    if (signaled || lastSignalReason) {
      const reason = lastSignalReason ?? 'agent signaled completion'
      lastSignalReason = null
      loops.delete(ctx.thread.id)
      ctx.ui.notify(`auto-loop done: ${reason}`).catch(() => {})
      return
    }

    state.iteration += 1
    if (state.iteration >= state.maxIterations) {
      loops.delete(ctx.thread.id)
      ctx.ui.notify(`auto-loop hit max iterations (${state.maxIterations}). Stopping.`).catch(() => {})
      return
    }

    return {
      action: 'continue',
      userMessage: buildContinuePrompt(state),
    }
  })
}

function buildInitialPrompt(state: LoopState): string {
  const header = `[auto-loop:${state.mode}] You are now in an autonomous loop. After each turn this prompt will be re-sent until you call the \`signal_loop_done\` tool with a reason, or progress stalls.`
  const body =
    state.mode === 'tests'
      ? `Goal: ${state.goal}
${state.testCommand ? `Verification command: \`${state.testCommand}\`. Run it after each meaningful change.` : 'Decide an appropriate verification command and run it after each meaningful change.'}
When tests pass cleanly, call \`signal_loop_done\` with the result.`
      : state.mode === 'custom'
        ? `Goal: ${state.goal}
Breakout condition: same as the goal above. When that condition is satisfied, call \`signal_loop_done\` with the evidence.`
        : `Goal: ${state.goal}
You are the judge. Continue working until you are confident the task is complete, then call \`signal_loop_done\`.`
  return `${header}\n\n${body}`
}

function buildContinuePrompt(state: LoopState): string {
  return `[auto-loop:${state.mode}] Iteration ${state.iteration}/${state.maxIterations}. Continue working toward: ${state.goal}. Call \`signal_loop_done\` when the breakout condition is met.`
}
