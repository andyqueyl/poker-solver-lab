# Poker Solver Lab

Free poker training tools built on game-theory solvers, running entirely in the browser.

**Live site:** https://andyqueyl.github.io/poker-solver-lab/

| Tool | What it does |
|---|---|
| [Watch CFR Learn](https://andyqueyl.github.io/poker-solver-lab/learn/) | CFR, CFR+ and fictitious play solve heads-up push/fold live |
| [Push/Fold Trainer](https://andyqueyl.github.io/poker-solver-lab/push-fold/) | Shove-or-fold drills from 1–25bb, heads-up and 6-max, against Nash ranges |
| [6-Max Preflop Trainer](https://andyqueyl.github.io/poker-solver-lab/preflop/) | Opens, 3-bets, squeezes and 4-bets from every seat at 100bb |
| [Heads-Up Hold'em Trainer](https://andyqueyl.github.io/poker-solver-lab/heads-up/) | Full hands against a solver bot at 100, 40 or 20bb, every decision graded |
| [Heads-Up Spot Explorer](https://andyqueyl.github.io/poker-solver-lab/heads-up-explorer/) | The solver's whole-range strategy for any board and betting line |
| [6-Max Hold'em Trainer](https://andyqueyl.github.io/poker-solver-lab/six-max/) | Six-handed hands against five solver bots, including 3-way pots |
| [6-Max Spot Explorer](https://andyqueyl.github.io/poker-solver-lab/six-max-explorer/) | Range strategies for 11 kinds of 6-max postflop pots |
| [Play with Friends](https://andyqueyl.github.io/poker-solver-lab/play/) | Private no-limit hold'em rooms: share an invite link, set blinds, think time and rebuys, play for play chips |

All solutions are approximate equilibria of simplified games: bet sizes are limited to the buttons in each tool, and postflop hands are grouped by strength. Each page explains its model at the bottom. Session stats and leaks are stored only in your browser.

This is a static site: every page is plain HTML and JavaScript, with the solved strategies in the `.js` data files next to the pages that use them.

Play with Friends has no game server either. The host's browser runs the table (`play/engine.js`) and players connect straight to it over WebRTC, using PeerJS's free public broker only to find each other. Cards are drawn one at a time from the undealt cards at the moment they're dealt, so no future board exists until its street comes. The host's browser does hold every player's hole cards during a hand, so only play with a host you trust.
