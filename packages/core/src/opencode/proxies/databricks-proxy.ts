import http from 'http';
import https from 'https';
import { URL } from 'url';

const DATABRICKS_PROXY_PORT = 9230;
const MAX_REQUEST_SIZE = 10 * 1024 * 1024;
const DEBUG = process.env.DEBUG_DATABRICKS_PROXY === '1';

let server: http.Server | null = null;
let targetBaseUrl: string | null = null;
let apiToken: string | null = null;

export interface DatabricksProxyInfo {
    baseURL: string;
    targetBaseURL: string;
    port: number;
}

function normalizeBaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error(`Invalid protocol: ${parsed.protocol}. Only http and https are supported.`);
        }
        return parsed.origin + parsed.pathname.replace(/\/$/, '');
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error(`Invalid URL format: ${url}`);
        }
        throw error;
    }
}

function getProxyBaseUrl(): string {
    return `http://127.0.0.1:${DATABRICKS_PROXY_PORT}`;
}

function shouldTransformBody(contentType: string | undefined): boolean {
    return !!contentType && contentType.toLowerCase().includes('application/json');
}

/**
 * Transforms request body to ensure assistant messages have non-empty content.
 * Databricks' Claude models require non-empty text content blocks.
 */
export function transformDatabricksRequestBody(body: Buffer): Buffer {
    const text = body.toString('utf8');
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        let modified = false;

        if (DEBUG) {
            console.log('[Databricks Proxy] Incoming request keys:', Object.keys(parsed));
            if (Array.isArray(parsed.messages)) {
                console.log('[Databricks Proxy] Message count:', parsed.messages.length);
            }
        }

        // Process messages array to fix empty content in assistant messages with tool_calls
        const processMessagesArray = (messages: unknown): void => {
            if (!Array.isArray(messages)) return;
            for (const message of messages) {
                if (!message || typeof message !== 'object') continue;
                const msg = message as Record<string, unknown>;
                const role = msg.role;
                const hasToolCalls = Boolean(msg.tool_calls);

                // If assistant message has tool_calls but empty/missing content, add placeholder
                if (typeof role === 'string' && role === 'assistant' && hasToolCalls) {
                    if (!msg.content || (typeof msg.content === 'string' && msg.content.trim() === '')) {
                        msg.content = 'I will use tools to help with this request.';
                        modified = true;
                        if (DEBUG) {
                            console.log('[Databricks Proxy] Added placeholder content to assistant message with tool_calls');
                        }
                    }
                }
            }
        };

        // Visit all nested objects looking for messages arrays
        const visitForMessages = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) {
                for (const item of value) visitForMessages(item);
                return;
            }
            const record = value as Record<string, unknown>;
            if ('messages' in record) {
                processMessagesArray(record.messages);
            }
            for (const key of Object.keys(record)) {
                visitForMessages(record[key]);
            }
        };

        visitForMessages(parsed);

        if (DEBUG) {
            console.log(`[Databricks Proxy] Transform modified: ${modified}`);
        }

        const result = Buffer.from(JSON.stringify(parsed), 'utf8');
        if (DEBUG && modified) {
            console.log(`[Databricks Proxy] Body transformed: ${body.length} -> ${result.length} bytes`);
        }
        return result;
    } catch (e) {
        console.error('[Databricks Proxy] Transform error:', e);
        return body;
    }
}

