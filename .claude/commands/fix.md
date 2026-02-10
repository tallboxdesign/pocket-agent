---
name: fix
description: Run typechecking and linting, then spawn parallel agents to fix all issues
---

# Project Code Quality Check

This command runs all linting and typechecking tools for this project, collects errors, groups them by domain, and spawns parallel agents to fix them.

## Step 1: Run Linting and Typechecking

Run the following commands and collect their output:

```bash
npm run typecheck 2>&1
npm run lint 2>&1
npm run format:check 2>&1
```

## Step 2: Collect and Parse Errors

Parse the output from the linting and typechecking commands. Group errors by domain:
- **Type errors**: Issues from `tsc --noEmit` (TypeScript compiler)
- **Lint errors**: Issues from ESLint
- **Format errors**: Issues from Prettier

Create a list of all files with issues and the specific problems in each file.

## Step 3: Spawn Parallel Agents

For each domain that has issues, spawn an agent in parallel using the Task tool:

**IMPORTANT**: Use a SINGLE response with MULTIPLE Task tool calls to run agents in parallel.

For **type errors**, spawn a "type-fixer" agent with:
- The list of files and specific type errors
- Instructions to fix each error
- Command to verify: `npm run typecheck`

For **lint errors**, spawn a "lint-fixer" agent with:
- The list of files and specific lint errors
- Instructions to fix each error (or run `npm run lint:fix` for auto-fixable issues)
- Command to verify: `npm run lint`

For **format errors**, spawn a "format-fixer" agent with:
- The list of files with formatting issues
- Instructions to run `npm run format` to auto-fix
- Command to verify: `npm run format:check`

Each agent should:
1. Receive the list of files and specific errors in their domain
2. Fix all errors in their domain
3. Run the relevant check command to verify fixes
4. Report completion

## Step 4: Verify All Fixes

After all agents complete, run the full check again to ensure all issues are resolved:

```bash
npm run typecheck && npm run lint && npm run format:check
```

If any issues remain, report them to the user.
