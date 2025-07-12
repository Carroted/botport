import {
    AttachmentBuilder,
    Client,
    Events,
    Message,
    Partials,
    TextChannel,
    GatewayIntentBits
} from 'discord.js';
import { URL } from 'url';

// TYPES

export interface APIRouteInfo {
    method: HttpMethod;
    path: string;
    docs?: string;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Handler = (req: BotAPIRequest, res: BotAPIResponse) => void | Promise<void>;

interface Route {
    method: HttpMethod;
    path: string;
    pathRegex: RegExp;
    paramKeys: string[];
    handler: Handler;
    docs?: string;
}

export interface ClientResponse {
    status: number;
    body: any;
}

/** Options for making a client request */
export interface ClientRequestOptions {
    /** The JSON body for POST, PUT, or PATCH requests. */
    body?: any;
    /** A callback function that triggers on intermediate (1xx) responses. */
    onUpdate?: (update: ClientResponse) => void;
    /** A specific timeout for this request in milliseconds. */
    timeout?: number;
}

// API SERVER

class BotAPIRequest {
    public readonly message: Message
    public readonly authorId: string; 
    public readonly method: HttpMethod;
    public readonly path: string;
    public readonly params: Record<string, string>;
    public readonly query: Record<string, string>;
    public readonly body: any;

    constructor(
        message: Message,
        authorId: string,
        method: HttpMethod,
        path: string,
        params: Record<string, string>,
        query: Record<string, string>,
        body: any
    ) {
        this.message = message;
        this.authorId = authorId;
        this.method = method;
        this.path = path;
        this.params = params;
        this.query = query;
        this.body = body;
    }
}

class BotAPIResponse {
    private originalMessage: Message;
    private statusCode = 200;
    private sentFinal = false;

    constructor(originalMessage: Message) {
        this.originalMessage = originalMessage;
    }

    public status(code: number): this {
        this.statusCode = code;
        return this;
    }

    /**
     * Sends a JSON response. If the status code is < 200, it's considered an
     * intermediate update and more responses can be sent. Otherwise, it's final.
     * @param data The JSON data to send.
     */
    public async json(data: any): Promise<Message | void> {
        if (this.sentFinal) {
            console.warn("Warning: A final response has already been sent for this request.");
            return;
        }
        if (this.statusCode >= 200) {
            this.sentFinal = true;
        }

        try {
            const jsonBody = JSON.stringify(data);
            const responseContent = `${this.statusCode} ${jsonBody}`;
            return await this.originalMessage.reply(responseContent);
        } catch (error) {
            console.error("Failed to send API response:", error);
            if (!this.sentFinal) {
                this.sentFinal = true;
                await this.originalMessage.reply(`500 {"error":"Failed to serialize response"}`);
            }
        }
    }
}

/**
 * An Express-like server for handling API requests over the Discord bot protocol.
 */
export class BotAPIServer {
    private client: Client;
    private docsString: string;
    private routes: Route[] = [];

    /**
     * Creates a new BotAPIServer instance.
     * 
     * ---
     * 
     * `client` The discord.js Client instance.
     * 
     * `docsString` A string containing the API documentation, which will be sent as a file in response to `<@your bot id>:api`.
     */
    constructor(client: Client, docsString: string) {
        this.client = client;
        this.docsString = docsString.trim();

        this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
        if (client.user) {
            console.log(`[BotAPIServer] Listening on <@${client.user.id}>:api`);
        } else {
            this.client.on(Events.ClientReady, (client) => {
                console.log(`[BotAPIServer] Listening on <@${client.user.id}>:api`);
            });
        }
    }

    private register(method: HttpMethod, path: string, handler: Handler, docs?: string) {
        const paramKeys: string[] = [];
        const pathRegex = new RegExp(
            `^${path.replace(/:(\w+)/g, (_, key) => {
                paramKeys.push(key);
                return '([^/]+)';
            })}/?$`
        );
        // Add `path` and `docs` to the pushed object
        this.routes.push({ method, path, pathRegex, paramKeys, handler, docs });
    }

    /** Register a new route that'll respond to `GET` requests of a specified path.
     * 
     * ---
     * #### Example
     * 
     * ```ts
     * // Listen to GET requests of `/balance/<user id>`
     * server.get('/balance/:userId', (req, res) => {
     *     const user = req.params.userId;
     *     console.log('requesting balance for user', user);
     *
     *     // Here you would do your actual checks of user balance
     *     res.status(200).json({
     *         amount: 50000000,
     *     });
     * });
     * ```
     */
    public get(path: string, handler: Handler, docs?: string) { this.register('GET', path, handler, docs); }

