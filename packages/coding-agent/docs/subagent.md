# Subagents

The built-in `subagent` extension adds a `subagent` tool that delegates a task to a specialized agent. Each call runs in a separate process of the current executable with its own isolated context window, so long investigations do not fill the main conversation.

The extension is replaceable: an extension that registers its own `subagent` tool takes over from the built-in one.

## Modes

| Mode | Input | Behavior |
| --- | --- | --- |
| Single | `{ agent, task }` | Runs one agent. |
| Parallel | `{ tasks: [{ agent, task }, ...] }` | Runs up to 8 tasks, 4 at a time. |
| Chain | `{ chain: [{ agent, task }, ...] }` | Runs agents in order. `{previous}` in a task is replaced by the previous output. |

## Default agents

Four agents are embedded in the binary and need no files. They set no model, so they inherit the current model and thinking level:

| Agent | Purpose |
| --- | --- |
| `scout` | Fast codebase recon that returns compressed context. |
| `planner` | Turns context and requirements into an implementation plan. Read-only. |
| `reviewer` | Reviews code for quality and security. Read-only bash. |
| `worker` | General-purpose agent with full capabilities. |

## Custom agents

An agent is a Markdown file with frontmatter:

```markdown
---
name: my-agent
description: What this agent is for
tools: read, grep, find, ls
model: provider/model-id
---

System prompt for the agent.
```

Agents are discovered in two places:

- User agents: `~/.tokengo/agent/agents/*.md`
- Project agents: the nearest `.tokengo/agents/*.md`, searched upward from the working directory

An agent with the same name as a built-in replaces it. Project agents override user agents. The `agentScope` parameter selects `user` (default), `project`, or `both`. Built-in agents are available in every scope.

## Security

Project-local agents are repository-controlled prompts that can instruct the model to read files and run commands. When a UI is available and the project is not trusted, TokenGo asks for confirmation before running project agents. Only enable `agentScope: "project"` or `"both"` for repositories you trust.
