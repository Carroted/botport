import {
    AttachmentBuilder,
    Client,
    Events,
    Message,
    Partials,
    TextChannel,
    GatewayIntentBits,
    User,
    MessageReaction,
    ChannelType,
    ThreadChannel
} from 'discord.js';
import { URL } from 'url';

const BOTPORT_VERSION = '1.2';

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

// ENCRYPTION

import { randomBytes, publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv, generateKeyPairSync, createPublicKey } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Generates a new RSA public/private key pair. */
export function generateKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
}

/** Encrypts data for a recipient using their public key (hybrid encryption). */
export function encryptHybrid(data: string, recipientPublicKey: string): string {
    // 1. Generate a one-time symmetric key and IV for AES
    const aesKey = randomBytes(KEY_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    // 2. Encrypt the data with AES-GCM
    const cipher = createCipheriv(ALGORITHM, aesKey, iv);
    const encryptedData = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 3. Encrypt the AES key with the recipient's public RSA key
    const encryptedAesKey = publicEncrypt(recipientPublicKey, aesKey);

    // 4. Combine into a single payload, base64 encoded for transport
    // Format: [iv].[authTag].[encryptedAesKey].[encryptedData]
    return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encryptedAesKey.toString('base64'),
        encryptedData.toString('base64')
    ].join('.');
}

/** Decrypts a hybrid encrypted payload using our private key. */
export function decryptHybrid(payload: string, privateKey: string): string {
    // 1. Deconstruct the payload from its base64 parts
    const [iv_b64, authTag_b64, encryptedAesKey_b64, encryptedData_b64] = payload.split('.');
    if (!iv_b64 || !authTag_b64 || !encryptedAesKey_b64 || !encryptedData_b64) {
        throw new Error("Invalid encrypted payload format.");
    }

    const iv = Buffer.from(iv_b64, 'base64');
    const authTag = Buffer.from(authTag_b64, 'base64');
    const encryptedAesKey = Buffer.from(encryptedAesKey_b64, 'base64');
    const encryptedData = Buffer.from(encryptedData_b64, 'base64');

    // 2. Decrypt the AES key with our private RSA key
    const aesKey = privateDecrypt(privateKey, encryptedAesKey);

    // 3. Decrypt the data with the AES key
    const decipher = createDecipheriv(ALGORITHM, aesKey, iv);
    decipher.setAuthTag(authTag);
    const decryptedData = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

    return decryptedData.toString('utf8');
}

/**
 * Derives the corresponding public key from a PEM-encoded private key.
 * 
 * @param privateKey The PEM-encoded string of the private key.
 * @returns The PEM-encoded string of the public key.
 */
export function getPublicKeyFromPrivate(privateKey: string): string {
    try {
        const publicKeyObject = createPublicKey(privateKey);

        // Export the derived public key back into the standard 'spki' PEM format.
        return publicKeyObject.export({ type: 'spki', format: 'pem' }) as string;

    } catch (error) {
        console.error("Failed to derive public key from private key. Is the private key valid PEM format?", error);
        throw new Error("Invalid private key provided.");
    }
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
    private recipientPublicKey: string | null;

    constructor(originalMessage: Message, recipientPublicKey: string | null = null) {
        this.originalMessage = originalMessage;
        this.recipientPublicKey = recipientPublicKey;
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
            let responseContent;

            if (this.recipientPublicKey) {
                // Encrypt the entire response payload (status + body) for the client.
                const payloadToEncrypt = JSON.stringify({ status: this.statusCode, body: data });
                const encryptedBlob = encryptHybrid(payloadToEncrypt, this.recipientPublicKey);
                responseContent = `secure-reply ${encryptedBlob}`;
            } else {
                // Fallback to unencrypted response for old clients or unencrypted requests.
                const jsonBody = JSON.stringify(data);
                responseContent = `${this.statusCode} ${jsonBody}`;
            }

            return await this.originalMessage.reply({
                content: responseContent,
                allowedMentions: {
                    parse: [],
                },
            });
        } catch (error) {
            console.error("Failed to send API response:", error);
            if (!this.sentFinal) {
                this.sentFinal = true;
                await this.originalMessage.reply(`500 {"error":"Failed to serialize response"}`);
            }
        }
    }
}

