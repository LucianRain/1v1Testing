# 1v1 Duel

A tiny top-down arena shooter built with [Three.js](https://threejs.org/), made to test a peer-to-peer 1v1 game hosted entirely on GitHub Pages — no backend, no build step.

## How it works

- **Rendering:** Three.js, loaded via an [import map](index.html) straight from a CDN (unpkg). No bundler needed.
- **Networking:** [PeerJS](https://peerjs.com/), which uses its free public cloud server only to help two browsers find each other (signaling). Once connected, all game data flows directly peer-to-peer over WebRTC. One player hosts (gets a room code), the other joins with that code.
- **Hosting:** Just static files (`index.html`, `style.css`, `src/`). GitHub Pages serves it as-is.

## Play locally

You need a local web server (import maps / ES modules don't load from `file://`). From this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000 in two browser tabs/windows (or two machines)
```

One tab clicks **Create Room** and shares the code; the other pastes it into **Join Room**.

## Controls

- `WASD` — move
- Mouse — aim (your character faces the cursor)
- Left click — shoot
- First to 0 HP loses

## Deploying to GitHub Pages

1. Create a new GitHub repo and push this folder to it (`main` branch, root).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`.
4. Save — GitHub gives you a URL like `https://<username>.github.io/<repo>/` within a minute or two.
5. Send that link to your friend, both open it, one hosts and one joins.

No secrets, API keys, or server config required.

## Notes / known limitations

This is a quick test scaffold, not a polished game:

- Hit detection is simple sphere-vs-circle, receiver-authoritative (each player's own client decides whether they got hit, then reports HP to the other side) — fine for a casual match between friends, not cheat-proof.
- No reconnect/resume — if the connection drops, both players need to reload and re-host/join.
- PeerJS's public broker occasionally has connection hiccups; if "Join Room" times out, have the host re-create the room and try again.

Feel free to swap in your own arena layout, player models, or game rules in [src/main.js](src/main.js) — the movement/shooting/networking scaffolding is meant to be a starting point.
