const { AppServiceRegistration, Cli, Bridge } = require("matrix-appservice-bridge");
const nconf = require("nconf");

nconf.argv()
  .env();

nconf.defaults({
    "domain": "sms",
    "prefix": "sms",
});

const domain = nconf.get("domain");
const prefix = nconf.get("prefix");

new Cli({
    registrationPath: "kafka-registration.yaml",
    generateRegistration: function(reg, callback) {
        reg.setId(AppServiceRegistration.generateToken());
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart(domain);
        reg.addRegexPattern("users", "@" + prefix + "_.", true);
        callback(reg);
    },
    run: function(port, config) {
        // not yet implemented
    }
}).run();