    /** Register a new route that'll respond to `POST` requests of a specified path.
     * 
     * You may want to use `req.body` in your handler, that's JSON the requester sent, if any.
     * 
     * ---
     * #### Example
     * 
     * ```ts
     * // Listen to POST requests of `/pay/<user id>`
     * server.post('/pay/:userId', (req, res) => {
     *     const user = req.params.userId;
     *     const amount = req.query.amount;
     * 
     *     if (!amount) {
     *         res.status(400).json({
     *             error: 'You need an amount!!! What are you even doing',
     *         });
     *         return;
     *     }
     *     console.log('requesting to pay user', user, amount, 'dollars');
     *
     *     // Here you would do your actual payment first or we can just say omg it worked
     *     res.status(200).json({
     *         message: 'omg it worked (maybe)'
     *     });
     * });
     * ```
     */
    public post(path: string, handler: Handler, docs?: string) { this.register('POST', path, handler, docs); }

    /** This is just the same as the other ones, figure it out. */
    public put(path: string, handler: Handler, docs?: string) { this.register('PUT', path, handler, docs); }
    /** This is just the same as the other ones, figure it out. */
    public patch(path: string, handler: Handler, docs?: string) { this.register('PATCH', path, handler, docs); }
    /** This is just the same as the other ones, figure it out. */
    public delete(path: string, handler: Handler, docs?: string) { this.register('DELETE', path, handler, docs); }

    private async handleMessage(message: Message) {
        if (message.author.id === this.client.user!.id) return;
        if (!message.mentions.users.has(this.client.user!.id)) return;

        const mentionRegex = new RegExp(`^<@!?${this.client.user!.id}>:api\\s*(.*)$`);
        const match = message.content.match(mentionRegex);
        if (!match) return;

        const command = match[1].trim();

        if (!command || command === 'docs') {
            const attachment = new AttachmentBuilder(Buffer.from(this.docsString), { name: 'api-docs.txt' });
            return message.reply({ files: [attachment] });
        }

        if (command === 'routes') {
            const publicRoutes: APIRouteInfo[] = this.routes.map(r => ({
                method: r.method,
                path: r.path,
                docs: r.docs,
            }));
            const responseJson = JSON.stringify(publicRoutes);
            await message.reply(`200 ${responseJson}`);
            return;
        }

        const parts = command.split(/\s+/);
        const method = (parts.shift()?.toUpperCase() ?? '') as HttpMethod;
        const rawRoute = parts.shift() ?? '/';
        const bodyString = parts.join(' ');

        const route = decodeURIComponent(rawRoute);
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            return new BotAPIResponse(message).status(400).json({ error: `Invalid method '${method}'` });
        }

        const url = new URL(route, 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());

        for (const registeredRoute of this.routes) {
            if (registeredRoute.method !== method) continue;
            const routeMatch = url.pathname.match(registeredRoute.pathRegex);
            if (routeMatch) {
                const params = Object.fromEntries(registeredRoute.paramKeys.map((key, i) => [key, routeMatch[i + 1]]));
                let body: any = null;
                if (bodyString) {
                    try {
                        body = JSON.parse(bodyString);
                    } catch (error) {
                        return new BotAPIResponse(message).status(400).json({ error: 'Invalid JSON body' });
                    }
                }
                const req = new BotAPIRequest(message, message.author.id, method, url.pathname, params, query, body);
                const res = new BotAPIResponse(message);
                try {
                    await registeredRoute.handler(req, res);
                } catch (err) {
                    console.error(`[BotAPIServer] Error in handler for ${method} ${route}:`, err);
                    if (!res['sentFinal']) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
                return;
            }
        }
        new BotAPIResponse(message).status(404).json({ error: `Route not found: ${method} ${url.pathname}` });
    }
}

// API CLIENT

interface PendingRequest {
    resolve: (value: ClientResponse) => void;
    reject: (reason?: any) => void;
    onUpdate?: (update: ClientResponse) => void;
    timeoutId: NodeJS.Timeout;
}

/**
 * A client for making API requests to other bots using the specified protocol. You construct one of these per bot you want to communicate with.
 */
export class BotAPIClient {
    private client: Client;
    private transport: TextChannel;
    private targetBotId: string;
    private defaultTimeout: number;
    private pendingRequests = new Map<string, PendingRequest>();

    /** Creates a new BotAPIClient instance. You construct one of these per bot you want to communicate with.
     * 
     * ---
     * 
     * `client` The discord.js Client instance that will be making the requests.
     * 
     * `transport` The text channel where the bot will send requests.
     * 
     * `targetBotId` The bot that will receive the requests.
     * 
     * (optional) `defaultTimeout` The default timeout for requests, in milliseconds. If you don't specify this, it'll be `15000`ms.
    */
    constructor(client: Client, transport: TextChannel, targetBotId: string, defaultTimeout = 15000) {
        this.client = client;
        this.transport = transport;
        this.targetBotId = targetBotId;
        this.defaultTimeout = defaultTimeout;
        this.client.on(Events.MessageCreate, this.handleReply.bind(this));
    }

