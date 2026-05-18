---
description: Commit, pull/merge, and push the main repo plus every plugin repo, in the correct order
argument-hint: "[optional: extra context for commit messages]"
---

# Sync all repos (main + plugins)

Goal: bring the main repo and every nested plugin repo to a clean, pushed,
up-to-date state. Work through repos one at a time. Extra context from the
user (if any): $ARGUMENTS

## Repo discovery

Discover every git working tree to process:

- The main repo: `C:/dev/simularca`
- Every nested repo under `plugins-external/` (each has its own `.git`)

Run this to enumerate them, and process the main repo last (so plugin pushes
land before the main repo, which may reference them):

```
find C:/dev/simularca -maxdepth 4 -name .git -not -path "*/node_modules/*" -not -path "*/.claude/worktrees/*"
```

`.claude/worktrees/*` and anything under `node_modules/` are NOT repos to sync —
exclude them.

## Per-repo procedure (exact order — do not reorder)

For each repo:

1. **Inspect**: `git status --short --branch`. Note modified, untracked, ahead/behind.
2. **Stage real changes only**. Add changed/new *source* files by explicit path.
   NEVER stage:
   - generated build-info: `*.rehearse-engine-plugin-build-info.json`,
     `.simularca-plugin-build-info.json`, `src/pluginBuildInfo.generated.ts`
   - local tooling: `.claude/settings.local.json`, anything under `.claude/`
   - `dist/`, `node_modules/`, `*.log`
   If such a file is untracked and not yet gitignored, add it to that repo's
   `.gitignore` instead of committing it.
3. **Commit** if anything is staged. Write a concise message describing the
   *why* of the change (inspect the diff to characterize it), ending with the
   `Co-Authored-By` trailer. Skip the commit if there is nothing staged — never
   create an empty commit.
4. **Pull with merge**: `git pull --no-rebase origin <current-branch>`.
   - Clean auto-merge or fast-forward: continue.
   - **Merge conflict: STOP.** Do not auto-resolve. Report the conflicting repo
     and files to the user and wait for direction. Do not push a repo with
     unresolved conflicts.
5. **Push**: `git push origin <current-branch>` (only if there are local commits
   ahead of the remote after the pull).
6. **Verify**: `git status --short --branch` shows the branch level with
   `origin/<branch>` and a clean tree.

## Safety rules

- Never use `git add -A` / `git add .` — stage by explicit path.
- Never `--force` push, never `reset --hard`, never `--no-verify`.
- Never skip or auto-resolve merge conflicts — hand them to the user.
- If a repo has no changes and is already in sync, still run the fetch/pull so
  it's confirmed current, then move on.

## Final report

Print a one-line-per-repo summary, e.g.:

```
simularca (main)        committed + merged 5 upstream + pushed
beam-crossover-plugin   committed feature + pushed
mylar-explorer-plugin   gitignore hygiene + pushed
reworld-layout-plugin   pushed 1 pending commit
thread-spindle-plugin   already in sync
```
