# pi-theme-sync

Sync Pi theme with terminal appearance — works both **locally** and **over SSH**.

Terminal-first theme sync for Pi, with robust SSH support.

## How it works

The extension uses a three-layer detection strategy (in priority order):

| Priority | Strategy | When it helps |
|----------|----------|---------------|
| 1 | **Override file** (`~/.pi/agent/theme-sync-override.json`) | Manual push from another machine |
| 2 | **Terminal query** (OSC 11 background-color) | Preferred in interactive terminal sessions (local/SSH/tmux) for fast theme detection |
| 3 | **OS-level detection** (optional fallback) | Disabled by default; can be enabled explicitly |

### Why it works over SSH

When you SSH into a remote machine, your local terminal (Ghostty) is still rendering everything. The extension sends an [OSC 11](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) query (`\033]11;?\033\\`) to stdout. This travels through the SSH tunnel to Ghostty, which replies with the current background RGB. The extension parses the luminance to determine dark or light.

This means: **when Ghostty switches `theme = auto` on your Laptop, the remote pi detects it within seconds — no push scripts needed.**

The OSC 11 query runs in a short-lived subprocess that opens `/dev/tty` directly, so it doesn't interfere with pi's own terminal I/O.

## Install

```bash
pi install npm:pi-theme-sync
```

> **Important:** Remove `pi-system-theme` first to avoid two extensions fighting over `setTheme`:
> ```bash
> pi remove npm:pi-system-theme
> ```

## Package rename migration

This package was renamed from `pi-system-theme-ssh-bridge` / `pi-sync-system-theme` to `pi-theme-sync`.

If you installed the old package name, run:

```bash
pi remove npm:pi-system-theme-ssh-bridge
pi install npm:pi-theme-sync
```

## Configuration

Use the `/system-theme` command inside pi to configure:

1. **Dark theme** name (default: `dark`)
2. **Light theme** name (default: `light`)
3. **Poll interval** in ms (default: `8000`)

Settings are saved to `~/.pi/agent/theme-sync-config.json`.

### Runtime commands

- `/system-theme` — configure dark/light theme mapping and poll interval
- `/system-theme-refresh` — manually re-run detection and apply mapped theme (**best-effort**)
- `/system-theme-debug` — print detection trace (override / OSC11 / OS fallback) for troubleshooting
- `/system-theme-push dark|light|auto` — write override appearance manually on the current machine

### Reliable-first behavior (default)

To reduce input lag and TTY contention in long-running remote sessions:

- Startup and `/resume`: performs an immediate OSC11 reconciliation attempt
- Background polling: prefers override + OS fallback (does **not** continuously probe OSC11)
- Manual fallback: `/system-theme-refresh` forces a one-shot OSC11 probe (may still fail in some remote TTY setups)

This keeps startup correction intuitive while minimizing runtime interference.

### Recommended remote workflow (stable)

When Pi runs on a remote host, the most reliable setup is:

1. Run Pi remotely (SSH/tmux as usual)
2. Push override updates from your **local machine** when local appearance changes
3. Let remote Pi apply the override on next tick (or immediately on startup/resume)

Example local push:

```bash
./push-theme-override.sh user@remote-host
```

In practice, local push + remote reconcile is more stable than relying on continuous OSC11 probing during an active remote session.

## Override file (optional)

For environments where neither OSC 11 nor OS detection works, you can push an override file manually:

```bash
# On your Laptop, push current appearance to Desktop:
./push-theme-override.sh user@desktop

# Or inside pi on any machine:
/system-theme-push dark
/system-theme-push light
/system-theme-push auto    # clears override, falls back to detection
```

### Override file format

```json
{
  "appearance": "dark",
  "updatedAt": "2026-02-22T07:00:00Z",
  "source": "my-laptop"
}
```

## ⚠️ Performance tuning notes (important)

This extension queries terminal background color (OSC 11) in interactive sessions (local/SSH/tmux). Aggressive polling can cause terminal artifacts (garbled startup output) or input lag on some terminal/SSH combinations.

Recommended ranges:

- `pollMs`: **3000–8000** (default `8000`)
- `PI_THEME_SYNC_OSC11_MIN_INTERVAL_MS`: **8000–15000** (default `15000`)

Avoid overly aggressive values unless you have tested your environment thoroughly:

- `pollMs < 2000`
- `PI_THEME_SYNC_OSC11_MIN_INTERVAL_MS < 5000`

If you notice lag, slash-command stutter, or startup artifacts:

1. Increase `pollMs`
2. Increase `PI_THEME_SYNC_OSC11_MIN_INTERVAL_MS`
3. Temporarily disable OSC11 probing with:

```bash
export PI_THEME_SYNC_OSC11_ENABLED=0
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_THEME_SYNC_OVERRIDE_FILE` | `~/.pi/agent/theme-sync-override.json` | Override file path |
| `PI_THEME_SYNC_OVERRIDE_MAX_AGE_MS` | `60000` | Max age before override is considered stale |
| `PI_THEME_SYNC_OSC11_ENABLED` | `1` | Enable/disable OSC 11 terminal query (`0` to disable) |
| `PI_THEME_SYNC_OSC11_MIN_INTERVAL_MS` | `15000` | Minimum interval between OSC 11 probes in interactive sessions |
| `PI_THEME_SYNC_OS_FALLBACK` | `0` | Enable OS-level fallback detection (`1` to enable) |

## Compatibility

- **Terminals:** Any terminal supporting OSC 11 color queries (Ghostty, iTerm2, kitty, foot, WezTerm, xterm, etc.)
- **OS detection fallback:** macOS, Linux (GNOME gsettings), Windows (when `PI_THEME_SYNC_OS_FALLBACK=1`)
- **SSH:** Works transparently — no special setup required
- **tmux:** Supported (including long-lived sessions where `SSH_*` env vars may be missing)
- **Ghostty `theme = auto`:** Fully supported. When Ghostty switches colors, the next poll detects it.
- **Session resume:** On `/resume`, the extension immediately re-checks appearance and reconciles the active theme.

## Migrating from pi-system-theme

1. `pi remove npm:pi-system-theme`
2. `pi install npm:pi-theme-sync`
3. Configure `/system-theme` as needed.

## License

MIT