function isValidRequestPath(pathname: string): boolean {
    if (pathname === '/health') return true;
    if (pathname === '/chat/completions' || pathname.startsWith('/chat/')) return true;
    if (pathname === '/completions' || pathname.startsWith('/completions/')) return true;
    if (pathname === '/models' || pathname.startsWith('/models/')) return true;
    if (pathname.includes('/serving-endpoints')) return true;
    return false;
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', target: targetBaseUrl, port: DATABRICKS_PROXY_PORT }));
        return;
    }

    if (!targetBaseUrl) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Databricks proxy target not configured',
            hint: 'Configure Databricks in Settings > Providers'
        }));
        return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (!isValidRequestPath(url.pathname)) {
        console.warn(`[Databricks Proxy] Rejected invalid path: ${url.pathname}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request path. Only OpenAI-compatible API paths are allowed.' }));
        return;
    }

    const targetUrl = new URL(`${targetBaseUrl}${url.pathname}${url.search}`);
    const isHttps = targetUrl.protocol === 'https:';

    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;

    req.on('data', (chunk) => {
        if (aborted) return;
        totalSize += chunk.length;
        if (totalSize > MAX_REQUEST_SIZE) {
            aborted = true;
            console.warn(`[Databricks Proxy] Request exceeded size limit: ${totalSize} bytes`);
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request too large. Maximum size is 10MB.' }));
            req.destroy();
            return;
        }
        chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
        if (aborted) return;

        const rawBody = Buffer.concat(chunks);
        const contentType = req.headers['content-type'];

        if (DEBUG) {
            console.log(`[Databricks Proxy] Request: ${req.method} ${req.url}`);
            console.log(`[Databricks Proxy] Content-Type: ${contentType}, Body size: ${rawBody.length}`);
        }

        const body =
            rawBody.length > 0 && shouldTransformBody(contentType)
                ? transformDatabricksRequestBody(rawBody)
                : rawBody;

        if (DEBUG) {
            console.log(`[Databricks Proxy] Transformed body size: ${body.length} (was ${rawBody.length})`);
        }

        const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
        delete headers.host;
        headers['content-length'] = String(body.length);

        // Add Databricks authorization if we have a token
        if (apiToken) {
            headers['authorization'] = `Bearer ${apiToken}`;
        }

        const requestOptions: http.RequestOptions = {
            method: req.method,
            headers,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: `${targetUrl.pathname}${targetUrl.search}`,
        };

        const proxy = (isHttps ? https : http).request(requestOptions, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);

            proxyRes.on('data', (chunk: Buffer) => {
                res.write(chunk);
            });

            proxyRes.on('end', () => {
                res.end();
            });

            proxyRes.on('error', (err) => {
                console.error('[Databricks Proxy] Response stream error:', err);
                res.end();
            });
        });

        proxy.on('error', (error) => {
            console.error('[Databricks Proxy] Request error:', error);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({
                error: 'Databricks proxy request failed',
                details: error.message,
                hint: 'Check your Databricks API token and network connectivity'
            }));
        });

        if (body.length > 0) {
            proxy.write(body);
        }
        proxy.end();
    });

    req.on('error', (error) => {
        console.error('[Databricks Proxy] Incoming request error:', error);
        if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Invalid request', details: error.message }));
    });
}

export async function ensureDatabricksProxy(baseURL: string, token?: string): Promise<DatabricksProxyInfo> {
    targetBaseUrl = normalizeBaseUrl(baseURL);
    if (token) {
        apiToken = token;
    }

    if (!server) {
        server = http.createServer(proxyRequest);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Databricks proxy server startup timeout'));
            }, 5000);

            server!.once('error', (error: NodeJS.ErrnoException) => {
                clearTimeout(timeout);
                server = null;
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(
                        `Port ${DATABRICKS_PROXY_PORT} is already in use. ` +
                        'Please close other applications using this port or restart the app.'
                    ));
                } else {
                    reject(error);
                }
            });

            server!.listen(DATABRICKS_PROXY_PORT, '127.0.0.1', () => {
                clearTimeout(timeout);
                console.log(`[Databricks Proxy] Listening on port ${DATABRICKS_PROXY_PORT}`);
                resolve();
            });
        });
    }

    return {
        baseURL: getProxyBaseUrl(),
        targetBaseURL: targetBaseUrl,
        port: DATABRICKS_PROXY_PORT,
    };
}

export async function stopDatabricksProxy(): Promise<void> {
    if (!server) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            console.warn('[Databricks Proxy] Shutdown timeout, forcing close');
            server = null;
            targetBaseUrl = null;
            apiToken = null;
            resolve();
        }, 3000);

        server!.close((err) => {
            clearTimeout(timeout);
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
                console.error('[Databricks Proxy] Error during shutdown:', err);
                reject(err);
            } else {
                console.log('[Databricks Proxy] Server stopped');
                resolve();
            }
        });

        server = null;
        targetBaseUrl = null;
        apiToken = null;
    });
}

export function isDatabricksProxyRunning(): boolean {
    return server !== null && server.listening;
}
