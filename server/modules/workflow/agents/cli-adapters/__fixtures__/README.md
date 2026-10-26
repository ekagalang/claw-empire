# CLI stream fixtures

Recorded or reconstructed output of the agent CLIs, used by the adapter tests to catch format drift.

| File                                                            | Source                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-2.1.285-auth-error.jsonl`                               | Recorded from Claude Code 2.1.285 (`--print --output-format=stream-json`). The init line is trimmed to the fields the app reads and local paths are replaced.                                                     |
| `codex-0.154.0-text.jsonl`                                      | Recorded from Codex CLI 0.154.0 (`exec --json`).                                                                                                                                                                  |
| `codex-0.154.0-collab-wait.jsonl`                               | Recorded from Codex CLI 0.154.0 with `--enable multi_agent` (real `collab_tool_call` shape).                                                                                                                      |
| `codex-subagent.jsonl`                                          | Reconstructed spawn / wait / close sequence using the recorded `collab_tool_call` shape.                                                                                                                          |
| `claude-stream-text.jsonl`, `claude-subagent.jsonl`             | Reconstructed from the Claude Code stream-json format: `stream_event` deltas, `assistant` / `user` messages with `tool_use` / `tool_result` blocks. The sub-agent tool is `Agent` (formerly `Task`); both appear. |
| `claude-legacy-task.jsonl`                                      | The legacy top-level `tool_use` / `tool_result` shape the old parser handled.                                                                                                                                     |
| `gemini-stream.jsonl`, `opencode-run.jsonl`, `kimi-print.jsonl` | Reconstructed from the shapes the parsers handle; these CLIs were not installed when the recordings were made.                                                                                                    |

To refresh a recording, run the CLI with the same flags as the matching `cli-adapters/*.ts` adapter in an
empty directory, trim environment-specific fields (paths, plugin and command lists), and update the test
expectations.
