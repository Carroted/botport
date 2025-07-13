# `botport`

Bot API client/server library for Discord bots communicating using text channels as their transport

## Features
- `express`-like server API
- Decentralized discovery system without spam
  - To discover bots with their description and protocol version:
    - `botport.ts` exports a `discover` function
      - A thread is created called `botport:discovery`, and bots will only respond to discovery requests in threads named that
      - When a user wants to discover `botport` API servers, they can type `botport:discovery` and the bots will react to enter an election, then the lowest ID bot is selected and will do the discovery for them
  - To simply get a list of bots without that info:
    - `botport.ts` exports a `find` function
      - The protocol supports find by allowing a user or bot to send `botport:find` and wait for 🙋 reacts
- Optional E2EE, with replay attack protection
- Built-in documentation system for routes and servers

## Installation

Copy `botport.ts` into your project

## Usage

### Server
```ts
import { BotAPIServer } from './botport';

const docs = `
# Amazing Bot Docs

This is such a cool docs. Unlimited length since it sends as a file.
`;

const server = new BotAPIServer(client, {
    docs,
    shortDescription: 'This is my bot where stuff happens',

    // You can also specify a `privateKey` here!
    // `botport.ts` includes a `generateKeys` function that returns a public and private key.
    // For E2EE, put the private key in a file also included in your `.gitignore`, and read it from that
    // E2EE is optional in botport though
});

// Listen to GET requests of `/balance/<user id>`
// `req` is the request, we use `res` to respond  
server.get('/balance/:userId', (req, res) => {

    // get userId parameter
    const user = req.params.userId;
    console.log('requesting balance for user', user);

    // set status code and respond with a json
    res.status(200).json({
        amount: 50000000,
    });

},`Get the balance of a user by their ID, like \`/balance/742396813826457750\``);
```

### Client
```ts
    // (after your client is ready)

    const brookBotId = '1215488846830116864';
    const brook = new BotAPIClient(client, brookBotId, {
        transport: await client.channels.fetch('1322717023351865395') as TextChannel,

        // we have to specify `forceSecure`.
        // if we pick `true`, it'll error if it can't get the server pubkey.
        // useful to prevent leaking data.
        // if it's false it'll just send unsecurely if that happens
        forceSecure: false,
    });

    const user = '742396813826457750';
    const response = await brook.get(`/balance/${user}`);
    console.log(response);
```

### Discovery
```ts
    const transportChannel = await client.channels.fetch('1322717023351865395') as TextChannel;
    const bots = await discover(transportChannel, client);
```

## License

MIT
