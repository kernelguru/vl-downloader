import {Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {ChildProcess, spawn, spawnSync} from 'child_process';
import * as fs from 'fs';
import {join} from 'path';
import {UtilsService} from '../shared/services/utils.service';

export const NOVNC_PORT = Number(process.env.BROWSER_NOVNC_PORT) || 6080;
const VNC_PORT = Number(process.env.BROWSER_VNC_PORT) || 5900;
const DISPLAY = process.env.BROWSER_DISPLAY || ':99';
const NOVNC_WEB = process.env.NOVNC_PATH || '/opt/novnc';
const START_URL = process.env.BROWSER_START_URL || 'https://vimm.net/vault';

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
 * A real Firefox on a virtual display (Xvfb), shown in the web UI through x11vnc + websockify/noVNC.
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
        const missing = ['Xvfb', 'x11vnc', 'websockify', 'firefox'].filter(cmd => !this.hasCommand(cmd));
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
                name: 'Xvfb', command: 'Xvfb', restarts: 0, lastStart: 0,
                args: () => [DISPLAY, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac'],
            },
            {
                name: 'firefox', command: 'firefox', restarts: 0, lastStart: 0, env: {...displayEnv, MOZ_CRASHREPORTER_DISABLE: '1'},
                args: () => ['--no-remote', '--profile', this.profileDir, '--width', width, '--height', height, START_URL],
            },
            {
                name: 'x11vnc', command: 'x11vnc', restarts: 0, lastStart: 0, env: displayEnv,
                args: () => ['-display', DISPLAY, '-forever', '-shared', '-nopw', '-localhost', '-rfbport', String(VNC_PORT),
                    '-quiet', '-noxdamage', '-cursor', 'arrow'],
            },
            {
                name: 'websockify', command: 'websockify', restarts: 0, lastStart: 0,
                args: () => ['--web', NOVNC_WEB, `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`],
            },
        );

        this.start(this.processes[0]);
        await this.waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${DISPLAY.replace(':', '')}`), 10_000);
        this.processes.slice(1).forEach(p => this.start(p));
        this.logger.log(`Browser started (${this.resolution}), downloads go to ${inbox}`);
    }

    onModuleDestroy(): void {
        this.stopping = true;
        for (const p of [...this.processes].reverse()) {
            p.child?.kill('SIGTERM');
        }
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
