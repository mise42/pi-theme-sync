/**
 * pi-sync-system-theme
 *
 * Sync pi theme with system appearance — works both locally and over SSH.
 *
 * Detection strategy (in priority order):
 *   1. Override file  (~/.pi/agent/system-theme-override.json)
 *      – If present & fresh, use its "dark" / "light" value directly.
 *      – If value is "auto", fall through.
 *   2. Terminal query  (OSC 11 background-color)
 *      – Works transparently over SSH because escape sequences travel
 *        through the SSH tunnel back to the local terminal (Ghostty, etc.).
 *      – A helper subprocess opens /dev/tty to avoid interfering with
 *        pi's own stdin/stdout.
 *   3. OS-level detection  (macOS defaults / GNOME gsettings / Windows reg)
 *      – Classic local detection, same as pi-system-theme.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Appearance = "dark" | "light";
type OverrideAppearance = Appearance | "auto";

type Config = {
    darkTheme: string;
    lightTheme: string;
    pollMs: number;
    overrideFile: string;
    overrideMaxAgeMs: number;
};

type OverridePayload = {
    appearance: OverrideAppearance;
    updatedAt?: string;
    source?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Config = {
    darkTheme: "dark",
    lightTheme: "light",
    pollMs: 8000,
    overrideFile: path.join(os.homedir(), ".pi", "agent", "system-theme-override.json"),
    overrideMaxAgeMs: 60_000,
};

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "system-theme.json");
const DETECTION_TIMEOUT_MS = 1200;
const MIN_POLL_MS = 1000;
const OSC11_QUERY_TIMEOUT_MS = 1200;
const OSC11_MIN_INTERVAL_MS = 15_000;
const OSC11_DISABLE_AFTER_FAILURES = 3;
const OSC11_DISABLE_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSettingValue(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function toThemeName(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

function toPollMs(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(MIN_POLL_MS, Math.round(value));
}

function extractStderr(error: unknown): string {
    if (!error || typeof error !== "object") return "";
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" ? stderr : "";
}

function parseOverrideAppearance(value: unknown): OverrideAppearance | null {
    if (value === "dark" || value === "light" || value === "auto") return value;
    return null;
}

function isDefaultThemeName(name: string | undefined): boolean {
    return name === DEFAULT_CONFIG.darkTheme || name === DEFAULT_CONFIG.lightTheme;
}

function canManageThemes(ctx: ExtensionContext): boolean {
    return ctx.hasUI && ctx.ui.getAllThemes().length > 0;
}

function isSSHSession(): boolean {
    return !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT);
}

// ---------------------------------------------------------------------------
// Config I/O  (reads ~/.pi/agent/system-theme.json written by /system-theme)
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<Config> {
    const config = { ...DEFAULT_CONFIG };

    // Read theme mapping from shared config (same file as pi-system-theme)
    try {
        const raw = await readFile(GLOBAL_CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (isObject(parsed)) {
            config.darkTheme = toThemeName(parsed.darkTheme, config.darkTheme);
            config.lightTheme = toThemeName(parsed.lightTheme, config.lightTheme);
            config.pollMs = toPollMs(parsed.pollMs, config.pollMs);
        }
    } catch {
        // missing or corrupt → use defaults
    }

    // Env overrides for bridge-specific settings
    const envFile = process.env.PI_SYSTEM_THEME_OVERRIDE_FILE;
    if (typeof envFile === "string" && envFile.trim().length > 0) {
        config.overrideFile = envFile.trim();
    }

    const envMaxAge = process.env.PI_SYSTEM_THEME_OVERRIDE_MAX_AGE_MS;
    if (envMaxAge) {
        const v = Number.parseInt(envMaxAge, 10);
        if (Number.isFinite(v)) config.overrideMaxAgeMs = Math.max(0, v);
    }

    return config;
}

async function saveConfig(config: Config): Promise<void> {
    const overrides: Partial<Config> = {};
    if (config.darkTheme !== DEFAULT_CONFIG.darkTheme) overrides.darkTheme = config.darkTheme;
    if (config.lightTheme !== DEFAULT_CONFIG.lightTheme) overrides.lightTheme = config.lightTheme;
    if (config.pollMs !== DEFAULT_CONFIG.pollMs) overrides.pollMs = config.pollMs;

    if (Object.keys(overrides).length === 0) {
        const { rm } = await import("node:fs/promises");
        await rm(GLOBAL_CONFIG_PATH, { force: true });
        return;
    }

    await mkdir(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    await writeFile(GLOBAL_CONFIG_PATH, `${JSON.stringify(overrides, null, 4)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Strategy 1: Override file
// ---------------------------------------------------------------------------

async function readOverrideFile(filePath: string, maxAgeMs: number): Promise<Appearance | "auto" | null> {
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isObject(parsed)) return null;

        const appearance = parseOverrideAppearance(parsed.appearance);
        if (!appearance) return null;

        // Check freshness
        if (maxAgeMs > 0) {
            const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
            if (!updatedAt) return null;
            const time = Date.parse(updatedAt);
            if (!Number.isFinite(time) || Date.now() - time > maxAgeMs) return null;
        }

        return appearance;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Strategy 2: Terminal background color query (OSC 11)
//
// We spawn a short-lived subprocess that opens /dev/tty directly.
// This avoids competing with pi's own stdin/stdout handling.
// The query works transparently over SSH because escape sequences
// travel through the SSH pseudo-terminal back to the local terminal.
// ---------------------------------------------------------------------------

const OSC11_QUERY_SCRIPT = `
'use strict';
const fs = require('fs');

const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
let fd;
try { fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY | O_NONBLOCK); }
catch { process.exit(1); }

// Send OSC 11 query (BEL terminator is widely supported)
try { fs.writeSync(fd, '\x1b]11;?\x07'); }
catch { try { fs.closeSync(fd); } catch {} process.exit(1); }

const buf = Buffer.alloc(1024);
let response = '';
const deadline = Date.now() + 1000;

function tryRead() {
    while (true) {
        try {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) return;
            response += buf.toString('utf8', 0, n);
            if (response.length > 8192) response = response.slice(-4096);
        } catch (err) {
            const code = err && err.code;
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return;
            return;
        }
    }
}

function done() {
    try { fs.closeSync(fd); } catch {}
    const m = response.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\\/([0-9a-fA-F]+)\\/([0-9a-fA-F]+)(?:\x07|\x1b\\\\)/);
    if (m) {
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[2].slice(0, 2), 16);
        const b = parseInt(m[3].slice(0, 2), 16);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        process.stdout.write(luminance < 128 ? 'dark' : 'light');
    }
    process.exit(0);
}

function poll() {
    tryRead();
    if (response.includes('\x1b]11;') || Date.now() > deadline) return done();
    setTimeout(poll, 16);
}

poll();
`;

function queryTerminalBackground(): Promise<Appearance | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill();
            resolve(null);
        }, OSC11_QUERY_TIMEOUT_MS + 300);

        const child = spawn(process.execPath, ["-e", OSC11_QUERY_SCRIPT], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: OSC11_QUERY_TIMEOUT_MS + 300,
        });

        let stdout = "";
        child.stdout!.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.on("close", () => {
            clearTimeout(timer);
            const trimmed = stdout.trim();
            if (trimmed === "dark" || trimmed === "light") {
                resolve(trimmed);
            } else {
                resolve(null);
            }
        });

        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}

// ---------------------------------------------------------------------------
// Strategy 3: OS-level detection (fallback)
// ---------------------------------------------------------------------------

async function detectMacAppearance(): Promise<Appearance | null> {
    try {
        const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
            timeout: DETECTION_TIMEOUT_MS,
            windowsHide: true,
        });
        return normalizeSettingValue(stdout) === "dark" ? "dark" : null;
    } catch (error) {
        const stderr = extractStderr(error).toLowerCase();
        if (stderr.includes("does not exist")) return "light";
        return null;
    }
}

async function detectLinuxAppearance(): Promise<Appearance | null> {
    try {
        const { stdout } = await execFileAsync("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"], {
            timeout: DETECTION_TIMEOUT_MS,
            windowsHide: true,
        });
        const v = normalizeSettingValue(stdout);
        if (v === "prefer-dark") return "dark";
        if (v === "prefer-light") return "light";
    } catch {
        // ignore
    }

    try {
        const { stdout } = await execFileAsync("gsettings", ["get", "org.gnome.desktop.interface", "gtk-theme"], {
            timeout: DETECTION_TIMEOUT_MS,
            windowsHide: true,
        });
        const v = normalizeSettingValue(stdout);
        if (v.includes("dark")) return "dark";
        if (v.includes("light")) return "light";
    } catch {
        // ignore
    }

    return null;
}

async function detectWindowsAppearance(): Promise<Appearance | null> {
    try {
        const { stdout } = await execFileAsync(
            "reg",
            [
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                "/v",
                "AppsUseLightTheme",
            ],
            { timeout: DETECTION_TIMEOUT_MS, windowsHide: true },
        );
        const match = stdout.match(/AppsUseLightTheme\s+REG_DWORD\s+(\S+)/i);
        if (!match) return null;
        const raw = match[1] ?? "";
        const num = raw.toLowerCase().startsWith("0x")
            ? Number.parseInt(raw.slice(2), 16)
            : Number.parseInt(raw, 10);
        if (num === 0) return "dark";
        if (num === 1) return "light";
        return null;
    } catch {
        return null;
    }
}

async function detectOSAppearance(): Promise<Appearance | null> {
    switch (process.platform) {
        case "darwin":
            return detectMacAppearance();
        case "linux":
            return detectLinuxAppearance();
        case "win32":
            return detectWindowsAppearance();
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Unified detection: override file → terminal query → OS detection
// ---------------------------------------------------------------------------

type Osc11State = {
    lastCheckedAt: number;
    lastAppearance: Appearance | null;
    failures: number;
    disabledUntil: number;
};

function isOsc11Enabled(): boolean {
    const raw = String(process.env.PI_SYSTEM_THEME_OSC11_ENABLED ?? "1").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "off";
}

function getOsc11MinIntervalMs(): number {
    const raw = process.env.PI_SYSTEM_THEME_OSC11_MIN_INTERVAL_MS;
    if (!raw) return OSC11_MIN_INTERVAL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return OSC11_MIN_INTERVAL_MS;
    return Math.max(1000, parsed);
}

async function resolveAppearance(config: Config, osc11State: Osc11State): Promise<Appearance | null> {
    // 1. Override file (highest priority)
    const override = await readOverrideFile(config.overrideFile, config.overrideMaxAgeMs);
    if (override === "dark" || override === "light") return override;
    // "auto" or null → continue

    // 2. Terminal query via OSC 11 (SSH only, throttled)
    if (isSSHSession() && isOsc11Enabled()) {
        const now = Date.now();
        const minIntervalMs = getOsc11MinIntervalMs();

        if (now >= osc11State.disabledUntil && now - osc11State.lastCheckedAt >= minIntervalMs) {
            osc11State.lastCheckedAt = now;
            const fromTerminal = await queryTerminalBackground();
            if (fromTerminal) {
                osc11State.lastAppearance = fromTerminal;
                osc11State.failures = 0;
                return fromTerminal;
            }

            osc11State.failures += 1;
            if (osc11State.failures >= OSC11_DISABLE_AFTER_FAILURES) {
                osc11State.disabledUntil = now + OSC11_DISABLE_COOLDOWN_MS;
                osc11State.failures = 0;
            }
        }

        if (osc11State.lastAppearance) return osc11State.lastAppearance;
    }

    // 3. OS-level detection (local fallback)
    return detectOSAppearance();
}

// ---------------------------------------------------------------------------
// Interactive settings command  (/system-theme)
// ---------------------------------------------------------------------------

async function promptTheme(
    ctx: ExtensionCommandContext,
    label: string,
    currentValue: string,
): Promise<string | undefined> {
    const next = await ctx.ui.input(label, currentValue);
    if (next === undefined) return undefined;
    const trimmed = next.trim();
    return trimmed.length > 0 ? trimmed : currentValue;
}

async function promptPollMs(ctx: ExtensionCommandContext, currentValue: number): Promise<number | undefined> {
    while (true) {
        const next = await ctx.ui.input("Poll interval (ms)", String(currentValue));
        if (next === undefined) return undefined;
        const trimmed = next.trim();
        if (trimmed.length === 0) return currentValue;
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isFinite(parsed) && parsed >= MIN_POLL_MS) return parsed;
        ctx.ui.notify(`Enter a whole number ≥ ${MIN_POLL_MS}.`, "warning");
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function systemThemeBridge(pi: ExtensionAPI): void {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    let config: Config = { ...DEFAULT_CONFIG };
    let lastAppliedTheme: string | null = null;
    let didWarnCustomTheme = false;
    const osc11State: Osc11State = {
        lastCheckedAt: 0,
        lastAppearance: null,
        failures: 0,
        disabledUntil: 0,
    };

    function hasThemeOverrides(): boolean {
        return config.darkTheme !== DEFAULT_CONFIG.darkTheme || config.lightTheme !== DEFAULT_CONFIG.lightTheme;
    }

    function shouldAutoSync(ctx: ExtensionContext): boolean {
        if (!canManageThemes(ctx)) return false;
        if (hasThemeOverrides()) return true;
        return isDefaultThemeName(ctx.ui.theme.name);
    }

    function maybeWarnCustomTheme(ctx: ExtensionContext): void {
        if (didWarnCustomTheme || !canManageThemes(ctx) || hasThemeOverrides()) return;
        const currentTheme = ctx.ui.theme.name;
        if (isDefaultThemeName(currentTheme)) return;
        didWarnCustomTheme = true;
        ctx.ui.notify(
            `Current theme "${currentTheme ?? "unknown"}" is custom. ` +
                `Auto-sync skipped. Configure /system-theme to enable.`,
            "info",
        );
    }

    async function tick(ctx: ExtensionContext): Promise<void> {
        if (!shouldAutoSync(ctx) || inFlight) return;

        inFlight = true;
        try {
            const appearance = await resolveAppearance(config, osc11State);
            if (!appearance) return;

            const targetTheme = appearance === "dark" ? config.darkTheme : config.lightTheme;
            if (ctx.ui.theme.name === targetTheme && lastAppliedTheme === targetTheme) return;

            const result = ctx.ui.setTheme(targetTheme);
            if (result.success) {
                lastAppliedTheme = targetTheme;
            } else {
                const msg = result.error ?? "unknown";
                if (lastAppliedTheme !== `err:${targetTheme}:${msg}`) {
                    lastAppliedTheme = `err:${targetTheme}:${msg}`;
                    console.warn(`[pi-sync-system-theme] setTheme("${targetTheme}"): ${msg}`);
                }
            }
        } finally {
            inFlight = false;
        }
    }

    function restartPolling(ctx: ExtensionContext): void {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (!shouldAutoSync(ctx)) return;
        intervalId = setInterval(() => void tick(ctx), config.pollMs);
    }

    // -- /system-theme command (interactive settings) -------------------------

    pi.registerCommand("system-theme", {
        description: "Configure system theme sync (dark/light mapping, poll interval)",
        handler: async (_args, ctx) => {
            if (!canManageThemes(ctx)) {
                if (ctx.hasUI) ctx.ui.notify("Requires interactive mode with themes.", "info");
                return;
            }

            const draft: Config = { ...config };

            while (true) {
                const darkOpt = `Dark theme: ${draft.darkTheme}`;
                const lightOpt = `Light theme: ${draft.lightTheme}`;
                const pollOpt = `Poll interval (ms): ${draft.pollMs}`;
                const saveOpt = "Save and apply";
                const cancelOpt = "Cancel";

                const choice = await ctx.ui.select("pi-sync-system-theme", [
                    darkOpt,
                    lightOpt,
                    pollOpt,
                    saveOpt,
                    cancelOpt,
                ]);

                if (choice === undefined || choice === cancelOpt) return;

                if (choice === darkOpt) {
                    const next = await promptTheme(ctx, "Dark theme", draft.darkTheme);
                    if (next !== undefined) draft.darkTheme = next;
                    continue;
                }
                if (choice === lightOpt) {
                    const next = await promptTheme(ctx, "Light theme", draft.lightTheme);
                    if (next !== undefined) draft.lightTheme = next;
                    continue;
                }
                if (choice === pollOpt) {
                    const next = await promptPollMs(ctx, draft.pollMs);
                    if (next !== undefined) draft.pollMs = next;
                    continue;
                }
                if (choice === saveOpt) {
                    config = { ...config, darkTheme: draft.darkTheme, lightTheme: draft.lightTheme, pollMs: draft.pollMs };
                    try {
                        await saveConfig(config);
                        ctx.ui.notify("Settings saved.", "info");
                    } catch (e) {
                        ctx.ui.notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "error");
                        return;
                    }
                    await tick(ctx);
                    restartPolling(ctx);
                    maybeWarnCustomTheme(ctx);
                    return;
                }
            }
        },
    });

    // -- /system-theme-push command (write override file) ---------------------

    pi.registerCommand("system-theme-push", {
        description: "Write override appearance: /system-theme-push dark|light|auto",
        handler: async (args, ctx) => {
            const first = String(args[0] ?? "").trim().toLowerCase();
            const appearance = parseOverrideAppearance(first);
            if (!appearance) {
                if (ctx.hasUI) ctx.ui.notify("Usage: /system-theme-push dark|light|auto", "warning");
                return;
            }

            const payload: OverridePayload = {
                appearance,
                updatedAt: new Date().toISOString(),
                source: os.hostname(),
            };

            await mkdir(path.dirname(config.overrideFile), { recursive: true });
            await writeFile(config.overrideFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            if (ctx.hasUI) ctx.ui.notify(`Override written: ${appearance}`, "info");
            await tick(ctx);
        },
    });

    // -- Lifecycle ------------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
        config = await loadConfig();
        osc11State.lastCheckedAt = 0;
        osc11State.lastAppearance = null;
        osc11State.failures = 0;
        osc11State.disabledUntil = 0;

        if (!shouldAutoSync(ctx)) {
            maybeWarnCustomTheme(ctx);
            return;
        }

        await tick(ctx);
        restartPolling(ctx);
    });

    pi.on("session_shutdown", () => {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
    });
}
