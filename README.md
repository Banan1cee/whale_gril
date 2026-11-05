[English](README.md) | [中文](README.zh-CN.md)

# 🐋 Whale Girl — a DeepSeek-powered WeChat companion bot

[![GitHub release](https://img.shields.io/github/v/release/Banan1cee/whale_gril)](https://github.com/Banan1cee/whale_gril/releases/latest)
[![License: MIT](https://img.shields.io/github/license/Banan1cee/whale_gril)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub stars](https://img.shields.io/github/stars/Banan1cee/whale_gril)](https://github.com/Banan1cee/whale_gril/stargazers)

> **Just want to run it?** Grab the latest package from [Releases](https://github.com/Banan1cee/whale_gril/releases/latest),
> extract it to a path without Chinese characters, double-click **`WhaleLauncher.exe`** and press **Start** in the top-right corner.
> The release bundle ships its own Node.js and Python runtimes — nothing else needs to be installed.

Whale Girl is a blue-haired companion bot with an actual personality: short replies, real moods, sweet one moment and savage the next.

She **joins WeChat group conversations** on her own, brings in Bilibili/Weibo trending topics and live web lookups, and keeps up with group slang, abbreviations and banter. Everything — settings, diagnostics, switches — lives in one desktop launcher, so you can run her without hand-editing config files.

Under the hood she talks to any OpenAI-compatible model (DeepSeek / Zhipu GLM / Qwen / local Ollama…); switching providers is a one-line change, and the kernel has **zero npm runtime dependencies**.

---

## Features

- **One entry point** — the WPF launcher is the only GUI. Port `8787` serves the HTTP API only; there is no web console any more.
- **WeChat auto-reply** — she answers when @-mentioned or called by name, keeps chatting while the thread is alive, and goes quiet when the topic dies. She will snap back at insults aimed at her, but never butts into other people's arguments.
- **Human-like pacing** — one reply is split into 2–3 short bubbles, without trailing tildes or full stops. If someone sends a bare `？`, she answers with a `？` too.
- **Memory** — facts people state about themselves in DMs are stored; older group chats are compressed into a summary. If image/sticker recognition fails, she stays silent instead of guessing.
- **No parroting** — if the model repeats itself (identical text, text plus a question mark, "no, *you* are…"), the reply is rewritten once.
- **Internet slang** — `kskbl` → `zdjd`, `xswl` → she echoes it back; the lexicon lives in `assets/abbrev.txt`.
- **Clapbacks** — when she or her owner is insulted she fires back with a 9-tier line library (`assets/clapback.txt`, extensible). Soft replies get replaced; sexual, family, discriminatory and real-world threats are never used.
- **Little helper** — in a DM from her owner she can report her own WeChat ID; after the owner authorises "you may roast me", she may roast them in three sentences.
- **Voice input** — incoming voice messages are transcribed to text before she replies; she only ever *sends* text.
- **Web access** — the model decides whether a lookup is needed; Bing plus Bilibili/Weibo trending, Toutiao hot list and link-body extraction, all under a global timeout, with the current date injected into the prompt.
- **Group management** — mute, unmute, switch model, change tone, clear memory, and an automatic "good night" when the battery is low.
- **Stop everything** — the launcher's **Stop** button (or `scripts\stop-all.ps1`) stops kernel and bridge and writes a pause marker.
- **WeChat bridge** — `examples/wechatauto_bridge.py`: read-only database access plus window automation, no injection into WeChat.
- **No `npm install`** — the release bundle carries `runtime\`; this repository is the source edition.

---

## Quick start (Windows release package with `runtime\`)

> This repository is the **source edition and does not include `runtime\`**. Use the section below only with a release bundle, which runs without installing Node or Python.
>
> **Extract to an ASCII-only path** (for example `D:\whale-girl-4.0`). Inside a path containing Chinese characters the WeChat automation fails with "access denied".

1. Extract the archive.
2. Double-click **`WhaleLauncher.exe`** and press **Start**. The launcher brings up the kernel and the bridge; `8787` is only used by the launcher and the bridge.
3. Once the **Status** page shows both kernel and bridge as running, you are good to go.

The bundle contains a **Node.js runtime** (`runtime\node.exe`) and a **Python runtime** (`runtime\python`). The launcher prefers the bundled ones and only falls back to `PATH`.

The same applies to the bridge: the launcher starts it with the bundled Python, which already has `wechatauto-replica`, `pywin32`, `uiautomation`, `Pillow`, `cryptography`, `pysilk` and friends installed.

The only things you must supply: **a logged-in secondary WeChat account** and **one model API key** (DeepSeek / Zhipu / Qwen, your pick).

## Updating

Use **Check for updates** in the launcher, or run `powershell -File scripts\update.ps1`. It finds the latest release, downloads it, verifies it and overwrites the installation; `data\` (memory) and `config.json` (keys) are never touched.

- **Verification** — the `sha256` published by the GitHub API is checked; a mismatch aborts the update instead of installing half a package.
- **Automatic rollback** — after overwriting, the version, memory count and `config.json` hash are re-checked; any failure restores the backup.
- **Mirrors** — if GitHub is unreachable, a mirror is tried (`ghfast.top` / `gh-proxy.com` / `gh-proxy.org` / `ghproxy.net`, transport only, never verification).
- **Offline** — `scripts\update.ps1 <path-to-zip>` installs a package you downloaded yourself.
- **Check only** — `scripts\update.ps1 -Check`; **rollback manually** — `scripts\update.ps1 -Rollback`.

> If you modified the source, note that updates overwrite everything: the script lists locally modified files and asks for confirmation (`-Force` skips the prompt).

## When the launcher won't open

The repository root has exactly one double-click entry, `WhaleLauncher.exe`; everything else is a command-line script.

| Situation | Command |
| --- | --- |
| Install Node / Python and bridge dependencies | `powershell -File scripts\setup-runtime.ps1` |
| Clean up stuck processes (8787 occupied, bridge won't die) | close the launcher, then `powershell -File scripts\stop-all.ps1` |
| Factory reset (wipe memory and config) | launcher → **Diagnostics** → **Reset everything**, or `powershell -File scripts\factory-reset.ps1 -Yes` |
| Update | **Check for updates** in the launcher, or `powershell -File scripts\update.ps1` |
| Read-only UIA diagnostics (changes nothing) | `python scripts\tools\uia-check.py` |
| Send one real test message to File Transfer | `python examples\uia_selftest.py` |

## Quick start (source / CLI / macOS / Linux)

```bash
# 1. Node.js 18+
node -v

# 2. Start the kernel (no npm install needed)
npm start
```

Without an API key the kernel runs in demo mode with built-in lines; pick a provider and paste a key in the launcher's **Settings**.

On first start `config.example.json` is copied to `config.json`. **`config.json` and `data/` hold your keys, chat history and owner list — both are git-ignored, never commit them.**

Supported providers: `deepseek` / `zhipu` / `siliconflow` / `qwen` / `ollama` (local) / `custom` (any OpenAI-compatible endpoint).

---

## WeChat bridge (Windows)

Requirements: Windows, a logged-in WeChat 4.x, administrator rights. Double-click `WhaleLauncher.exe` and press **Start**; kernel and bridge come up together.

Running from source: `py -3.12 -m pip install -r requirements.txt`, put `vendor` on `PYTHONPATH`, then run `python examples/wechatauto_bridge.py`.

Details (UIA elevation, multiple accounts, ASCII-only paths, error codes) are in the WeChat integration guide under [`docs/`](docs/).

### Stop everything (`scripts\stop-all.ps1`)

Close the launcher first, then run `powershell -File scripts\stop-all.ps1`. It stops, in order:

- the kernel (whatever holds port 8787),
- the WeChat bridge (`wechatauto_bridge.py`),
- the launcher window (if left open it would restart the bridge).

It also writes `data\PAUSED` so nothing is restarted automatically, scans three extra times because a child process may spawn while its parent is being killed, and finally prints a green "clean" line or the list of leftover PIDs.

To resume: open `WhaleLauncher.exe` and press **Start** (the launcher clears `PAUSED`).

---

## Who can be an admin

The open-source edition hard-codes nobody's WeChat ID — the deployer decides:

```json
"persona": {
  "master": { "names": ["your-nickname"], "wxids": ["wxid_xxx"] }
},
"admin": {
  "spell": "a passphrase only you know",
  "minutes": 30,
  "allowAll": false
}
```

- `master.names` / `master.wxids` — everyone listed here is an owner (multiple entries allowed).
- `admin.spell` — sending this passphrase in a DM grants 30 minutes of admin rights; leave it empty to disable.
- `admin.allowAll: true` — **anyone** can use admin commands without the passphrase. Fine for a small private group, dangerous in public ones.

### Admin commands (DM the bot)

Admin commands are sent in private chat. The full list (status, tone, length, mute, switch model, reset memory…) is in the settings reference under [`docs/`](docs/).

### How context is assembled

- Group history is fed to the model as **events**: every line keeps its speaker, time and @ target, so several people's messages are not squashed into one, and someone else's "you" is never mistaken for an address to the bot.
- If a message @-mentions somebody else and then says "you", the bot does not jump in; if it @-mentions both the bot and another person, that person is recorded as a mention.
- DM context is 100 messages by default, group context 60 (`chat.historyTurns` / `chat.groupHistoryTurns`, capped at 120/100). `memory.maxMessages` must be at least the largest window, otherwise messages cannot be stored.

### Persona presets (one file per version)

`assets/personas/` holds one file per persona version; upgrades add files and never overwrite old ones. Import them from the bottom of the launcher's **Persona** page. Conventions and privacy rules are in [assets/personas/README.md](assets/personas/README.md).

---

## Pause and resume

Close the launcher (or run `scripts\stop-all.ps1`): kernel and bridge stop without sending anything, and `data/PAUSED` is written. Open `WhaleLauncher.exe` and press **Start** to resume — the pause marker is cleared.

## Configuration

Copy the example and edit it (`config.json` is git-ignored): `cp config.example.json config.json`

| Field | Meaning |
| --- | --- |
| `provider` / `deepseek.apiKey` | model provider and key |
| `persona.master.names` / `wxids` | who counts as the owner |
| `gateway.wechat.inboundToken` | bridge token — change it |
| `group.requireAt` | must a group message @ the bot first? |
| `chat.privateMaxChars` | reply length limit |

Everything else is documented in the settings reference under [`docs/`](docs/).

---

## Project structure

```
whale-girl/                        # same layout as the repository; runtime data is never committed
├─ server.js                       # HTTP server + webhooks
├─ WhaleLauncher.exe               # the only GUI entry point
├─ package.json
├─ release-manifest.json
├─ requirements.txt
├─ config.example.json
├─ README.md                       # this file (English)
├─ README.zh-CN.md                 # Chinese README
├─ CHANGELOG.md
├─ BUGS.md
├─ CONTRIBUTING.md
├─ AGENTS.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ .github/                        # CI and releases
├─ src/                            # kernel
│  ├─ adapters/                    # outbound integrations
│  ├─ core/                        # decision making and parsing
│  ├─ http/                        # routes and security gates
│  ├─ infra/                       # config and infrastructure
│  ├─ llm/                         # model client
│  ├─ memory/                      # memory and token budget
│  ├─ persona/                     # persona
│  ├─ pipeline/                    # message orchestration
│  └─ services/                    # stateful services
├─ bridge/                         # Python bridge
├─ launcher/                       # launcher source
├─ installer/                      # Inno Setup (bundled compiler)
├─ scripts/                        # build/maintenance (tools/ holds UIA diagnostics)
├─ assets/                         # persona presets and lexicons
├─ examples/                       # bridge entry and media fallbacks
├─ docs/                           # documentation
├─ vendor/                         # pinned copy of wechatauto
├─ tests/                          # tests
```

Not committed, generated at runtime: `data/` (keys, memory, logs), `runtime/` (bundled Node and Python),
`artifacts/` (build output) and `config.json` (local configuration).

---

## Development and testing

```bash
npm test                  # node --test "tests/*.test.js" (tests/ only, never runtime\python)
node server.js --doctor   # self-check
```

- Persona / lexicon: `data/persona.json`, `data/slang.txt` (the launcher's **Persona** page edits the same files).
- Trigger logic: `computeTrigger` in `src/bot.js`.
- Prompt building: `buildSystem` in `src/persona.js`.

---

## Security and compliance

- The server binds to `127.0.0.1:8787` by default — **never expose it to the internet** (there is no authentication).
- `data/` and `config.json` are git-ignored. **Never commit API keys or chat history.**
- The WeChat bridge is UI automation: it does not patch the client, inject code or read process memory, but it **may still violate WeChat's terms of service**. Use it at your own risk.
- Replies are generated by a large language model — be careful with `admin.allowAll` and auto-sharing in public groups.

---

## Download

Only download installers from **GitHub Releases**: <https://github.com/Banan1cee/whale_gril/releases>.
Checksums and verification commands are in [docs/DOWNLOAD.md](docs/DOWNLOAD.md).

## Code signing policy

Current release builds are **not signed yet**, so Windows shows "Unknown publisher". Verify `SHA256SUMS.txt` from the release before installing.
The signing policy is in [docs/CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md); the privacy statement is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Acknowledgements

This project's WeChat support stands entirely on the shoulders of others. Special thanks to:

- **[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)** (`wechatauto-replica` v1.2.9, **Apache-2.0**, by fanyuantaier, [PyPI](https://pypi.org/project/wechatauto-replica/))
  — a Windows WeChat 4.x automation library (a wxauto replica): SQLCipher database decryption plus hybrid UIA / coordinate-OCR sending.
  The WeChat bridge (`examples/wechatauto_bridge.py`) is built directly on top of it.
  - The source is vendored as a pinned copy in `vendor/wechatauto/` (including the original `dist-info/licenses/LICENSE`), with a manifest and checksums in `vendor/MANIFEST.sha256` and notes in `vendor/README.md`.
  - The build copies it into `runtime/` only after verifying every file against the manifest, and **never edits the upstream source**; behaviour changes belong in the build-time patch `scripts/prepare-sticker-runtime.py`, and runtime compatibility patches are applied from `examples/uia_compat.py` without touching the vendored files. Both are documented in `vendor/README.md`.
  - The upstream README says "for personal study and automation research only". That is the author's wish, not a licence term; the actual rights come from Apache-2.0 (see below).
- **[wxauto](https://github.com/cluic/wxauto)** (Apache-2.0) — the pioneer of Windows WeChat automation; `wechatauto-replica` is its 4.x replica and inherits its design.
- **[VB-CABLE](https://vb-audio.com/Cable/)** (VB-Audio, donationware) — the virtual audio cable used for voice sending; the installer only ships the official installer.

### Third-party licence and redistribution

- `wechatauto-replica` is licensed under **Apache-2.0**, which permits private and commercial use, modification and redistribution **provided the licence and copyright notices are kept, your changes are stated, and you do not imply endorsement by the upstream project**.
- This repository satisfies those terms by shipping the licence text at `vendor/wechatauto/dist-info/licenses/LICENSE`, keeping the upstream source unmodified (patches happen at build time only, verified by `vendor/MANIFEST.sha256`), and crediting the project here and in `vendor/README.md`.
- This project's own code is **MIT** (see [LICENSE](LICENSE)); it is compatible with the upstream Apache-2.0.

## License

MIT — see [LICENSE](LICENSE). Fork it, rewrite the persona, plug in your own model.
