const { AppServiceRegistration, Cli, Bridge, Logging } = require("matrix-appservice-bridge");
const nconf = require("nconf");
const { Kafka, CompressionTypes, CompressionCodecs } = require("kafkajs");
const ZstdCodec = require('@kafkajs/zstd');
const promiseRetry = require("promise-retry");

CompressionCodecs[CompressionTypes.ZSTD] = ZstdCodec();

nconf.argv()
  .env({
      separator: '__',
      lowerCase: true,
      parseValues: true,
  });

nconf.defaults({
    "domain": "localhost",
    "prefix": "sms",
    "registration": "kafka-registration.yaml",
});

Logging.configure({
    console: "debug",
});

const log = Logging.get("main");

const get_mandatory = (name) => {
    const result = nconf.get(name);
    if (!result) {
        throw new Error(name + " not provided");
    }
    return result;
}

const domain = get_mandatory("domain");
const prefix = get_mandatory("prefix");
const homeserver = get_mandatory("homeserver");
const registration = get_mandatory("registration");
const send_to = get_mandatory("send_to");
const brokers = get_mandatory("brokers").split(",");
const consumer_group = get_mandatory("consumer_group");
const consumer_topic = get_mandatory("consumer_topic");

const localpart = prefix + "bot";

log.info("Running with config",
    {
        domain,
        prefix ,
        homeserver,
        registration,
        send_to,
        brokers,
        consumer_group,
        consumer_topic,
    }
);

const kafka = new Kafka({
    clientId: 'matrix-appservice-kafka',
    brokers,
});

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
    const room_db = bridge.getRoomStore();
    const entries = await room_db.select({});
    log.debug("Room entries: ", entries);
    const room_id = await (async () => {
        log.debug("Querying for room with alias", alias);
        const existing_room = await room_db.selectOne({ "data.alias": alias });
        if (existing_room) {
            log.debug("Room found in room store");
            return existing_room.id;
        } else {
            log.info("Room not found in room store");
            const maybe_existing = await intent
                .resolveRoom(alias)
                .catch((error) => {
                    log.debug("Room not found: ", error);
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

            return room_id;
        }
    })();
    await room_db.upsertEntry({ id: room_id, data: { alias, source }});
    log.debug("Room got", { alias, room_id, source });
    return room_id;
};

const ensure_target_in_room = async (bridge, room_id) => {
    const intent = await bridge.getIntent();
    const room_state = await intent.roomState(room_id);
    log.debug("Room state: ", room_state);

    const target_is_member = room_state.filter((element) => {
        return element.type === "m.room.member" && element.user_id === send_to;
    }).map((a) => a.content.membership).reduce((a, b) => b, 'leave') === 'join';

    if (!target_is_member) {
        log.info("Adding target to room", { room_id, send_to });
        await intent.invite(room_id, send_to);
    }
};

const send_message = async (bridge, room_id, contents) => {
    const intent = await bridge.getIntent();
    const message = {
        body: contents,
        msgtype: "m.text",
    };
    log.info("Sending message", message);
    intent.sendMessage(room_id, message);
};

const run = async (port, config) => {
    const consumer = kafka.consumer({ groupId: consumer_group });
    let bridge;
    bridge = new Bridge({
        homeserverUrl: homeserver,
        domain: domain,
        registration: registration,
        controller: {
            onUserQuery: function(queriedUser) {
                log.error("User queried ", queriedUser);
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

    await consumer.connect();
    await consumer.subscribe({ topic: consumer_topic });
    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            (async () => {
                const value = JSON.parse(message.value);
                log.info("Message received", { topic, partition, value });
                const { timestamp, from, body } = value;

                const source = from.replace("+", "");

                await promiseRetry(async (retry, number) => {
                    log.debug("Retry number ", number);
                    (async () => {
                        const room_id = await get_or_create_room(bridge, source);
                        await ensure_target_in_room(bridge, room_id);
                        await send_message(bridge, room_id, body);
                    })().catch((error) => {
                        log.error("Attempt failed:", error);
                        retry(error);
                    });
                });
            })().catch(log.error);
        }
    });
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
