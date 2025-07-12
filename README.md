# `botport`

Bot API client/server library for Discord bots communicating using text channels as their transport

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

const server = new BotAPIServer(client, docs);

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
  }, // we can provide a docs string here
  `Get the balance of a user by their ID, like \`/balance/742396813826457750\``
);
```

### Client
```ts
    // (after your client is ready)

    const brookBotId = '1215488846830116864';
    const brook = new BotAPIClient(
        client,
        await client.channels.fetch('1224889075337531524') as TextChannel,
        brookBotId
    );

    const user = '742396813826457750';
    const response = await brook.get(`/balance/${user}`);
    console.log(response);
```

## License

MIT
