# LAN documentation CI

Documentation build and Pages deployment jobs run on `tower-sporades`, a repository-scoped Linux runner on Tower (`[self-hosted, linux, x64, sporades]`). Node 22 and `npm run docs:check`, path filters, draft handling, main-only publishing, the github-pages environment, and serialized deployments are preserved. Actions npm caching is removed. PR workflows execute only for branches in this repository; fork contributions need a reviewed branch before running on the LAN.

Container `github-runner-sporades` uses `tower-actions-runner:2026-10-17`, persistent home volume `github-runner-sporades-home`, non-root UID 1001, no-new-privileges, dropped capabilities, 4 CPUs and 6 GiB RAM. Docker restart and Unraid autostart restore it. It has no host Docker socket or app secrets. Inspect via `ssh root@tower.lan` and `docker logs --tail 50 github-runner-sporades`. Runner registration files are credentials and must not be printed.

GitHub Pages remains at https://mgscox.github.io/sporades/. Its existing public-repository Pages publication uses GitHub's required Pages artifact transport with one-day retention; it is not replaced with a private Actions artifact store. Both execution jobs use Tower rather than hosted runner minutes. Pages itself is still a GitHub service. No deployment is performed for PR validation.

Tower must be online; otherwise jobs queue. Existing PR branches need this workflow update before new runs can use Tower. Retrying old runs uses their original workflow.
