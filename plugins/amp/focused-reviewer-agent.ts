// .amp/plugins/focused-reviewer-agent.ts
import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
    // Create the agent
    const reviewer = amp.createAgent({
        name: 'focused-reviewer',
        model: 'openai/gpt-5.5',
        instructions: [
            'You are a focused code-review subagent.',
            'Inspect only the files and concerns named by the caller.',
            'Return concise findings with severity, evidence, and suggested fixes.',
        ].join(' '),
        tools: 'all',
        display: { label: 'reviewer', color: '#d97706' },
    })

    // Register a tool. This agent acts as a subagent
    amp.registerTool({
        name: 'focused_review',
        description: 'Run a focused code-review subagent.',
        inputSchema: {
            type: 'object',
            properties: {
                request: { type: 'string' },
            },
            required: ['request'],
        },

        async execute(input, ctx) {
            // Run a one-shot agent turn
            const result = await reviewer.run(input, {
                parentThreadID: ctx.thread.id,
            })
            return result.text
        },
    })

    amp.registerTool({
        name: 'start_async_review',
        description: 'Start a review in a background thread.',
        inputSchema: { type: 'object', properties: {} },
        async execute(_input, ctx) {
            const thread = await reviewer.createThread({
                parentThreadID: ctx.thread.id,
            })

            await thread.appendUserMessage({
                type: 'user-message',
                content: [
                    'Review the auth changes in this branch.',
                    `When you are done, call send_to_thread with threadID ${ctx.thread.id}`,
                    'and include your review in the message.',
                ].join(' '),
            })

            return `Started background review in ${thread.id}.`
        },
    })

    // Or register the agent as a selectable main thread mode
    amp.registerAgentMode({
        key: 'focused-reviewer',
        description: 'Code Review Expert',
        agent: reviewer.definition,
    })
}
