[English](README.md) | [中文](README.zh-CN.md)

# 🐋 Whale Girl — a DeepSeek-powered WeChat companion bot

[![GitHub release](https://img.shields.io/github/v/release/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub stars](https://img.shields.io/github/stars/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/stargazers)

> **Just want to run it?** Grab the latest `whale-girl-*-setup.exe` (about 168 MB) from
> [Releases](https://github.com/Banan1cee/whale_girl/releases/latest).
> The installer ships Node, Python 3.12 and the .NET 10 desktop runtime, so **nothing has to be downloaded afterwards**.
> Installation itself does not trigger UAC — only a machine without .NET 10 gets one extra elevation prompt.
> When it finishes, a desktop shortcut opens the launcher.
>
> ## Updating without losing memory
>
> **Press "Check for updates" in the launcher.** It downloads the official installer, verifies its SHA256 and
> silently installs it over the old version: `data\` (chat memory, keys, nicknames) and `config.json`
> (owner list, token) are left untouched, while leftovers from older versions (`personas\`, `resources\`,
> the old `runtime\vb-cable` location) are cleaned up so the install does not keep growing.
>
> Running from source (an extracted zip)? Keep using **`powershell -File scripts\update.ps1`**; the rules are
> described under "Updating to a new version" below.
>
> Prefer a manual backup: `node scripts\memory-tool.js export <file>` writes a JSON export and
> `restore <file>` puts it back (the launcher's Diagnostics page uses the same commands).
>
> **A 3.x `data\store.json` is detected and converted to the 4.0 format automatically**: just merge the old
> `data\` into the new install and start. The launcher reports "memory imported and converted" once and keeps
> the original under `data\memory\legacy\`. You can repeat the conversion any time from
> Settings → Advanced → Legacy memory; clicking twice does not import twice.
>
> ---
>
> `Code → Download ZIP` is only the **400 KB source tree** (no runtimes, no keys, no chat history). There are two ways to run from source:
> 1. `powershell -File scripts\setup-runtime.ps1` — downloads Node and Python and installs the WeChat dependencies into `runtime\`, after which it behaves like the packaged edition;
> 2. or install Node 18+ yourself (`npm start` runs the kernel) and, for WeChat, Python 3.12 plus `pip install -r requirements.txt`.
>    (`wechatauto` comes from `vendor/wechatauto` in this repository, so pip does not install it; add `vendor` to `PYTHONPATH` when running the bridge from source.)

A companion bot that actually talks: **automatic replies in WeChat groups, Bilibili/Weibo trending topics, and live web lookups**. Settings and diagnostics live in the launcher.

The persona is a blue-haired whale girl — short messages, real moods, sweet one moment and savage the next. She talks to any OpenAI-compatible model (DeepSeek / Zhipu GLM / Qwen / local Ollama…), and the kernel has zero npm dependencies.

---

## Experimental stickers

The package includes 27 Whale Girl preset PNGs (9 each in tsundere, angry and happy). They are imported into your library in the background the first time stickers are enabled. Existing images are never overwritten, and deleting a preset does not make it reappear after a restart. The master switch remains off by default.

Turn the master switch on in the launcher's **Stickers** page (off by default). The category is chosen by the model, which writes `[[sticker:category]]` at the end of a reply: the marker is stripped before the user sees anything, and if the marker is missing, the category does not exist or that category has no images, **nothing is sent** — the bot never guesses a mood and never picks one at random. Three built-in categories (tsundere / angry / happy) plus any custom ones you add; manage categories, upload and delete images, or open the folder from the launcher. GIF, PNG, JPEG and WebP are supported (4 MB per file). Uploading only stores the original file: no WeChat message is sent and GIFs are not re-encoded.

Custom categories are matched by name, so the more descriptive the name, the better (for example "passive-aggressive" or "grievance"): the model picks from categories that actually contain images, and never force-fits an uninformative name. Categories without images are not shown to the model at all.

The Stickers page can also set the frequency (0–100%) and the "send one even without a marker" option, which map to `sticker.demandChance` (default 0.7) and `sticker.ensureSend` (default off) in `config.json`. `demandChance` decides whether this turn appends a reminder to include a sticker: 0 = rely on the model, 1 = remind every turn — but with only that option a value of 1.0 still does not guarantee a send, because the model may still omit the marker. With `ensureSend` on, a turn that hits the reminder gets a sticker anyway, chosen from the reply's tone (angry / tsundere / happy, falling back to happy), so **1.0 plus ensure-send is roughly "one sticker per turn"**. Serious moments still suppress it (the recipient is upset, asking for help, or discussing something real); the serious window ends after 15 minutes, four ordinary messages, or a "never mind" / "haha". An explicit request is still honoured 100% of the time.

The optional **Queue test send** performs real WeChat actions — **queued does not mean delivered**. The bridge may briefly switch to the target chat and restore it afterwards; clear the input box first. When evidence is insufficient it skips instead of pressing Enter blindly, and it never retries automatically. If the result says "unconfirmed", do not press send again; if a draft attachment appears, clear it manually — your drafts are never deleted for you. One pending job per chat at a time, no cooldown after confirmation, and jobs older than 90 seconds expire instead of being replayed.

A send counts as "confirmed" only when a new outgoing image record appears in the database; a database error or no new record is "unconfirmed", never success. Turning the switch off cannot recall a message that has already been sent, and restarting the service never replays old jobs.

See [CHANGELOG.md](CHANGELOG.md) for the change history.

## Features

- **One entry point** — the launcher (WPF + .NET 10) is the only GUI; there is no browser console, and `8787` only serves the HTTP API.
- **WeChat group replies** — she answers @-mentions and her name, keeps the thread going while it lives, and goes quiet when the topic dies. She fires back when insulted by name, but never joins other people's arguments.
- **Human-like pacing** — one reply is split into 2–3 short bubbles with no trailing tildes or full stops; if someone sends a bare `？`, she answers with a `？` too.
- **Memory** — facts people state about themselves in DMs are recorded, older group chats are compressed into a summary, and she stays silent when image or sticker recognition fails.
- **No parroting** — if the model repeats itself (identical text, text plus a question mark, "no, *you* are…"), the reply is rewritten once.
- **Slang** — `kskbl` → `zdjd`, `xswl` → she echoes it back; the lexicon is `assets/abbrev.txt`.
- **Clapbacks** — when she or her owner is insulted she fires back with a 9-tier line library (`assets/clapback.txt`, extensible). Soft replies get replaced, but she never touches sex, family, discrimination or real-world threats.
- **Little helper** — in a DM from her owner she reports her own WeChat ID; after the owner grants "you may roast me" she may roast them in three sentences.
- **Voice input** — incoming voice messages are transcribed before she replies; she only ever *sends* text.
- **Web access** — the model decides whether a lookup is needed; Bing plus Bilibili/Weibo trending (routed per site), the Toutiao hot list and link-body extraction, all under a global timeout, with the current date in the prompt.
- **Group management** — mute and unmute, switch model, change tone, clear memory, and an automatic "good night" on low battery.
- **Stop everything** — `scripts\stop-all.ps1` or the launcher's **Stop** button stops kernel and bridge and writes a pause marker.
- **WeChat bridge** — `examples/wechatauto_bridge.py`: read-only database access plus window automation, never injecting into WeChat.
- **Zero npm dependencies** — no `npm install`; release bundles carry `runtime\`, this repository is the source edition.

---

## Install (Windows, installer)

> This repository is the **source edition without `runtime\`** — see the next section. To use the bot directly, download `whale-girl-*-setup.exe` from [Releases](https://github.com/Banan1cee/whale_girl/releases/latest).
>
> **Install to an ASCII-only path** (for example `D:\whale-girl-4.0`). Inside a path containing Chinese characters, WeChat automation fails with a continuous "access denied" error; the reason is explained under "WeChat bridge" below.

1. Run `whale-girl-4.0.5-setup.exe` and click Next through the wizard (no administrator rights needed).
2. When it finishes, open the **Whale Girl** shortcut on the desktop and press **Start** in the top-right corner — the launcher brings up the kernel and the bridge (`8787` is used only by the launcher and the bridge; there is no web UI).
3. Once the **Status** page shows both kernel and bridge as running, you are good to go.

The installer bundles a **Node.js runtime** (`runtime\node.exe`), a **Python runtime** (`runtime\python`) and the **.NET 10 desktop runtime installer**; none of them need to be installed by you. The launcher prefers the bundled runtimes and only falls back to `PATH`. If the machine already has .NET 10, the bundled 57 MB installer deletes itself after installation, leaving no garbage behind.

The same applies to the bridge: pressing **Start** launches it with the bundled Python, which already has `wechatauto`, `pywin32`, `uiautomation`, `Pillow`, `cryptography`, `pysilk` and friends installed.

The only things you must supply: **a logged-in secondary WeChat account** and **one model API key** (DeepSeek / Zhipu / Qwen, your pick).

## Updating to a new version

### Installed edition (setup.exe)

Press **Check for updates** in the launcher: it reads `release-manifest.json`, downloads the official installer, **verifies SHA256** and installs it silently over the old version.

- Running processes are stopped before the overwrite, so it never fails on "access denied".
- The installation directory is reused; `data\` (chat memory) and `config.json` (keys) are left untouched.
- Downloads honour the system proxy; offline it falls back to a local cache, and if that never succeeded the update is skipped rather than blocking startup.
- Forced updates have four levels (normal / notify / force / block), tunable remotely from the manifest.

### Source edition (extracted zip)

No manual download required: press **Check for updates** in the launcher, or run `powershell -File scripts\update.ps1`; it finds the latest release, downloads it, verifies it and overwrites the installation, leaving `data\` and `config.json` alone.

```
[Enter] update now    [r] roll back last update    [q] quit
```

- **Verification** — the `sha256` from the official API is checked; a mismatch aborts instead of installing half a package.
- **Automatic rollback** — after overwriting, the version, memory count and `config.json` hash are re-checked; any failure restores the backup.
- **Mirrors** — if GitHub is unreachable, a mirror is tried (`ghfast.top` / `gh-proxy.com` / `gh-proxy.org` / `ghproxy.net`, transport only, never verification); when the version API is blocked, the `gh-proxy.com` / `gh-proxy.org` API proxies are used, and only after that is the version scraped from a mirror page. You can also download the zip yourself and run `scripts\update.ps1 <zip-path>`.
- **Check only** — `scripts\update.ps1 -Check`; **manual rollback** — `scripts\update.ps1 -Rollback`.
- **First run in a moved directory** — if `data\` is missing, it looks for older installations, lists them newest-first with session and message counts, then moves the chosen one on Enter (`s` skips, a number picks another). Or point at one directly: `scripts\update.ps1 -Migrate -FromDir "D:\whale-girl-3.50"`.
- **Low integrity label** — if the install directory carries the Low label, node cannot write `%TEMP%` (`EPERM`); before updating, `runtime\node.exe` and `python.exe` are relabelled Medium, and a writable temp directory inside the install path is used if that fails.

> If you modified the source, note that the update replaces files wholesale. When local customisations are detected, the script lists them and asks for confirmation (`-Force` skips the prompt).

## When the launcher won't open

The repository root has exactly one double-click entry, `WhaleLauncher.exe`; everything else is a command-line script. Use these when the launcher fails, or on a machine without a GUI:

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

- the Whale Girl kernel (whatever holds port 8787),
- the WeChat bridge (`wechatauto_bridge.py`),
- the launcher window (if left open it would restart the bridge).

It also writes `data\PAUSED` so nothing restarts automatically, scans three extra times because a child process may spawn while its parent is being killed, and finally prints a green "clean" line or the list of leftover PIDs.

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

- Group history is fed to the model as **events**: every line keeps its speaker, time and @ target, so several people's messages are not squashed into one, and someone else's "you" is never mistaken for an address to Whale Girl.
- If a message @-mentions somebody else and then says "you", she does not jump in; if it @-mentions both her and another person, that person is recorded as a mention.
- DM context is 100 messages by default, group context 60 (`chat.historyTurns` / `chat.groupHistoryTurns`, capped at 120/100). `memory.maxMessages` must be at least the largest window, otherwise messages cannot be stored. The "messages" count in the UI means individual messages, not question/answer turns.

### Persona presets (one file per version)

`assets/personas/` holds one file per persona version; upgrades add files and never overwrite old ones. Import them from the bottom of the launcher's **Persona** page. Conventions and privacy rules are in [assets/personas/README.md](assets/personas/README.md).

---

## Pause and resume

Close the launcher (or run `scripts\stop-all.ps1`): kernel and bridge stop without sending anything and `data/PAUSED` is written. Open `WhaleLauncher.exe` and press **Start** to resume — it clears the pause marker.

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

Not committed, generated at runtime: `data/` (keys, memory, logs), `runtime/` (bundled Node and Python), `artifacts/` (build output) and `config.json` (local configuration).

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

Only download installers from **GitHub Releases**: <https://github.com/Banan1cee/whale_girl/releases>.
Checksums and verification commands are in [docs/DOWNLOAD.md](docs/DOWNLOAD.md).

## Code signing policy

Current release builds are **not signed yet**, so Windows shows "Unknown publisher". Verify `SHA256SUMS.txt` from the release before installing.
The signing policy is in [docs/CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md); the privacy policy is in [PRIVACY.md](PRIVACY.md).

## Acknowledgements

WeChat support in this project stands entirely on the shoulders of others. Special thanks to:

- **Original character author: 上善无形** — the Whale Girl icon used in this project is a **derivative work** based on their original character. Rights in the original character remain with the original author; this project uses and credits it within the permitted scope. See [NOTICE.md](NOTICE.md).
- **[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)** (v1.2.9, **Apache-2.0**, by fanyuantaier, [PyPI](https://pypi.org/project/wechatauto-replica/))
  — a Windows WeChat 4.x automation library (a wxauto replica): SQLCipher database decryption plus hybrid UIA / coordinate-OCR sending.
  The WeChat bridge (`examples/wechatauto_bridge.py`) is built directly on top of it.
  - The source is vendored as a pinned copy in `vendor/wechatauto/` (including the original `dist-info/licenses/LICENSE`), with a manifest and checksums in `vendor/MANIFEST.sha256` and notes in `vendor/README.md`.
  - The build copies it into `runtime/` only after verifying every file against the manifest and **never edits the upstream source**; behaviour changes belong in the build-time patch `scripts/prepare-sticker-runtime.py`, and runtime compatibility patches are applied from `examples/uia_compat.py`.
  - The upstream README says "for personal study and automation research only". That is the author's wish, not a licence term; the actual rights come from Apache-2.0 (see below).
- **[wxauto](https://github.com/cluic/wxauto)** (Apache-2.0) — the pioneer of Windows WeChat automation; `wechatauto-replica` is its 4.x replica and inherits its approach.
- **[VB-CABLE](https://vb-audio.com/Cable/)** (VB-Audio, donationware) — the virtual audio cable used for voice sending; the installer only ships the official installer.

### Third-party licence and redistribution

- `wechatauto-replica` is licensed under **Apache-2.0**, which permits private and commercial use, modification and redistribution **provided the licence and copyright notices are kept, your changes are stated, and you do not imply endorsement by the upstream project**.
- This repository satisfies those terms by shipping the licence text at `vendor/wechatauto/dist-info/licenses/LICENSE`, keeping the upstream source unmodified (patches happen at build/run time only, verified by `vendor/MANIFEST.sha256`), and crediting the project here and in `vendor/README.md`.
- This project's original code, documentation and original assets are licensed under **AGPL-3.0-only** (see [LICENSE](LICENSE)). It is an OSI-approved open-source license: commercial use is allowed, but if you distribute a modified version or let users interact with it over a network, you must offer the complete corresponding source under AGPL-3.0. Third-party components keep their own licenses; see [NOTICE.md](NOTICE.md).

## License

**AGPL-3.0-only** — see [LICENSE](LICENSE). You may use, modify and distribute it, including commercially, under the AGPL. Network services based on modified versions must offer their source. Please keep the attribution described in [NOTICE.md](NOTICE.md).