    private handleReply(message: Message) {
        if (message.author.id !== this.targetBotId || !message.reference?.messageId) return;

        // Use the original request message ID for the lookup
        const pending = this.pendingRequests.get(message.reference.messageId);
        if (!pending) return;

        const content = message.content;
        const firstSpaceIndex = content.indexOf(' ');
        if (firstSpaceIndex === -1) return;

        const statusStr = content.substring(0, firstSpaceIndex);
        const bodyStr = content.substring(firstSpaceIndex + 1);
        const status = parseInt(statusStr, 10);
        if (isNaN(status)) return;

        try {
            const body = JSON.parse(bodyStr);
            const response: ClientResponse = { status, body };

            if (status >= 100 && status < 200) {
                // It's an update. The "keep-alive" signal.
                // Clear the timeout! The request will now wait indefinitely for a final response.
                clearTimeout(pending.timeoutId);
                pending.onUpdate?.(response);
            } else {
                // It's a final response.
                // We still clear the timeout just in case, then resolve.
                clearTimeout(pending.timeoutId);
                pending.resolve(response);
                this.pendingRequests.delete(message.reference.messageId);
            }
        } catch (error) {
            if (status >= 200) {
                clearTimeout(pending.timeoutId);
                pending.reject(new Error("Malformed response: Invalid JSON body."));
                this.pendingRequests.delete(message.reference.messageId);
            }
        }
    }


    private async makeRequest(method: HttpMethod, route: string, options: ClientRequestOptions = {}): Promise<ClientResponse> {
        const { body, onUpdate, timeout = this.defaultTimeout } = options;
        const encodedRoute = encodeURIComponent(route);
        let requestString = `<@${this.targetBotId}>:api ${method} ${encodedRoute}`;
        if (body) {
            requestString += ` ${JSON.stringify(body)}`;
        }

        const requestMessage = await this.transport.send(requestString);

        return new Promise((resolve, reject) => {
            // Create the timeout timer
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(requestMessage.id);
                reject(new Error(`Request timed out after ${timeout}ms waiting for an initial response.`));
            }, timeout);

            this.pendingRequests.set(requestMessage.id, {
                resolve: (response) => {
                    resolve(response);
                },
                reject: (reason) => {
                    reject(reason);
                },
                onUpdate,
                timeoutId,
            });
        });
    }

    /** Get the docs of the server. */
    public async docs(): Promise<string> {
        const requestMessage = await this.transport.send(`<@${this.targetBotId}>:api`);
        try {
            const replies = await this.transport.awaitMessages({
                filter: (m) => m.author.id === this.targetBotId && m.reference?.messageId === requestMessage.id,
                max: 1,
                time: this.defaultTimeout,
                errors: ['time'],
            });
            const attachment = replies.first()?.attachments.first();
            if (attachment) {
                return await (await fetch(attachment.url)).text();
            }
            throw new Error("No attachment found in docs response.");
        } catch (e) {
            throw new Error(`Failed to fetch docs: Request timed out or invalid response.`);
        }
    }

    /** Make a `GET` request.
     * 
     * ```ts
     * const response = await apiClient.get(`/balance/${userId}`);
     * ```
     */
    public get(route: string, options?: Omit<ClientRequestOptions, 'body'>) { return this.makeRequest('GET', route, options); }
    public post(route: string, options?: ClientRequestOptions) { return this.makeRequest('POST', route, options); }
    public put(route: string, options?: ClientRequestOptions) { return this.makeRequest('PUT', route, options); }
    public patch(route: string, options?: ClientRequestOptions) { return this.makeRequest('PATCH', route, options); }
    public delete(route: string, options?: ClientRequestOptions) { return this.makeRequest('DELETE', route, options); }

    /** Get a list of routes of the server */
    public async routes(): Promise<APIRouteInfo[]> {
        const requestMessage = await this.transport.send(`<@${this.targetBotId}>:api routes`);

        try {
            const replies = await this.transport.awaitMessages({
                filter: (m) => m.author.id === this.targetBotId && m.reference?.messageId === requestMessage.id,
                max: 1,
                time: this.defaultTimeout,
                errors: ['time'],
            });

            const reply = replies.first();
            if (!reply) {
                throw new Error("No response received for routes request.");
            }

            const content = reply.content;
            const firstSpaceIndex = content.indexOf(' ');

            if (firstSpaceIndex === -1) {
                throw new Error("Malformed routes response: No space separator.");
            }

            const jsonStr = content.substring(firstSpaceIndex + 1);
            try {
                // We assume the server follows the protocol and sends valid APIRouteInfo[]
                return JSON.parse(jsonStr) as APIRouteInfo[];
            } catch (e) {
                throw new Error("Malformed routes response: Invalid JSON.");
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Malformed')) {
                throw e; // re-throw our specific errors
            }
            throw new Error(`Failed to fetch routes: Request timed out or received no reply.`);
        }
    }
}