export interface BotAPIServerOptions {
    /** A short, one-line description of the bot's API purpose. Used for service discovery. */
    shortDescription: string;
    /** A longer, more detailed documentation string for the API. Sent when a user requests docs. */
    docs: string;
    /** Optional private key used to decrypt requests */
    privateKey?: string;
}

/**
 * An Express-like server for handling API requests over the Discord bot protocol.
 */
export class BotAPIServer {
    private client: Client;
    private options: BotAPIServerOptions;
    private routes: Route[] = [];
    private publicKey: string | null = null;

    /**
     * Creates a new BotAPIServer instance.
     * 
     * ---
     * 
     * `client` The discord.js Client instance.
     * 
     * `options` An object containing configuration for the server.
     */
    constructor(client: Client, options: BotAPIServerOptions) {
        this.client = client;
        this.options = options;

        if (this.options.privateKey) {
            try {
                this.publicKey = getPublicKeyFromPrivate(this.options.privateKey);
                console.log(`[BotAPIServer] Encryption enabled. Public key loaded.`);
            } catch (error) {
                console.error("[BotAPIServer] FATAL: Invalid privateKey in options. Server will not be able to handle encrypted requests.");
                throw new Error("Invalid privateKey in BotAPIServer options.");
            }
        }

        // Trim
        this.options.shortDescription = this.options.shortDescription.trim();
        this.options.docs = this.options.docs.trim();

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

        // Check for the discovery "ping" message.
        if (message.content === 'botport:find') {
            try {
                await message.react('🙋');
            } catch (error) {
                console.warn(`[BotAPIServer] Could not react to discovery message in #${(message.channel as TextChannel)?.name}. Missing 'Add Reactions' permission?`);
            }
            // Stop further processing for this message.
            return;
        }

        // Decentralized discovery election
        if (
            message.content === 'botport:discovery' &&
            message.channel.type === ChannelType.GuildText // Only run election in main text channels
        ) {
            if (message.system) return; // doesn't count

            const ELECTION_EMOJI = '🧵';
            const ELECTION_WAIT_MS = 1500;
            const myId = this.client.user!.id;

            try {
                // 1. Announce candidacy
                await message.react(ELECTION_EMOJI);
                const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
                await wait(ELECTION_WAIT_MS);

                // 2. Fetch results and find winner
                const freshMessage = await message.fetch(true);
                const reaction = freshMessage.reactions.cache.get(ELECTION_EMOJI);
                if (!reaction) return;

                const users = await reaction.users.fetch();
                const botCandidates = users.filter(u => u.bot);
                if (botCandidates.size === 0) return;

                const winnerId = Array.from(botCandidates.keys()).sort()[0];

                // 3. If I am the winner, perform the discovery and report back
                if (myId === winnerId) {
                    console.log(`[BotAPIServer] Won discovery election. Performing discovery...`);

                    // The winner calls the exported `discover` function to find *other* bots.
                    const otherBots = await discover(message.channel as TextChannel, this.client);

                    // Create a discovery object for the winner itself.
                    const selfInfo: DiscoveredBot = {
                        botportVersion: BOTPORT_VERSION,
                        shortDescription: this.options.shortDescription,
                        user: this.client.user!,
                    };

                    // Combine the list of other bots with itself.
                    const allBots = [selfInfo, ...otherBots];

                    // Using an array of strings to build the message line-by-line.
                    const replyLines = [
                        `## \`botport\` Discovery Results`,
                        `Found ${allBots.length} service(s) responding to the \`botport:discovery\` probe.`,
                        `` // Adds a blank line for spacing
                    ];

                    if (allBots.length > 0) {

                        allBots.forEach(bot => {
                            // Format each line as requested.
                            const botLine = `- **${bot.user.username}** "${bot.shortDescription}"\n  - \`botport\` v${bot.botportVersion}`;
                            replyLines.push(botLine);
                        });
                    } else {
                        // This case should theoretically never happen since the winner is always present.
                        replyLines.push("No `botport` services found.");
                    }

                    replyLines.push("\n### What is this?\nThis is a decentralized discovery system for \`botport\` bots, not reliant on this specific bot. As long as there's a \`botport\` bot in the server, this will work.\n\nEach bot reacts with :thread:, and the lowest ID bot 'wins' and creates a thread asking the bots to say their description and protocol version.");

                    // Join all the lines into a single message and send it as a reply.
                    await message.reply({
                        content: replyLines.join('\n'),
                        allowedMentions: {
                            parse: [],
                        },
                    });
                }

            } catch (error) {
                console.error("[BotAPIServer] Error during discovery election:", error);
            }
            return;
        }

        // Discovery response
        if (
            message.content === 'botport:discovery' &&
            message.channel.type === ChannelType.PublicThread &&
            message.channel.name === 'botport:discovery'
        ) {
            try {
                const payload = {
                    botportVersion: "1.2",
                    shortDescription: this.options.shortDescription,
                };
                await message.reply({
                    content: JSON.stringify(payload),
                    allowedMentions: {
                        parse: [],
                    },
                });
            } catch (error) {
                console.warn(`[BotAPIServer] Could not reply to discovery probe in thread.`);
            }
            return;
        }

        // Info election
        if (
            message.content === 'botport:info'
        ) {
            if (message.system) return; // doesn't count

            const ELECTION_EMOJI = '🙋';
            const ELECTION_WAIT_MS = 1500;
            const myId = this.client.user!.id;

            try {
                // 1. Announce candidacy
                await message.react(ELECTION_EMOJI);
                const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
                await wait(ELECTION_WAIT_MS);

                // 2. Fetch results and find winner
                const freshMessage = await message.fetch(true);
                const reaction = freshMessage.reactions.cache.get(ELECTION_EMOJI);
                if (!reaction) return;

                const users = await reaction.users.fetch();
                const botCandidates = users.filter(u => u.bot);
                if (botCandidates.size === 0) return;

                const winnerId = Array.from(botCandidates.keys()).sort()[0];

                if (myId === winnerId) {
                    // Join all the lines into a single message and send it as a reply.
                    await message.reply({
                        content: `## \`botport\`\n\`botport\` is a protocol and library for communication between bots.\n\nYou can get a list of all \`botport\` bots in the channel by typing \`botport:discovery\`.\n\n### What just happened?\nWe ran an election by each reacting with 🙋, and the bot reacting who has the lowest user ID (me) was selected to send this message. This prevents spam, instead of them all responding.\n\n### Using \`botport\`\nThe protocol supports both unencrypted messages by simply writing \`<@bot id>:api <method> <route> <optional body>\`, and then the response is sent as a reply.\n\nE2EE is also supported (with replay attack protection) by the library.\n\nYou can get the library from <https://github.com/Carroted/botport/>.`,
                        allowedMentions: {
                            parse: [],
                        },
                    });
                }

            } catch (error) {
                console.error("[BotAPIServer] Error during discovery election:", error);
            }
            return;
        }
/*
        // don't check message.mentions since we disable mentions
        if (!message.content.startsWith(`<@${this.client.user!.id}`) && !message.content.startsWith(`<@!${this.client.user!.id}`)) return;

        const mentionRegex = new RegExp(`^<@!?${this.client.user!.id}>:api\\s*(.*)$`);
        const match = message.content.match(mentionRegex);
        if (!match) return;

        const command = match[1].trim();*/

        const secureMatch = message.content.match(/^<@!?\d+>:api-secure\s*(.*)$/);
        const insecureMatch = message.content.match(/^<@!?\d+>:api\s*(.*)$/);
        const isEncrypted = !!secureMatch;
        const match = secureMatch || insecureMatch;

        // This check is now simpler and correctly placed
        if (!match || !message.content.startsWith(`<@${this.client.user!.id}`) && !message.content.startsWith(`<@!${this.client.user!.id}`)) {
            return;
        }

        let command = match[1].trim();

        if (!isEncrypted) {
            if (command === 'pubkey') {
                if (this.options.privateKey) {
                    const publicKey = getPublicKeyFromPrivate(this.options.privateKey);
                    // Reply with just the key string
                    return message.reply({
                        content: publicKey,
                        allowedMentions: {
                            parse: [], // public key could contain @here etc
                        },
                    });
                } else {
                    // Reply with null if not supported
                    return message.reply("null");
                }
            }

            if (!command || command === 'docs') {
                const attachment = new AttachmentBuilder(Buffer.from(this.options.docs), { name: 'api-docs.txt' });
                return message.reply({ files: [attachment] });
            }
            if (command === 'description') {
                // Simply reply with the short description string.
                return message.reply({
                    content: this.options.shortDescription,
                    allowedMentions: {
                        parse: [],
                    },
                });
            }
            if (command === 'version') {
                // Simply reply with the botport version string.
                return message.reply({
                    content: BOTPORT_VERSION,
                    allowedMentions: {
                        parse: [],
                    },
                });
            }

            if (command === 'routes') {
                const publicRoutes: APIRouteInfo[] = this.routes.map(r => ({
                    method: r.method,
                    path: r.path,
                    docs: r.docs,
                }));
                const responseJson = JSON.stringify(publicRoutes);
                await message.reply({
                    content: `200 ${responseJson}`,
                    allowedMentions: {
                        parse: [],
                    },
                });
                return;
            }
        }

        if (isEncrypted) {
            if (!this.options.privateKey) {
                return message.reply(`426 {"error":"Encryption is not supported by this server."}`);
            }
            try {
                const decryptedPayload = decryptHybrid(command, this.options.privateKey);
                const requestData = JSON.parse(decryptedPayload);
                // Call the unified processor
                await this.processRequest(requestData, message);
            } catch (error) {
                const keyForReply = this.publicKey!.replace(/\n/g, '\\n');
                return message.reply(`498 {"error":"Invalid Token - Decryption Failed.","publicKey":"${keyForReply}"}`);
            }
        } else {
            // Unencrypted path: parse the command and build the request data object
            const parts = command.split(/\s+/);
            const method = (parts.shift()?.toUpperCase() ?? '') as HttpMethod;
            const rawRoute = parts.shift() ?? '/';
            const bodyString = parts.join(' ');
            let body: any = null;
            if (bodyString) {
                try { body = JSON.parse(bodyString); }
                catch { return new BotAPIResponse(message).status(400).json({ error: 'Invalid JSON body' }); }
            }
            // Call the unified processor
            await this.processRequest({ method, route: decodeURIComponent(rawRoute), body, clientPublicKey: null }, message);
        }
    }

