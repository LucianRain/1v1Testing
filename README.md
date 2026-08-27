# Shared Counter (P2P test)

A minimal test of the peer-to-peer networking layer: one shared counter, either player's button press increments it for both. Static site, no backend, deploys straight to GitHub Pages.

## How it works

- **Networking:** [PeerJS](https://peerjs.com/), which uses its free public cloud server only to help two browsers find each other (signaling). Once connected, all data flows directly peer-to-peer over WebRTC ([src/network.js](src/network.js)). One player hosts (gets a room code), the other joins with that code.
- **State:** each press increments the local count immediately and sends `{t: 'inc'}` to the other peer, who applies the same +1 on receipt. Since increments always commute, both sides converge without needing a central authority.
- **Hosting:** just static files (`index.html`, `style.css`, `src/`). GitHub Pages serves it as-is.

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
