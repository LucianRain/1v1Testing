# Reroute

A minimal first-playable of the 1v1 train duel design (see design doc). Static site, no backend, deploys straight to GitHub Pages.

## How it works

- **Networking:** [PeerJS](https://peerjs.com/), which uses its free public cloud server only to help two browsers find each other (signaling). Once connected, all data flows directly peer-to-peer over WebRTC ([src/network.js](src/network.js)). One player hosts (gets a room code), the other joins with that code.
- **Game logic:** [src/game.js](src/game.js) is a pure, dependency-free simulation (deck/hand, round resolution, sudden death). Both peers run the identical simulation in lockstep off the same shared seed, so no server-side authority is needed — see the file for the full ruleset as implemented.
- **State sync:** host generates a random match seed and sends it once on connect; each side derives its own deck order from that seed. Each round, both players commit a card, send it to the other, and once both plays are known both sides resolve the round identically.
- **Hosting:** just static files (`index.html`, `style.css`, `src/`). GitHub Pages serves it as-is.

### Known simplifications (v1, deliberately not built yet)

- No commit-window timer — a round waits indefinitely for both plays.
- No anti-cheat / hidden commitment — a player could technically wait to see the opponent's message before sending. Fine for playtesting with a friend, not for anything adversarial.
- Sudden death triggers on a flat round count (round 9+) rather than actually tracking each player's deck cycling.
- If a player has multiple Armor Cars coupled at once, only one blocks per round; extra ones sit in reserve for later rounds.

## Play locally

You need a local web server (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000 in two browser tabs/windows (or two machines)
```

One tab clicks **Create Room** and shares the code; the other pastes it into **Join Room**. Either side's `+1` button increments the count on both.

## Deploying to GitHub Pages

1. Push this repo to GitHub (`main` branch, root).
2. **Settings → Pages → Build and deployment → Source:** `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/` within a minute or two.

No secrets, API keys, or server config required.

## `game/` — the 3D duel prototype

The [game/](game/) folder holds an earlier, fuller prototype built on the same networking layer: a Three.js top-down 1v1 arena shooter (WASD move, mouse aim/shoot, health bars, hit detection). It's parked here for later rather than deployed — see [game/README.md](game/README.md) for details on running it.

To bring it back as the active site, swap its contents up to the repo root (or point GitHub Pages at `/game` instead of `/ (root)`).