    private async processRequest(
        requestData: { method: HttpMethod, route: string, body: any, clientPublicKey: string | null, senderId?: string },
        originalMessage: Message
    ) {
        if (requestData.senderId && requestData.senderId !== originalMessage.author.id) {
            console.warn(`[BotAPIServer] Replay attack detected or senderId mismatch. Expected ${requestData.senderId}, got ${originalMessage.author.id}.`);
            // We can send a specific error code for this. 401 Unauthorized is fitting.
            return new BotAPIResponse(originalMessage, requestData.clientPublicKey).status(401).json({ error: "Sender ID mismatch." });
        }

        const { method, route: routeString, body, clientPublicKey } = requestData;

        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            return new BotAPIResponse(originalMessage, clientPublicKey).status(400).json({ error: `Invalid method '${method}'` });
        }

        const url = new URL(routeString, 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());

        for (const registeredRoute of this.routes) {
            if (registeredRoute.method !== method) continue;
            const routeMatch = url.pathname.match(registeredRoute.pathRegex);
            if (routeMatch) {
                const params = Object.fromEntries(registeredRoute.paramKeys.map((key, i) => [key, routeMatch[i + 1]]));

                // The `body` here is already correctly parsed from either the decrypted payload or the plaintext command.
                const req = new BotAPIRequest(originalMessage, originalMessage.author.id, method, url.pathname, params, query, body);

                // CRUCIAL: Pass the client's public key to the response object.
                const res = new BotAPIResponse(originalMessage, clientPublicKey);
                try {
                    await registeredRoute.handler(req, res);
                } catch (err) {
                    console.error(`[BotAPIServer] Error in handler for ${method} ${url.pathname}:`, err);
                    if (!res['sentFinal']) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
                return;
            }
        }
        new BotAPIResponse(originalMessage, clientPublicKey).status(404).json({ error: `Route not found: ${method} ${url.pathname}` });
    }
}

