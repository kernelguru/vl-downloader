import {BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {ChildProcess, spawn, spawnSync} from 'child_process';
import * as fs from 'fs';
import {join} from 'path';
import {UtilsService} from '../shared/services/utils.service';

export const NOVNC_PORT = Number(process.env.BROWSER_NOVNC_PORT) || 6080;
const VNC_PORT = Number(process.env.BROWSER_VNC_PORT) || 5900;
const DISPLAY = process.env.BROWSER_DISPLAY || ':99';
const NOVNC_WEB = process.env.NOVNC_PATH || '/opt/novnc';
const START_URL = process.env.BROWSER_START_URL || 'https://vimm.net/vault';

/** Only Vimm's Lair pages can be opened from outside (share sheet / API). */
export const OPEN_URL_REGEXP = /^https:\/\/(www\.)?vimm\.net(\/[^\s]*)?$/i;

/** noVNC page in full-screen mode, resizing the remote screen to the device. */
export const NOVNC_CLIENT_URL = '/browser/vnc.html?autoconnect=true&reconnect=true&resize=remote&show_dot=true&path=browser/websockify';

export interface BrowserStatus {
    enabled: boolean;
    running: boolean;
    resolution: string;
    inbox: string;
    message?: string;
}

interface ManagedProcess {
    name: string;
    command: string;
    args: () => string[];
    env?: NodeJS.ProcessEnv;
    child?: ChildProcess;
    restarts: number;
    lastStart: number;
}

/**
 * A real Firefox on a virtual display (TigerVNC Xvnc), shown in the web UI through websockify/noVNC.
 * noVNC can resize the display to the viewer (resize=remote); the Firefox window is kept fitted to it.
 * The user browses Vimm's Lair themselves; downloads go to the inbox folder and are processed by InboxService.
 *
 * Env: BROWSER_ENABLED (default true), BROWSER_RESOLUTION (default 1280x900), BROWSER_START_URL
 */
@Injectable()
export class BrowserService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(BrowserService.name);
    readonly enabled = (process.env.BROWSER_ENABLED ?? 'true').toLowerCase() !== 'false';
    readonly resolution = /^\d{3,4}x\d{3,4}$/.test(process.env.BROWSER_RESOLUTION ?? '')
        ? process.env.BROWSER_RESOLUTION!
        : '1280x900';
    private readonly processes: ManagedProcess[] = [];
    private stopping = false;
    private message?: string;
    private fitTimer?: NodeJS.Timeout;
    private lastGeometry = '';
    /** URL Firefox is (re)started with when it is not running yet */
    private nextUrl = START_URL;

    constructor(private readonly utils: UtilsService) {}

    get profileDir(): string {
        return join(this.utils.getConfigFolderPath(), 'firefox');
    }

    status(): BrowserStatus {
        return {
            enabled: this.enabled,
            running: this.processes.length > 0 && this.processes.every(p => p.child && p.child.exitCode === null),
            resolution: this.resolution,
            inbox: this.utils.getInboxFolderPath(),
            message: this.message,
        };
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!this.enabled) {
            return;
        }
        const missing = ['Xvnc', 'websockify', 'firefox', 'xdotool'].filter(cmd => !this.hasCommand(cmd));
        if (missing.length || !fs.existsSync(join(NOVNC_WEB, 'vnc.html'))) {
            this.message = `Browser not available, missing: ${[...missing, ...(fs.existsSync(join(NOVNC_WEB, 'vnc.html')) ? [] : ['noVNC'])].join(', ')}`;
            this.logger.warn(this.message);
            return;
        }

        const inbox = this.utils.getInboxFolderPath();
        fs.mkdirSync(inbox, {recursive: true});
        this.writeFirefoxPrefs(inbox);
        this.removeStaleLocks();

        const [width, height] = this.resolution.split('x');
        const displayEnv = {...process.env, DISPLAY};

        this.processes.push(
            {
                // X server + VNC server in one; accepts screen size changes from noVNC (resize=remote)
                name: 'Xvnc', command: 'Xvnc', restarts: 0, lastStart: 0,
                args: () => [DISPLAY, '-geometry', `${width}x${height}`, '-depth', '24', '-rfbport', String(VNC_PORT),
                    '-localhost', '-SecurityTypes', 'None', '-AlwaysShared', '-AcceptSetDesktopSize', '-nolisten', 'tcp'],
            },
            {
                name: 'firefox', command: 'firefox', restarts: 0, lastStart: 0, env: {...displayEnv, MOZ_CRASHREPORTER_DISABLE: '1'},
                args: () => {
                    const [w, h] = (this.lastGeometry || `${width}x${height}`).split('x');
                    const url = this.nextUrl;
                    this.nextUrl = START_URL;
                    return ['--no-remote', '--profile', this.profileDir, '--width', w, '--height', h, url];
                },
            },
            {
                name: 'websockify', command: 'websockify', restarts: 0, lastStart: 0,
                args: () => ['--web', NOVNC_WEB, `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`],
            },
        );

        this.start(this.processes[0]);
        await this.waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${DISPLAY.replace(':', '')}`), 10_000);
        this.processes.slice(1).forEach(p => this.start(p));
        this.fitTimer = setInterval(() => this.fitWindow(), 1500);
        this.logger.log(`Browser started (${this.resolution}), downloads go to ${inbox}`);
    }

    onModuleDestroy(): void {
        this.stopping = true;
        clearInterval(this.fitTimer);
        for (const p of [...this.processes].reverse()) {
            p.child?.kill('SIGTERM');
        }
    }

    /**
     * Open a Vimm's Lair page in the running Firefox (address bar via xdotool, like a user typing it).
     * If Firefox is not running, it is started with that page.
     */
    async openUrl(url: string): Promise<BrowserStatus> {
        const trimmed = (url ?? '').trim();
        if (!OPEN_URL_REGEXP.test(trimmed)) {
            throw new BadRequestException('Only https://vimm.net/… pages can be opened');
        }
        if (!this.enabled || !this.processes.length) {
            throw new BadRequestException(this.message || 'Browser is not enabled');
        }
        const window = this.firefoxWindow();
        const ok = window && await this.xdotool([
            'windowactivate', '--sync', window,
            'key', '--clearmodifiers', 'ctrl+l',
            'sleep', '0.2',
            'type', '--delay', '1', trimmed,
        ]) && await this.xdotool(['key', '--clearmodifiers', 'Return']);
        if (!ok) {
            this.logger.warn('Could not type into Firefox, restarting it with the page');
            this.nextUrl = trimmed;
            this.restartFirefox();
        }
        this.logger.log(`Opened ${trimmed} in the browser`);
        return this.status();
    }

    /** Restart Firefox (e.g. after the user closed its window or it hangs). */
    restartFirefox(): BrowserStatus {
        const firefox = this.processes.find(p => p.name === 'firefox');
        if (firefox?.child && firefox.child.exitCode === null) {
            firefox.child.kill('SIGTERM'); // the exit handler starts it again
        } else if (firefox) {
            this.start(firefox);
        }
        return this.status();
    }

    private start(p: ManagedProcess): void {
        p.lastStart = Date.now();
        const child = spawn(p.command, p.args(), {env: p.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe']});
        p.child = child;
        let stderr = '';
        child.stderr?.on('data', d => (stderr = (stderr + d).slice(-2000)));
        child.on('error', e => this.logger.error(`${p.name}: ${e.message}`));
        child.on('exit', code => {
            if (this.stopping) {
                return;
            }
            this.logger.warn(`${p.name} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
            // quick crash loops back off, normal exits (window closed) restart right away
            const delay = Date.now() - p.lastStart < 10_000 ? Math.min(30_000, 1000 * 2 ** Math.min(p.restarts++, 5)) : 1000;
            if (Date.now() - p.lastStart >= 10_000) {
                p.restarts = 0;
            }
            if (p.name === 'firefox') {
                this.removeStaleLocks();
            }
            setTimeout(() => !this.stopping && this.start(p), delay);
        });
    }

    /** Keep the Firefox window as large as the (resizable) screen; there is no window manager. */
    private fitWindow(): void {
        const geometry = spawnSync('xdotool', ['getdisplaygeometry'], {env: {...process.env, DISPLAY}, encoding: 'utf8'});
        const size = geometry.status === 0 ? geometry.stdout.trim().replace(' ', 'x') : '';
        if (!/^\d+x\d+$/.test(size)) {
            return;
        }
        const window = this.firefoxWindow();
        if (!window || (size === this.lastGeometry && this.fittedWindow === window)) {
            return;
        }
        const [w, h] = size.split('x');
        const result = spawnSync('xdotool', ['windowmove', window, '0', '0', 'windowsize', window, w, h],
            {env: {...process.env, DISPLAY}, stdio: 'ignore'});
        if (result.status === 0) {
            this.lastGeometry = size;
            this.fittedWindow = window;
        }
    }

    private fittedWindow = '';

    /** X window id of the main Firefox window (largest visible one). */
    private firefoxWindow(): string | undefined {
        const search = spawnSync('xdotool', ['search', '--onlyvisible', '--class', 'firefox'],
            {env: {...process.env, DISPLAY}, encoding: 'utf8'});
        const ids = search.status === 0 ? search.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [];
        return ids[ids.length - 1];
    }

    private xdotool(args: string[]): Promise<boolean> {
        return new Promise(resolve => {
            const child = spawn('xdotool', args, {env: {...process.env, DISPLAY}, stdio: 'ignore'});
            const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.on('error', () => resolve(false));
            child.on('exit', code => {
                clearTimeout(timer);
                resolve(code === 0);
            });
        });
    }

    /** Download straight to the inbox without asking, keep the session (cookies) in the profile. */
    private writeFirefoxPrefs(inbox: string): void {
        fs.mkdirSync(this.profileDir, {recursive: true});
        const prefs: Record<string, string | number | boolean> = {
            'browser.download.folderList': 2,
            'browser.download.dir': inbox,
            'browser.download.useDownloadDir': true,
            'browser.download.always_ask_before_handling_new_types': false,
            'browser.download.start_downloads_in_tmp_dir': false,
            'browser.download.alwaysOpenPanel': true,
            'browser.helperApps.neverAsk.saveToDisk': 'application/zip,application/x-zip-compressed,application/x-7z-compressed,application/octet-stream,application/x-rar-compressed',
            'browser.startup.homepage': START_URL,
            'browser.shell.checkDefaultBrowser': false,
            'browser.aboutwelcome.enabled': false,
            'datareporting.policy.dataSubmissionEnabled': false,
            'toolkit.telemetry.reportingpolicy.firstRun': false,
            'browser.sessionstore.resume_from_crash': false,
            'app.update.auto': false,
            'browser.tabs.warnOnClose': false,
            'pdfjs.disabled': true,
        };
        const content = Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
            .join('\n');
        fs.writeFileSync(join(this.profileDir, 'user.js'), `// written by vl-downloader on every start\n${content}\n`);
    }

    private removeStaleLocks(): void {
        for (const file of ['lock', '.parentlock']) {
            try {
                fs.rmSync(join(this.profileDir, file), {force: true});
            } catch {
                // ignore
            }
        }
    }

    private hasCommand(command: string): boolean {
        return spawnSync('sh', ['-c', `command -v ${command}`], {stdio: 'ignore'}).status === 0;
    }

    private async waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
        const end = Date.now() + timeoutMs;
        while (!check() && Date.now() < end) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
}
