#!/usr/bin/env node
// approvalHookExample.js
//
// PROVEN real approval-routing mechanism for Claude Code (FINDINGS.md #9).
// This is a PreToolUse hook: Claude Code invokes it as a subprocess for
// every tool call, feeds it a JSON description of the call on stdin, and
// reads a JSON decision back from stdout. This is the ONLY mechanism we
// found that lets our own code make a real, programmatic allow/deny
// decision that changes what actually happens (verified: it blocked a
// real file edit with our own custom denial reason, and allowed another).
//
// To use it, put a `.claude/settings.json` in the target cwd:
//
// {
//   "hooks": {
//     "PreToolUse": [
//       { "matcher": "Edit|Bash", "hooks": [
//           { "type": "command", "command": "node /path/to/approvalHookExample.js" }
//       ]}
//     ]
//   }
// }
//
// and make sure the run is started WITHOUT --setting-sources "" (that
// flag disables project settings entirely, which disables this hook too).

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error('approvalHookExample: bad JSON on stdin', e);
    process.exit(1);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  // Replace this with a real call out to your dashboard/orchestrator to
  // get a human or policy decision. This hook call is itself synchronous
  // from the CLI's point of view (it blocks the tool call until this
  // process exits), so it's fine to do a slow network round-trip here.
  let decision = 'allow';
  let reason = 'approved by example hook';

  if (toolName === 'Bash' && /rm\s+-rf/.test(toolInput.command || '')) {
    decision = 'deny';
    reason = 'example hook: rm -rf is never allowed';
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision, // 'allow' | 'deny' | 'ask'
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
});
