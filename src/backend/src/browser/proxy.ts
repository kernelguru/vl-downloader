import * as http from 'http';
import * as net from 'net';
import type {Server} from 'http';
import type {Duplex} from 'stream';

export const BROWSER_PREFIX = '/browser';

/**
 * Forwards /browser/* (noVNC web client, HTTP) and /browser/websockify (WebSocket) to the local
 * websockify instance, so the browser is reachable through the app's own port.
 */
export function browserHttpProxy(targetPort: number) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
        // express strips the mount path: req.url is already relative to /browser
        const upstream = http.request({
            host: '127.0.0.1',
            port: targetPort,
            method: req.method,
            path: req.url || '/',
            headers: {...req.headers, host: `127.0.0.1:${targetPort}`},
        }, upstreamRes => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502, {'Content-Type': 'text/plain'});
            }
            res.end('Browser is not running');
        });
        req.pipe(upstream);
    };
}

export function attachBrowserWebSocketProxy(server: Server, targetPort: number): void {
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!req.url?.startsWith(`${BROWSER_PREFIX}/`)) {
            return; // socket.io handles its own upgrades
        }
        const path = req.url.slice(BROWSER_PREFIX.length) || '/';
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
            const headers: string[] = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i];
                const value = name.toLowerCase() === 'host' ? `127.0.0.1:${targetPort}` : req.rawHeaders[i + 1];
                headers.push(`${name}: ${value}`);
            }
            upstream.write(`${req.method} ${path} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
            if (head?.length) {
                upstream.write(head);
            }
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        const close = () => {
            upstream.destroy();
            socket.destroy();
        };
        upstream.on('error', close);
        socket.on('error', close);
        upstream.on('close', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
    });
}
