[![npm version](https://img.shields.io/docker/pulls/raiper34/vl-downloader)](https://hub.docker.com/repository/docker/raiper34/vl-downloader/general)
[![npm version](https://img.shields.io/docker/image-size/raiper34/vl-downloader)](https://hub.docker.com/repository/docker/raiper34/vl-downloader/general)
[![npm version](https://img.shields.io/docker/stars/raiper34/vl-downloader)](https://hub.docker.com/repository/docker/raiper34/vl-downloader/general)
[![docs](https://badgen.net/badge/docs/online/orange)](https://vl-downloader.netlify.app)
[![GitHub License](https://img.shields.io/github/license/raiper34/vl-downloader)](https://github.com/Raiper34/vl-downloader)
[![GitHub Repo stars](https://img.shields.io/github/stars/raiper34/vl-downloader)](https://github.com/Raiper34/vl-downloader)

![vl-downloader logo](assets/logo.svg)
# VL Downloader - self-hosted Vimm's Lair rom downloader

VL Downloader is self-hosted [Vimm's Lair](https://vimm.net/) rom downloader.
It is able to download ROMs directly from VL website into your home lab/nas/multimedia server and it also supports adding ROMs to the download queue and able to download multiple ROMs without extra interaction.
The project is based on NestJS and Angular.

> [!IMPORTANT]
> Please do not use this tool for piracy! Download only ROMs your own rights!

> [!IMPORTANT]
> Please copy and paste the link from VL website one by one, to generate VM author some revenue from ads also, do not download constantly large numbers of rooms, do not slow VL website this way! Please also do not modify this tool to be able to download large numbers of ROMs at once. It is designed to download ROM one by one to not be too aggressive for the website!

![demo](assets/demo.gif)

### Content
- [🚀 Installation](#-installation)
- [🦊 Built-in browser](#-built-in-browser)
- [🗂️ System folders](#️-system-folders)
- [🎮 RomM integration](#-romm-integration)
- [⚙️ Configuration](#️-configuration)
- [📖 License](#-license)

# 🚀 Installation

### Docker Compose (recommended)
`docker-compose.yml` runs VL Downloader as a single container (the Redis used for the
queue is built in) and keeps the database in a volume.

```bash
mkdir -p downloads config
sudo chown 99:100 downloads config   # matches `user: "99:100"` (Unraid nobody:users)
docker compose up -d
```
The image `ghcr.io/kernelguru/vl-downloader` is built by GitHub Actions on every push to `main`.
Then open http://<host>:3000. Remove the `user:` line in the compose file to run as root.

### docker run
Without compose:
```bash
docker run -d -p 3000:3000 \
  -v /path/to/downloads:/vl-downloader/backend/downloads \
  -v /path/to/config:/vl-downloader/backend/config \
  ghcr.io/kernelguru/vl-downloader:latest
```
Queued downloads survive restarts: they are stored in the database and re-queued on start.

# 🦊 Built-in browser
The image contains a Firefox running on the server (Xvfb + x11vnc + noVNC). Open it from
**Open browser** in the web UI – also from a phone – browse Vimm's Lair and download as usual.
You use the site yourself (including any "are you human" check); only the file transfer happens on the server.

Downloads are saved into the inbox (`/vl-downloader/backend/inbox`). As soon as a file is complete it is
- extracted (`.zip`, `.7z`, `.rar` with 7-Zip; archive deleted afterwards),
- assigned to a system: file extensions, `.gdi`, or the disc header of `.iso`/`.bin` images
  (PS1, PS2, PSP, PS3, GameCube, Wii, Saturn, Sega CD, Dreamcast, PC Engine CD, CD-i),
  or the system you picked in the browser section,
- moved to `<downloads>/<system>/` (several files such as `.cue` + `.bin` go into one folder per game),
- and RomM is asked to scan.

Unknown systems stay in the root of the download folder; set the system on the entry and the game is moved.
The Firefox profile (cookies, settings) lives in `config/firefox`.

| Variable | Default | Description |
|---|---|---|
| `BROWSER_ENABLED` | `true` | Start the built-in browser |
| `BROWSER_RESOLUTION` | `1280x900` | Size of the virtual screen |
| `BROWSER_START_URL` | `https://vimm.net/vault` | Start page |
| `INBOX_PATH` | `./inbox` | Download folder of the browser |
| `EXTRACT_ARCHIVES` | `true` | Extract archives from the inbox |
| `DELETE_ARCHIVES` | `true` | Delete archives after extracting |

The browser has no password – like the rest of the app, only expose port 3000 in your home network.

# 🗂️ System folders
Every download is saved into a folder per system, named like the
[RomM platform folders](https://docs.romm.app/latest/platforms/supported-platforms/):
```
downloads/
├─ n64/Super Mario 64 (USA).zip
├─ psx/Final Fantasy VII (USA) (Disc 1).zip
└─ gba/…
```
- The system is detected from the Vimm page. If that fails, from the file extension or the
  files inside a ZIP. You can also pick the system before adding a URL, or change it later
  per entry (the file is moved).
- If a folder with an older RomM name already exists (`ps`, `genesis-slash-megadrive`, …) it is reused.
- Files downloaded before this feature can be sorted with **Sort existing files into system folders**
  (with a preview). Optionally the Vimm page of an entry is opened to find its system, one page every few seconds.
- Files with an unknown system stay in the root of the download folder.

# 🎮 RomM integration
Mount RomM's `roms` folder as the download folder (RomM structure A):
```yaml
volumes:
  - /mnt/user/appdata/romm/library/roms:/vl-downloader/backend/downloads
```
For RomM structure B (`library/<platform>/roms`) mount `library` and set `FOLDER_LAYOUT={system}/roms`.

To let VL Downloader start a RomM scan after downloads, set `ROMM_URL` and either a
client API token (`ROMM_API_TOKEN`, scope `tasks.run`) or `ROMM_USERNAME` / `ROMM_PASSWORD`.
Downloads finishing within `ROMM_SCAN_DELAY` seconds are batched into one quick scan of the
affected platforms. Older RomM versions get a full `scan_library` run instead.
RomM and VL Downloader both need write access to the folder (same uid/gid, e.g. 99:100 on Unraid).

# ⚙️ Configuration
| Variable | Default | Description |
|---|---|---|
| `ORGANIZE_BY_SYSTEM` | `true` | One folder per system |
| `FOLDER_LAYOUT` | `{system}` | Sub path inside the download folder, `{system}` = platform folder |
| `SYSTEM_FOLDERS` | – | Own folder names, e.g. `psx=ps,genesis=megadrive` |
| `ROMM_URL` | – | e.g. `http://192.168.1.10:8080`, enables the RomM integration |
| `ROMM_API_TOKEN` | – | RomM client API token (`rmm_…`) |
| `ROMM_USERNAME` / `ROMM_PASSWORD` | – | Alternative to the token |
| `ROMM_SCAN_DELAY` | `30` | Seconds to wait after the last download before scanning |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis for the download queue |
| `EMBEDDED_REDIS` | `true` | Start the bundled redis-server if Redis is local and not running; set `false` with an external Redis |
| `PAGE_TIMEOUT` | `60` | Seconds to load the Vimm page |
| `DOWNLOAD_START_TIMEOUT` | `90` | Seconds until the download has to start |
| `DOWNLOAD_STALL_TIMEOUT` | `180` | Abort if no progress for this many seconds |

# 📖 License
MIT