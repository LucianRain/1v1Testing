# Reroute

A minimal first-playable of the 1v1 train duel design (see design doc). At its core a static site with no backend that deploys straight to GitHub Pages - there's also an optional local server (see [Host a LAN game](#host-a-lan-game)) for playing over the same network without depending on the public internet.

## How it works

- **Networking:** [PeerJS](https://peerjs.com/) for WebRTC. Signaling (helping two browsers find each other) uses PeerJS's free public cloud server on the GitHub Pages version, or this project's own self-hosted signaling server (see [server.js](server.js)) on the LAN version - either way, once connected, all data flows directly peer-to-peer over WebRTC ([src/network.js](src/network.js)). One player hosts (gets a room code, or - on the LAN version - just clicks Join Game first), the other joins.
- **Game logic:** [src/game.js](src/game.js) is a pure, dependency-free simulation (deck/hand, round resolution, sudden death). Both peers run the identical simulation in lockstep off the same shared seed, so no server-side authority is needed — see the file for the full ruleset as implemented.
- **State sync:** host generates a random match seed and sends it once on connect; each side derives its own deck order from that seed. Each round, both players commit a card, send it to the other, and once both plays are known both sides resolve the round identically.
- **Hosting:** the GitHub Pages version is just static files (`index.html`, `style.css`, `src/`) - GitHub Pages serves it as-is. The LAN version additionally needs Node (`npm install && npm start`, see below) to run its own signaling server alongside the same static files.

### Known simplifications (v1, deliberately not built yet)

- No commit-window timer — a round waits indefinitely for both plays.
- No anti-cheat / hidden commitment — a player could technically wait to see the opponent's message before sending. Fine for playtesting with a friend, not for anything adversarial.
- Sudden death triggers on a flat round count (round 9+) rather than actually tracking each player's deck cycling.
- If a player has multiple Armor Cars coupled at once, only one blocks per round; extra ones sit in reserve for later rounds.

## Host a LAN game

If you and a friend are on the same network (same WiFi/router), you can skip the internet-facing GitHub Pages version entirely and run your own local server instead - it serves the game *and* its own signaling server (see [server.js](server.js)) on one port, so matchmaking never depends on the public PeerJS cloud broker or has to cross the internet at all. This also sidesteps a real gotcha with the GitHub Pages version: two devices behind the exact same router can sometimes fail to reach each other over the public internet (a NAT "hairpin" limitation some routers have) - going purely over the LAN avoids that.

```bash
npm install
npm start
```

This prints two URLs: one for the hosting computer itself (`http://localhost:1989/local.html`), and one with this computer's LAN address for everyone else on the network to open in their browser. Everyone opens their URL and clicks **Join Game** - the first person becomes the host, the next person's click connects them automatically, no room code needed.

[local.html](local.html) is a trimmed-down entry point (no room codes, no "Auto Match vs Invite" toggle - just Join Game and Play vs Bot) that links back to the normal internet-facing site, which in turn links here for anyone who wants to switch to LAN play.

## Play locally (single machine, testing)

To just try the game on one computer without a real LAN, any static file server works (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000 in two browser tabs/windows
```

One tab clicks **Create Room** and shares the code; the other pastes it into **Join Room**.

## Deploying to GitHub Pages

1. Push this repo to GitHub (`main` branch, root).
2. **Settings → Pages → Build and deployment → Source:** `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/` within a minute or two.

No secrets, API keys, or server config required.

## `game/` — the 3D duel prototype

The [game/](game/) folder holds an earlier, fuller prototype built on the same networking layer: a Three.js top-down 1v1 arena shooter (WASD move, mouse aim/shoot, health bars, hit detection). It's parked here for later rather than deployed — see [game/README.md](game/README.md) for details on running it.

To bring it back as the active site, swap its contents up to the repo root (or point GitHub Pages at `/game` instead of `/ (root)`).
