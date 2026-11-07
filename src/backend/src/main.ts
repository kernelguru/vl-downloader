import {NestFactory} from '@nestjs/core';
import {Logger} from '@nestjs/common';
import {AppModule} from './app.module';
import {resolve} from 'path';
import * as fs from 'fs';
import * as net from 'net';
import {spawn} from 'child_process';

const logger = new Logger('Bootstrap');

const isLocalHost = (host?: string) => !host || ['localhost', '127.0.0.1', '::1'].includes(host);

function canConnect(host: string, port: number): Promise<boolean> {
    return new Promise(done => {
        const socket = net.connect({host, port});
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); done(true); });
        socket.once('error', () => { socket.destroy(); done(false); });
        socket.once('timeout', () => { socket.destroy(); done(false); });
    });
}

/**
 * The Docker image ships its own redis-server so it runs as a single container.
 * It is only started if REDIS_HOST is local, nothing is listening yet and
 * EMBEDDED_REDIS is not "false" (set that when using an external Redis, e.g. via docker compose).
 */
async function ensureRedis(): Promise<void> {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;

    if (await canConnect(host, port)) {
        return;
    }
    if (!isLocalHost(host) || process.env.EMBEDDED_REDIS === 'false') {
        logger.warn(`Redis at ${host}:${port} is not reachable yet, the queue will retry the connection`);
        return;
    }

    logger.log(`Starting embedded redis-server on port ${port}`);
    const redis = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
        stdio: 'ignore',
    });
    redis.on('error', e => logger.error(`Unable to start redis-server: ${e.message}`));
    redis.on('exit', code => logger.warn(`redis-server exited with code ${code}`));
    const stop = () => redis.kill();
    process.once('exit', stop);

    for (let i = 0; i < 50; i++) {
        if (await canConnect('127.0.0.1', port)) {
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    logger.error('redis-server did not become ready within 10s');
}

async function bootstrap() {
    if (!process.env.DOWNLOADS_PATH) {
        throw new Error('DOWNLOADS_PATH environment variable is missing');
    }
    const folderName = resolve(__dirname, '..', process.env.DOWNLOADS_PATH);
    fs.mkdirSync(folderName, {recursive: true});

    await ensureRedis();

    const app = await NestFactory.create(AppModule);
    app.setGlobalPrefix('api');
    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
