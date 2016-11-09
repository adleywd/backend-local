var common = require('@screeps/common'),
    config = common.configManager.config,
    authlib = require('../authlib'),
    q = require('q'),
    path = require('path'),
    _ = require('lodash'),
    net = require('net'),
    http = require('http'),
    sockjs = require('sockjs'),
    express = require('express'),
    steamApi = require('steam-webapi'),
    auth = require('./api/auth'),
    jsonResponse = require('q-json-response'),
    bodyParser = require('body-parser'),
    cookieParser = require('cookie-parser'),
    zlib = require('zlib'),
    EventEmitter = require('events').EventEmitter,
    socketServer = require('./socket/server'),
    greenworks,
    storage = common.storage,
    db = storage.db,
    env = storage.env,
    pubsub = storage.pubsub;

steamApi.key = process.env.STEAM_KEY;

const PROTOCOL = 12;

var useNativeAuth;

Object.assign(config.backend, {
    router: express.Router(),
    onExpressPreConfig(app) {},
    onExpressPostConfig(app) {},
    onSendUserNotifications(user, notifications) {},
    onGetRoomHistory(roomName, baseTime, callback) {
        callback('not implemented');
    },
    customObjectTypes: {}
});

function getServerData() {
    return {
        customObjectTypes: config.backend.customObjectTypes
    }
}

config.backend.router.get('/version', jsonResponse(request => ({
    protocol: PROTOCOL,
    useNativeAuth,
    serverData: getServerData()
})));

/*config.backend.router.get('/custom-asset', (request, response) => {
    try {
        if (request.query.type == 'custom-object') {
            config.backend.onGetCustomObjectType(request.query.name, (err, result) => {
                if (err) {
                    throw new Error(err);
                }
                else {
                    response.write(result);
                }
            })
        }
        else {
            throw new Error('unknown type');
        }
    }
    catch(err) {
        response.status(500).write(err);
    }
});*/

config.backend.router.use('/auth', auth.router);
config.backend.router.use('/user', require('./api/user'));
config.backend.router.use('/register', require('./api/register'));
config.backend.router.use('/game', require('./api/game'));
config.backend.router.use('/leaderboard', require('./api/leaderboard'));

function connectToSteam(defer) {
    if(!defer) {
        defer = q.defer();
    }

    console.log(`Connecting to Steam Web API`);

    steamApi.ready(function (err) {
        if (err) {
            setTimeout(() => connectToSteam(defer), 1000);
            console.log('Steam Web API connection error', err);
        }

        defer.resolve();
    });
    return defer.promise;
}

function startServer() {

    if (!process.env.GAME_PORT) {
        throw new Error('GAME_PORT environment variable is not set!');
    }
    if (!process.env.GAME_HOST) {
        throw new Error('GAME_HOST environment variable is not set!');
    }
    if (!process.env.ASSET_DIR) {
        throw new Error('ASSET_DIR environment variable is not set!');
    }

    if (process.env.STEAM_KEY) {
        console.log("STEAM_KEY environment variable found, disabling native authentication");
        useNativeAuth = false;
    }
    else {
        console.log("STEAM_KEY environment variable is not found, trying to connect to local Steam client");
        try {
            greenworks = require('../../greenworks/greenworks');
        }
        catch(e) {
            throw new Error('Cannot find greenworks library, please either install it in the /greenworks folder or provide STEAM_KEY environment variable');
        }
        if (!greenworks.isSteamRunning()) {
            throw new Error('Steam client is not running');
        }
        if (!greenworks.initAPI()) {
            throw new Error('greenworks.initAPI() failure');
        }
        useNativeAuth = true;
    }

    return (useNativeAuth ? q.when() : connectToSteam()).then(() => {

        console.log(`Starting game server (protocol version ${PROTOCOL})`);

        var app = express();

        config.backend.onExpressPreConfig(app);

        app.use('/assets', express.static(process.env.ASSET_DIR));

        if (process.env.SERVER_PASSWORD) {
            app.use(function (request, response, next) {
                if (request.get('X-Server-Password') == process.env.SERVER_PASSWORD) {
                    next();
                    return;
                }
                response.json({error: 'incorrect server password'});
            })
        }

        app.use(bodyParser.urlencoded({limit: '8mb', extended: true}));
        app.use(bodyParser.json({
            limit: '8mb',
            verify(request, response, buf, encoding) {
                request.rawBody = buf.toString(encoding);
            }
        }));

        app.use(cookieParser());

        auth.setup(app, useNativeAuth);

        app.use('/api', config.backend.router);

        app.use('/room-history', function(request, response) {
            config.backend.onGetRoomHistory(request.query.room, request.query.time, (error, result) => {
                if(error) {
                    response.status(500).send(error);
                }
                else {
                    response.send(result);
                }
            });
        });

        config.backend.onExpressPostConfig(app);

        var server = http.createServer(app);

        socketServer(server, PROTOCOL);

        server.on('listening', () => {
            console.log(`Game server listening on ${process.env.GAME_HOST}:${process.env.GAME_PORT}`);
            if (process.env.SERVER_PASSWORD) {
                console.log(`Server password is ${process.env.SERVER_PASSWORD}`);
            }
        });
        server.listen(process.env.GAME_PORT, process.env.GAME_HOST);

    });
}

exports.startServer = startServer;