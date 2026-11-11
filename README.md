# mega-s02e04-two-places

Worker code for MEGA.dev Challenge **S02E04 · two places**.

Two jobs, two workers:

- **job-1 `incident-lookup`** runs locally on the harness machine.
- **job-2 `voice-to-memo`** runs in GitHub Actions on this repo.

Both use the same tiny MCP client at `src/run-job.mjs`. The main agent on the harness doesn't do the jobs; it reads both workers' outputs, picks the job-2 note that matches the moment job-1's record describes, and submits the merged claim.

## Run job 1 locally

```sh
node src/run-job.mjs --job 1 --url "<job-1 MCP URL>"
```

## Run job 2 on this repo

```sh
gh workflow run job-2 -f url="<job-2 MCP URL>" -f clip="<clip URL>"
gh run watch
gh run view --log
```

Each job's MCP URL is a bearer link: do not commit it or paste it in an issue.
