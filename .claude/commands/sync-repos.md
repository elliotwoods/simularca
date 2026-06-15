---
description: Commit, pull/merge, and push the main repo plus every plugin repo, in parallel via sub-agents
argument-hint: "[optional: extra context for commit messages]"
---

# Sync all repos (main + plugins)

Goal: bring the main repo and every nested plugin repo to a clean, pushed,
up-to-date state — fast, cheap, and reliably (always merge locally + push).
Extra context from the user (if any): $ARGUMENTS

You are the orchestrator. Do the discovery yourself, then fan the per-repo
work out to cheap sub-agents. Keep your own output minimal — no narration,
just the dispatch and the final summary.

## Step 1 — Discover repos (you do this directly)

```
find C:/dev/simularca -maxdepth 4 -name .git -not -path "*/node_modules/*" -not -path "*/.claude/worktrees/*"
```

This yields the main repo `C:/dev/simularca` plus every nested repo under
`plugins-external/`. Exclude `.claude/worktrees/*` and anything under
`node_modules/` — they are not repos to sync. The repo path is the `.git`
parent directory.

## Step 2 — Dispatch one sub-agent per repo

Use the `Agent` tool with `subagent_type: "claude"` and `model: "haiku"` for
every repo. Give each agent the **per-repo prompt below**, with `<REPO_PATH>`
filled in (and `$ARGUMENTS` appended as commit-message context if non-empty).

Ordering — this is the one barrier, keep it:

1. Dispatch **all plugin repos at once** (one Agent call each, in a single
   message so they run in parallel).
2. Wait for them all to finish.
3. Then dispatch the **main repo** (`C:/dev/simularca`) last — plugin pushes
   must land before the main repo, which may reference them.

Each agent returns one status line. If an agent reports a **merge conflict**,
do not dispatch anything that depends on it and surface it in the final report
— never resolve conflicts for the user.

### Per-repo prompt (give this verbatim to each sub-agent)

> Sync the single git repo at `<REPO_PATH>`. Be terse — run commands, don't
> narrate. Use `cd <REPO_PATH> && ...` for every git command. Extra commit
> context (may be empty): $ARGUMENTS
>
> Procedure, in order:
> 1. `git status --short --branch` — note modified, untracked, ahead/behind.
> 2. Stage real **source** changes only, by explicit path (`git add <path>`).
>    NEVER use `git add -A` or `git add .`. NEVER stage:
>    - generated build-info: `*.rehearse-engine-plugin-build-info.json`,
>      `.simularca-plugin-build-info.json`, `src/pluginBuildInfo.generated.ts`
>    - local tooling: anything under `.claude/`, `.claude/settings.local.json`
>    - `dist/`, `node_modules/`, `*.log`
>    If such a file is untracked and not already ignored, add it to this repo's
>    `.gitignore` (and stage the `.gitignore`) instead of committing the file.
> 3. If anything is staged, commit with a concise message describing the *why*
>    (skim the diff to characterize it), ending with this trailer:
>    `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
>    Skip the commit if nothing is staged — never create an empty commit.
> 4. `git pull --no-rebase origin <current-branch>`.
>    - Clean fast-forward or auto-merge: continue.
>    - Merge conflict: STOP. Run `git merge --abort`, leave the tree clean, and
>      return `CONFLICT: <files>`. Do not auto-resolve.
> 5. If there are local commits ahead of the remote, `git push origin <branch>`.
> 6. Verify: `git status --short --branch` shows the branch level with
>    `origin/<branch>` and a clean tree.
>
> Hard rules: never `--force`, never `reset --hard`, never `--no-verify`, never
> auto-resolve conflicts. If a repo is already clean and in sync, still run the
> pull to confirm it's current.
>
> Return EXACTLY one line and nothing else, in the form:
> `<repo-folder-name>: <what happened>` — e.g. `beam-crossover-plugin: already in sync`,
> `mylar-explorer-plugin: committed feature + pushed`, or
> `reworld-layout-plugin: CONFLICT: src/foo.ts`.

## Step 3 — Final report

Collect the one-line status from each agent and print one line per repo,
aligned, e.g.:

```
simularca (main)        committed + merged 5 upstream + pushed
beam-crossover-plugin   committed feature + pushed
mylar-explorer-plugin   gitignore hygiene + pushed
reworld-layout-plugin   pushed 1 pending commit
thread-spindle-plugin   already in sync
```

Call out any `CONFLICT:` lines prominently and tell the user those repos need
manual resolution.