// API CLIENT

interface PendingRequest {
    resolve: (value: ClientResponse) => void;
    reject: (reason?: any) => void;
    onUpdate?: (update: ClientResponse) => void;
    timeoutId: NodeJS.Timeout;
}

export interface BotAPIClientOptions {
    /**
     * Channel used to send requests
     */
    transport: TextChannel;
    /** 
     * If true, the client will fail to initialize if the target bot does not provide a public key. 
     * This prevents accidental transmission of sensitive data in plaintext.
     * 
     * If false, the client will proceed with unencrypted requests if no key is available.
     */
    forceSecure: boolean;
    /** The default timeout for requests, in milliseconds. Defaults to 15000ms. */
    defaultTimeout?: number;
}

/**
 * A client for making API requests to other bots using the specified protocol. You construct one of these per bot you want to communicate with.
 */
export class BotAPIClient {
    private client: Client;
    private transport: TextChannel;
    private targetBotId: string;
    private options: BotAPIClientOptions;

    private targetPublicKey: string | null = null;
    private clientPublicKey: string | null = null;
    private clientPrivateKey: string | null = null;
    private initializationPromise: Promise<void>;

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
    constructor(client: Client, targetBotId: string, options: BotAPIClientOptions) {
        this.client = client;
        this.transport = options.transport;
        this.targetBotId = targetBotId;
        this.options = { defaultTimeout: 15000, ...options }; // Set default timeout
        
        const { publicKey, privateKey } = generateKeys();
        this.clientPublicKey = publicKey;
        this.clientPrivateKey = privateKey;

        this.client.on(Events.MessageCreate, this.handleReply.bind(this));

        // Start the initialization process immediately.
        this.initializationPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            // This is a simplified request, not using the full makeRequest stack.
            const pubKeyMessage = await this.transport.send(`<@${this.targetBotId}>:api pubkey`);
            const replies = await this.transport.awaitMessages({
                filter: m => m.reference?.messageId === pubKeyMessage.id && m.author.id === this.targetBotId,
                max: 1,
                time: this.options.defaultTimeout,
                errors: ['time'],
            });
            const key = replies.first()?.content;

            if (key && key !== 'null') {
                this.targetPublicKey = key;
                console.log(`[BotAPIClient] Secure connection established with ${this.targetBotId}. All requests will be encrypted.`);
            } else {
                // No public key available.
                if (this.options.forceSecure) {
                    throw new Error(`Initialization failed: forceSecure is true but bot ${this.targetBotId} does not provide a public key.`);
                }
                console.log(`[BotAPIClient] Bot ${this.targetBotId} does not support encryption. Proceeding with unencrypted requests.`);
            }
        } catch (error) {
            console.error(`[BotAPIClient] Could not initialize connection with ${this.targetBotId}:`, error);
            // Re-throw to make the initializationPromise reject.
            throw error;
        }
    }

    private resolvePendingRequest(status: number, body: any, pending: PendingRequest, reqId: string) {
        const response: ClientResponse = { status, body };
        clearTimeout(pending.timeoutId); // Clear timeout on any valid response (1xx or final)

        if (status >= 100 && status < 200) {
            pending.onUpdate?.(response);
        } else {
            pending.resolve(response);
            this.pendingRequests.delete(reqId);
        }
    }

    // REPLACE THE OLD handleReply WITH THIS
    private handleReply(message: Message) {
        if (message.author.id !== this.targetBotId || !message.reference?.messageId) return;
        const pending = this.pendingRequests.get(message.reference.messageId);
        if (!pending) return;

        const SECURE_REPLY_PREFIX = 'secure-reply ';
        if (message.content.startsWith(SECURE_REPLY_PREFIX)) {
            if (!this.clientPrivateKey) {
                pending.reject(new Error("Received an encrypted response but client has no private key."));
                return;
            }
            try {
                const encryptedBlob = message.content.substring(SECURE_REPLY_PREFIX.length);
                const decryptedPayload = decryptHybrid(encryptedBlob, this.clientPrivateKey);
                const responseData = JSON.parse(decryptedPayload); // Should be { status, body }
                this.resolvePendingRequest(responseData.status, responseData.body, pending, message.reference.messageId);
            } catch (error) {
                pending.reject(new Error("Failed to decrypt or parse secure response."));
                this.pendingRequests.delete(message.reference.messageId);
            }
            return;
        }

        // Standard Unencrypted Reply Handling
        const firstSpaceIndex = message.content.indexOf(' ');
        if (firstSpaceIndex === -1) return;
        const statusStr = message.content.substring(0, firstSpaceIndex);
        const bodyStr = message.content.substring(firstSpaceIndex + 1);
        const status = parseInt(statusStr, 10);
        if (isNaN(status)) return;
        try {
            const body = JSON.parse(bodyStr);
            this.resolvePendingRequest(status, body, pending, message.reference.messageId);
        } catch (error) {
            if (status >= 200) {
                pending.reject(new Error("Malformed response: Invalid JSON body."));
                this.pendingRequests.delete(message.reference.messageId);
            }
        }
    }

    private async makeRequest(method: HttpMethod, route: string, options: ClientRequestOptions = {}): Promise<ClientResponse> {
        await this.initializationPromise;

        const MAX_ATTEMPTS = 2; // Allow one initial attempt and one retry
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

            const { body, onUpdate, timeout = this.options.defaultTimeout } = options;
            let prefix = 'api';
            let payload: string;

            if (this.targetPublicKey) {
                prefix = 'api-secure';
                const unencryptedPayload = JSON.stringify({
                    method,
                    route,
                    body: body ?? null,
                    senderId: this.client.user!.id,
                    clientPublicKey: this.clientPublicKey
                });
                payload = encryptHybrid(unencryptedPayload, this.targetPublicKey);
            } else {
                // Unencrypted path...
                const encodedRoute = encodeURIComponent(route);
                let unencryptedRequest = `${method} ${encodedRoute}`;
                if (body) { unencryptedRequest += ` ${JSON.stringify(body)}`; }
                payload = unencryptedRequest;
            }

            const requestString = `<@${this.targetBotId}>:${prefix} ${payload}`;
            const requestMessage = await this.transport.send({
                content: requestString,
                allowedMentions: { parse: [] },
            });

            const response = await new Promise<ClientResponse>((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.pendingRequests.delete(requestMessage.id);
                    reject(new Error(`Request timed out after ${timeout}ms waiting for an initial response.`));
                }, timeout);
                this.pendingRequests.set(requestMessage.id, { resolve, reject, onUpdate, timeoutId });
            });

            if (response.status === 498 && response.body?.publicKey && attempt < MAX_ATTEMPTS) {
                console.warn(`[BotAPIClient] Received 498 status. Server public key may have changed. Updating key and retrying...`);
                // Update the stored public key with the one from the error response.
                // The .replace is needed because the server escapes newlines for JSON transport.
                this.targetPublicKey = response.body.publicKey.replace(/\\n/g, '\n');
                continue; // Go to the next iteration of the loop
            }

            // If the response is not a 498, or if we're out of attempts, return it.
            return response;
        }

        // This should only be reached if the loop somehow fails, which is unlikely.
        throw new Error("Failed to complete request after maximum attempts.");
    }

    /** Get the docs of the server. */
    public async docs(): Promise<string> {
        const requestMessage = await this.transport.send(`<@${this.targetBotId}>:api`);
        try {
            const replies = await this.transport.awaitMessages({
                filter: (m) => m.author.id === this.targetBotId && m.reference?.messageId === requestMessage.id,
                max: 1,
                time: this.options.defaultTimeout,
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
                time: this.options.defaultTimeout,
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

/**
 * Discovers all active botport servers in a given channel.
 * 
 * It works by sending a discovery message and collecting reactions from bots
 * for a short period.
 * 
 * ---
 * 
 * `channel` The transport channel to perform the discovery in.
 * 
 * `client` The client instance performing the search, to avoid finding itself.
 * 
 * (optional) `timeout` How long to wait for reactions, in milliseconds. Defaults to 3000ms.
 */
export async function find(channel: TextChannel, client: Client, timeout = 3000): Promise<User[]> {
    const DISCOVERY_EMOJI = '🙋';
    const PROBE_MESSAGE = 'botport:find';

    const probeMessage = await channel.send(PROBE_MESSAGE);

    try {
        const filter = (reaction: MessageReaction, user: User) => {
            return reaction.emoji.name === DISCOVERY_EMOJI && // Check for the right emoji
                user.bot === true &&  // Ensure the reactor is a bot
                user.id !== client.user?.id; // Ignore the bot doing the searching
        };

        const reactions = await probeMessage.awaitReactions({ filter, time: timeout });

        const discoveryReaction = reactions.get(DISCOVERY_EMOJI);
        if (!discoveryReaction) {
            return []; // No one responded
        }

        // Fetch all users who reacted to be sure we have the full User object
        const users = await discoveryReaction.users.fetch();

        // Filter the collected users again to be absolutely sure, and convert to an array
        return Array.from(users.values()).filter(user => user.bot && user.id !== client.user?.id);

    } catch (error) {
        console.error("[botport:find] Error during discovery:", error);
        return []; // Return empty array on error
    }
}

/**
 * Fetches the short description from a specific botport server.
 * 
 * ---
 * `channel` The transport channel to send the request in.
 * 
 * `botId` The ID of the bot to query.
 * 
 * (optional) `timeout` How long to wait for a reply. Defaults to 5000ms.
 */
export async function getDescription(channel: TextChannel, botId: string, timeout = 5000): Promise<string> {
    const requestMessage = await channel.send(`<@${botId}>:api description`);

    try {
        const filter = (m: Message) => {
            return m.reference?.messageId === requestMessage.id && m.author.id === botId;
        };

        const replies = await channel.awaitMessages({ filter, max: 1, time: timeout, errors: ['time'] });
        const reply = replies.first();

        if (!reply) {
            throw new Error("No reply received."); // Should be caught by 'time' error but good practice
        }

        return reply.content;

    } catch (error) {
        throw new Error(`Failed to get description from bot ${botId}: Request timed out or invalid response.`);
    }
}

export interface DiscoveredBot {
    botportVersion: string;
    shortDescription: string;
    user: User;
}

/**
 * Performs a botport service discovery in a given channel by creating a temporary thread.
 * This is the core discovery logic and does not involve an election.
 * 
 * ---
 * 
 * `channel` The channel where the discovery thread will be created.
 * 
 * `client` The client instance performing the discovery, to exclude itself from results.
 * 
 * `timeout` (Optional) How long to wait for replies in the thread. Defaults to 5000ms.
 */
export async function discover(channel: TextChannel, client: Client, timeout = 5000): Promise<DiscoveredBot[]> {
    const THREAD_NAME = 'botport:discovery';
    const PROBE_MESSAGE = 'botport:discovery';
    let discoveryThread: ThreadChannel | null = null;

    try {
        discoveryThread = await channel.threads.create({
            name: THREAD_NAME,
            autoArchiveDuration: 60,
            reason: 'Botport service discovery',
        });

        // Send the probe message that other bots will reply to.
        const probeMessage = await discoveryThread.send(PROBE_MESSAGE);

        // Collect replies to the probe.
        const filter = (m: Message) =>
            m.reference?.messageId === probeMessage.id &&
            m.author.bot &&
            m.author.id !== client.user?.id;

        const replies = await discoveryThread.awaitMessages({ filter, time: timeout });

        const foundBots: DiscoveredBot[] = [];
        for (const reply of replies.values()) {
            try {
                const data = JSON.parse(reply.content);
                if (data.botportVersion && data.shortDescription) {
                    foundBots.push({
                        shortDescription: data.shortDescription,
                        botportVersion: data.botportVersion,
                        user: reply.author,
                    });
                }
            } catch { /* Ignore malformed JSON */ }
        }

        return foundBots;

    } catch (error) {
        console.error("[botport:discover] An error occurred during discovery.", error);
        return []; // Return empty on error
    } finally {
        if (discoveryThread) {
            // Clean up the thread
            await discoveryThread.delete().catch(() => { });
        }
    }
}
