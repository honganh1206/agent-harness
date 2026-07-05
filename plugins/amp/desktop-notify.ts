import type { PluginAPI } from '@ampcode/plugin'

/**
 * desktop-notify
 *
 * On every agent.end, emit a native desktop notification via the OSC 777
 * escape sequence. Works in Ghostty, iTerm2, WezTerm, and rxvt-unicode
 * without any external dependency.
 *
 * Inspired by mitsuhiko/agent-stuff/extensions/notify.ts
 */
export default function (amp: PluginAPI) {
  amp.on('agent.end', (event) => {
    const body = summarize(event.message)
    if (!body) return
    // OSC 777 ; notify ; <title> ; <body> BEL
    process.stdout.write(`\x1b]777;notify;Amp;${escapeOsc(body)}\x07`)
  })
}

function summarize(message: string): string {
  if (!message) return ''
  // Strip code fences and inline code
  let text = message.replace(/```[\s\S]*?```/g, ' [code] ').replace(/`([^`]+)`/g, '$1')
  // Strip markdown headings, list markers, blockquotes
  text = text.replace(/^[#>\-*]\s+/gm, '')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 200) text = text.slice(0, 197) + '...'
  return text
}

function escapeOsc(s: string): string {
  // Strip control characters that could break the OSC sequence
  return s.replace(/[\x00-\x1f\x7f]/g, ' ')
}
