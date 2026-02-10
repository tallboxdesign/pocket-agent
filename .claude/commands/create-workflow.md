---
name: create-workflow
description: Create a new workflow command for Pocket Agent
---

# Create a New Workflow

The user wants to create a new workflow command. Ask them what the workflow should do, then build it following the spec below.

## Workflow File Format

Each workflow is a single Markdown file placed in:
```
.claude/commands/<command-name>.md
```

The filename becomes the command identifier. Use lowercase kebab-case (e.g., `daily-report.md`, `code-review.md`).

### Structure

Every workflow file has two parts:

**1. YAML Frontmatter** (required) — metadata between `---` delimiters:

```yaml
---
name: command-name
description: Short one-line description of what this workflow does
---
```

- `name`: Display name shown in the workflows panel. Keep it short (1-3 words).
- `description`: Shown as a tooltip on hover. One sentence max.

**2. Markdown Body** — the instructions the agent will follow when the workflow is triggered. This is standard Markdown and can include:

- Step-by-step numbered instructions
- Bash code blocks for commands to run
- Bullet lists for criteria or checks
- Headers to organize sections
- Any context or constraints the agent needs

### Example

```markdown
---
name: code-review
description: Review staged changes for bugs and improvements
---

# Code Review

Review the current staged changes and provide feedback.

## Steps

1. Run `git diff --cached` to see staged changes
2. For each changed file, analyze:
   - Potential bugs or logic errors
   - Security concerns
   - Performance issues
   - Code style consistency
3. Provide a summary with:
   - Critical issues (must fix)
   - Suggestions (nice to have)
   - What looks good
```

## Guidelines for Writing Good Workflows

- Write instructions as if briefing an agent — be specific about what to do and in what order
- Include verification steps (e.g., "run tests after making changes")
- Use code blocks for any shell commands the agent should run
- Keep the description concise — it appears as a tooltip in the UI
- The user can provide additional context when triggering the workflow, so the instructions don't need to cover every edge case

## Creating the File

1. Ask the user what the workflow should do
2. Choose a clear, descriptive kebab-case filename
3. Write the frontmatter with a short name and description
4. Write clear step-by-step instructions in the body
5. Save the file to `.claude/commands/<name>.md`
6. Tell the user to reopen the workflows panel to see it (commands are cached on first open)
