const { AppServiceRegistration, Cli, Bridge, Logging } = require("matrix-appservice-bridge");
const nconf = require("nconf");

nconf.argv()
  .env();

nconf.defaults({
    "domain": "localhost",
    "prefix": "sms",
    "registration": "kafka-registration.yaml",
});

Logging.configure({
    console: "debug",
});

const log = Logging.get("main");

const domain = nconf.get("domain");
const prefix = nconf.get("prefix");
const homeserver = nconf.get("homeserver");
const registration = nconf.get("registration");
const send_to = nconf.get("send-to");
const localpart = prefix + "bot";

if (!send_to) {
    throw new Error("No address to send to provided");
}

if (!homeserver) {
    throw new Error("No homeserver to send to provided");
}

log.info("Running with config",
    {
        domain: domain,
        prefix: prefix,
        homeserver: homeserver,
        registration: registration,
        send_to: send_to,
    }
);

const room_alias_local = (source) => {
    return prefix + "_" + source;
}

const room_alias = (source) => {
    return "#" + room_alias_local(source) + ":" + domain;
}

const room_name = (source) => {
    return "SMS with " + source;
}

const get_or_create_room = async (bridge, source) => {
    const intent = await bridge.getIntent();

    const alias = room_alias(source);
    log.debug("Querying for room with alias", alias);
    const room_db = bridge.getRoomStore();
    const existing_room = await room_db.selectOne({ alias });
    if (existing_room) {
        log.debug("Room found",
            {
                alias,
                existing_room,
            }
        );
        return existing_room.getId();
    } else {
        const maybe_existing = await intent
            .resolveRoom(alias)
            .catch((error) => {
                log.info("Room not found: ", error);
                return undefined;
            });
        const room_id = await (async () => {
            if (maybe_existing) {
                return maybe_existing;
            } else {
                const local_alias = room_alias_local(source);
                const name = room_name(source);
                const options = {
                    room_alias_name: local_alias,
                    name: name,
                };
                log.info("Creating room", options);
                const { room_id } = await intent.createRoom({ options });
                log.info("Created room", room_id);

                return room_id;
            }
        })();

        await room_db.insert({ id: room_id, data: { alias }});
        log.debug("Room got", { alias, room_id });
        return room_id;
    }
};

const send_text = async (bridge, contents, source) => {

};

const run = async (port, config) => {
    let bridge;
    bridge = new Bridge({
        homeserverUrl: homeserver,
        domain: domain,
        registration: registration,
        controller: {
            onUserQuery: function(queriedUser) {
                log.info("User queried ", queriedUser);
                return {};
            },
            onEvent: function(request, context) {
                log.info("Event: ", request, context);
                return;
            }
        }
    });
    log.info("Matrix-side running on port ", port);

    await bridge.loadDatabases();
    await bridge.run(port, config);

    const intent = bridge.getIntent("@smsbot:seanp.ca");
    intent.sendText("!hjGnvrpARXFsLdTJFk:seanp.ca", "hello");

    const id = await get_or_create_room(bridge, "10000000000");
    log.info("id: ", id);
};

new Cli({
    registrationPath: registration,
    generateRegistration: function(reg, callback) {
        reg.setId(AppServiceRegistration.generateToken());
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart(localpart);
        reg.addRegexPattern("aliases", "#" + prefix + "_.*", true);
        callback(reg);
    },
    run: function(port, config) {
        run(port, config).catch((e) => {
            log.error('Error:', e);
            process.exit(1);
        });
    }
}).run();
