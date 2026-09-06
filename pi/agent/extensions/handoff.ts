/**
 * Automatic handoff extension.
 *
 * When a settled session reaches the context threshold, summarize the active
 * branch into a self-contained continuation prompt, create a linked session,
 * and immediately continue there.
 */

import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const HANDOFF_THRESHOLD_PERCENT = 80;
const INTERNAL_COMMAND = "handoff-auto";
const SWITCH_EVENT = "handoff:auto-switch";
const HANDOFF_MARKER = "handoff:auto-session";

const SYSTEM_PROMPT = `You are a context transfer assistant. Convert the conversation history into a concise, self-contained prompt that lets a fresh coding agent continue the current task without access to the old conversation.

Include only information needed to continue:
- the user's current objective and acceptance criteria
- work completed and the current implementation state
- decisions, constraints, and approaches that must be preserved
- relevant files, symbols, commands, tests, errors, and pending changes
- unresolved questions or risks
- the next concrete steps

Do not claim that work was done unless the conversation confirms it. Preserve exact file paths and technical details. Omit obsolete or unrelated discussion. Tell the new agent to inspect the working tree, continue autonomously, and verify its work. Do not add a preamble such as "Here is the prompt".`;

function getHandoffMarkerId(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === HANDOFF_MARKER) {
			return entry.id;
		}
	}
	return undefined;
}

async function generateHandoffPrompt(ctx: ExtensionCommandContext): Promise<string> {
	if (!ctx.model) {
		throw new Error("No model selected");
	}

	// Use Pi's compaction-aware context builder so branch summaries and custom
	// context messages are preserved using the same projection as an agent turn.
	const messages = ctx.sessionManager.buildSessionContext().messages;
	if (messages.length === 0) {
		throw new Error("No conversation to hand off");
	}

	const conversationText = serializeConversation(convertToLlm(messages));
	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);
	const prompt = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();

	if (!prompt) {
		throw new Error(`Handoff generation returned no text (${response.stopReason})`);
	}
	return prompt;
}

export default function (pi: ExtensionAPI) {
	let handoffQueued = false;
	let handoffInProgress = false;
	let sourceSessionFile: string | undefined;
	let suppressedHandoffMarkerId: string | undefined;

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || handoffQueued || handoffInProgress || !ctx.model) {
			return;
		}

		// A replacement runtime reloads this extension with fresh in-memory state.
		// Suppress its first settled turn so a large continuation prompt cannot
		// cause an immediate handoff loop.
		const markerId = getHandoffMarkerId(ctx);
		if (markerId !== undefined && markerId !== suppressedHandoffMarkerId) {
			suppressedHandoffMarkerId = markerId;
			return;
		}

		const percent = ctx.getContextUsage()?.percent;
		if (percent === null || percent === undefined || percent < HANDOFF_THRESHOLD_PERCENT) {
			return;
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			return;
		}

		handoffQueued = true;
		sourceSessionFile = sessionFile;
		ctx.ui.notify(`Context is ${Math.round(percent)}% full. Starting automatic handoff...`, "info");

		try {
			pi.sendUserMessage(`/${INTERNAL_COMMAND}`, { expandPromptTemplates: true });
		} catch (error) {
			handoffQueued = false;
			sourceSessionFile = undefined;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not start automatic handoff: ${message}`, "error");
		}
	});

	pi.registerCommand(INTERNAL_COMMAND, {
		description: "Force an automatic-style handoff now (normally runs at 80%)",
		handler: async (args, ctx) => {
			const forced = args.trim() === "force";
			if (forced && !handoffQueued && !handoffInProgress) {
				sourceSessionFile = ctx.sessionManager.getSessionFile();
				handoffQueued = sourceSessionFile !== undefined;
			}

			if (!handoffQueued || handoffInProgress || !sourceSessionFile) {
				ctx.ui.notify(
					forced ? "This session is not persisted, so it cannot be handed off" : "No automatic handoff is pending",
					"warning",
				);
				return;
			}

			const parentSession = sourceSessionFile;
			if (ctx.sessionManager.getSessionFile() !== parentSession) {
				handoffQueued = false;
				sourceSessionFile = undefined;
				ctx.ui.notify("Automatic handoff skipped because the active session changed", "warning");
				return;
			}

			handoffQueued = false;
			handoffInProgress = true;

			let prompt: string;
			try {
				prompt = await generateHandoffPrompt(ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Automatic handoff failed: ${message}`, "error");
				handoffInProgress = false;
				sourceSessionFile = undefined;
				return;
			}

			// Let the dirty-repo guard know the next linked session change is intentional.
			// The guard consumes this one-shot exemption during session_before_switch.
			pi.events.emit(SWITCH_EVENT, { sourceSessionFile: parentSession });
			try {
				const result = await ctx.newSession({
					parentSession,
					setup: async (sessionManager) => {
						sessionManager.appendCustomEntry(HANDOFF_MARKER, { parentSession });
					},
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify("Handoff complete. Continuing in a fresh session.", "info");
						try {
							await replacementCtx.sendUserMessage(prompt);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							replacementCtx.ui.notify(`Automatic handoff failed: ${message}`, "error");
						}
					},
				});

				// A cancelled replacement leaves the original command context valid.
				if (result.cancelled) {
					ctx.ui.notify("Automatic handoff was cancelled", "warning");
				}
			} catch (error) {
				// The replacement may already have invalidated ctx, so do not use it here.
				console.error("Automatic handoff session replacement failed:", error);
			} finally {
				handoffInProgress = false;
				sourceSessionFile = undefined;
			}
		},
	});
}
