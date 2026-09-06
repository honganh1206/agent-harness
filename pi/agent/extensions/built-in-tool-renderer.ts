/** Custom compact renderers for built-in read, edit, and write tools. */
import type { EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read", label: "read", description: originalRead.description, parameters: originalRead.parameters,
		async execute(toolCallId, params, signal, onUpdate) { return originalRead.execute(toolCallId, params, signal, onUpdate); },
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", args.path);
			if (args.offset || args.limit) text += theme.fg("dim", ` (${[args.offset && `offset=${args.offset}`, args.limit && `limit=${args.limit}`].filter(Boolean).join(", ")})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];
			if (content?.type === "image") return new Text(theme.fg("success", "Image loaded"), 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "No content"), 0, 0);
			const lines = content.text.split("\n");
			let text = theme.fg("success", `${lines.length} lines`);
			if (details?.truncation?.truncated) text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			if (expanded) {
				for (const line of lines.slice(0, 15)) text += `\n${theme.fg("dim", line)}`;
				if (lines.length > 15) text += `\n${theme.fg("muted", `... ${lines.length - 15} more lines`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit", label: "edit", description: originalEdit.description, parameters: originalEdit.parameters, renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) { return originalEdit.execute(toolCallId, params, signal, onUpdate); },
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", args.path), 0, 0); },
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);
			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			if (!details?.diff) return new Text(theme.fg("success", "Applied"), 0, 0);
			const lines = details.diff.split("\n");
			const additions = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
			const removals = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
			let text = theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`);
			if (expanded) for (const line of lines.slice(0, 30)) text += `\n${line.startsWith("+") && !line.startsWith("+++") ? theme.fg("success", line) : line.startsWith("-") && !line.startsWith("---") ? theme.fg("error", line) : theme.fg("dim", line)}`;
			return new Text(text, 0, 0);
		},
	});

	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write", label: "write", description: originalWrite.description, parameters: originalWrite.parameters,
		async execute(toolCallId, params, signal, onUpdate) { return originalWrite.execute(toolCallId, params, signal, onUpdate); },
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path) + theme.fg("dim", ` (${args.content.split("\n").length} lines)`), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
