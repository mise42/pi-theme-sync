# pi-sync-system-theme

Sync pi theme with system appearance — works both **locally** and **over SSH**.

Drop-in replacement for `pi-system-theme`, with added SSH support.

## How it works

The extension uses a three-layer detection strategy (in priority order):

| Priority | Strategy | When it helps |
|----------|----------|---------------|
| 1 | **Override file** (`~/.pi/agent/system-theme-override.json`) | Manual push from another machine |
| 2 | **Terminal query** (OSC 11 background-color) | SSH sessions — escape sequences travel through the SSH tunnel back to your local Ghostty, which responds with its current background color |
| 3 | **OS-level detection** (macOS `defaults` / GNOME `gsettings` / Windows `reg`) | Local sessions without a capable terminal |

### Why it works over SSH

When you SSH into a remote machine, your local terminal (Ghostty) is still rendering everything. The extension sends an [OSC 11](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) query (`\033]11;?\033\\`) to stdout. This travels through the SSH tunnel to Ghostty, which replies with the current background RGB. The extension parses the luminance to determine dark or light.

This means: **when Ghostty switches `theme = auto` on your Laptop, the remote pi detects it within seconds — no push scripts needed.**

The OSC 11 query runs in a short-lived subprocess that opens `/dev/tty` directly, so it doesn't interfere with pi's own terminal I/O.

## Install

```bash
pi install npm:pi-sync-system-theme
```

> **Important:** Remove `pi-system-theme` first to avoid two extensions fighting over `setTheme`:
> ```bash
> pi remove npm:pi-system-theme
> ```

## Package rename migration

This package was renamed from `pi-system-theme-ssh-bridge` to `pi-sync-system-theme`.

If you installed the old package name, run:

```bash
pi remove npm:pi-system-theme-ssh-bridge
pi install npm:pi-sync-system-theme
```

## Configuration

Use the `/system-theme` command inside pi to configure:

1. **Dark theme** name (default: `dark`)
2. **Light theme** name (default: `light`)
3. **Poll interval** in ms (default: `8000`)

Settings are saved to `~/.pi/agent/system-theme.json` (same location as `pi-system-theme`, so existing config carries over).

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

This extension queries terminal background color (OSC 11) in SSH sessions. Aggressive polling can cause terminal artifacts (garbled startup output) or input lag on some terminal/SSH combinations.

Recommended ranges:

- `pollMs`: **3000–8000** (default `8000`)
- `PI_SYSTEM_THEME_OSC11_MIN_INTERVAL_MS`: **8000–15000** (default `15000`)

Avoid overly aggressive values unless you have tested your environment thoroughly:

- `pollMs < 2000`
- `PI_SYSTEM_THEME_OSC11_MIN_INTERVAL_MS < 5000`

If you notice lag, slash-command stutter, or startup artifacts:

1. Increase `pollMs`
2. Increase `PI_SYSTEM_THEME_OSC11_MIN_INTERVAL_MS`
3. Temporarily disable OSC11 probing with:

```bash
export PI_SYSTEM_THEME_OSC11_ENABLED=0
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SYSTEM_THEME_OVERRIDE_FILE` | `~/.pi/agent/system-theme-override.json` | Override file path |
| `PI_SYSTEM_THEME_OVERRIDE_MAX_AGE_MS` | `60000` | Max age before override is considered stale |
| `PI_SYSTEM_THEME_OSC11_ENABLED` | `1` | Enable/disable OSC 11 terminal query (`0` to disable) |
| `PI_SYSTEM_THEME_OSC11_MIN_INTERVAL_MS` | `15000` | Minimum interval between OSC 11 probes in SSH sessions |

## Compatibility

- **Terminals:** Any terminal supporting OSC 11 color queries (Ghostty, iTerm2, kitty, foot, WezTerm, xterm, etc.)
- **OS detection:** macOS, Linux (GNOME gsettings), Windows
- **SSH:** Works transparently — no special setup required
- **Ghostty `theme = auto`:** Fully supported. When Ghostty switches colors, the next poll detects it.

## Migrating from pi-system-theme

1. `pi remove npm:pi-system-theme`
2. `pi install npm:pi-sync-system-theme`
3. Done. Your `~/.pi/agent/system-theme.json` config (if any) is reused automatically.

## License

MIT
