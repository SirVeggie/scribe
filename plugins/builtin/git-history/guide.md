# Git history

Use `repositories` to discover approved local repositories, then `log` with an exact repository path, optional `since` (Git date expression) and a limit of 1–2000. Calls read Git only and never fetch from the network.

Pages declare `<meta name="scribe-plugins" content="git-history">` and call `await scribe.plugin("git-history").call("log", {repository, since:"90 days ago"})`. The response is `{ok:true,result:{repository,commits,queriedAt}}`; each commit has hash, author, email, date and subject. On failure check `ok` and show `error`.

The user controls Repositories in Settings → Plugins → Git history. Initialize a page's repository choice from `repositories`. A page can call `requestRepository(absolutePath)` after a user click to ask Scribe to add another repository. It never adds one silently. Cache returned data in page state and refresh when opening after a suitable timeout (for example five minutes).
