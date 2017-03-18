#!/usr/bin/env node

// Allow self-signed cert
let process = require('process');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let request = require('request-promise');
let spawn = require('child_process').spawn;
let Q = require('q');
let fs = require('fs');
let _ = require('lodash');
let dateformat = require('dateformat');
let desired_version = '3.7.49';
let desired_version_regex = /3\.7\.49\..*/;
let write = function () { process.stdout.write.apply(process.stdout, arguments) };

//request.debug = true;

let config = require('./config.json');
let jar = request.jar();
let base = config.base;
let site = config.site;
let username = config.username;
let password = config.password;
let wlangroup_off;
let headers;
let wait_for_connected;

let saved_keys = [ 'wlangroup_id_na', 'wlangroup_id_ng', 'wlan_overrides' ];
let saved_config = {};
let dev;

let upgrade_models = {
    '^(U7PG2|U7LR)$': 'uap2',
    '^(U7P)$': 'uappro',
    '^(BZ2|BZ2LR|U2IW|U7O)$': 'uap',
    '^(U7E|U7Ev2)$': 'uapac',
};

try { fs.mkdirSync('logs'); } catch (e) {}

request.post({
    url: `${base}:8443/api/login`, jar, json: true,
    body: { username, password, remember: false, strict: true },
})
.then(res => {
    let csrf = jar.getCookieString(base).replace(/.*csrf_token=([0-9A-Za-z]+).*/, '$1');
    headers = { 'X-Csrf-Token': csrf };
    return request({ url: `${base}:8443/api/s/${site}/rest/wlangroup`, jar })
})
.then(res => {
    res = JSON.parse(res).data;
    _.forEach(res, wlangroup => {
        if (wlangroup.name == 'Off')
            wlangroup_off = wlangroup._id;
    });

    if (!wlangroup_off)
        throw new Error('No Off wlangroup');

    return request({ url: `${base}:8443/api/s/${site}/stat/device`, jar });
})
.then(res => {
    res = JSON.parse(res).data;
    let devs = [];
    _.forEach(res, dev => {
        if (!dev.adopted || dev.state == 0 || dev.model.match(/US.*/) ||
            dev.version.match(desired_version_regex)) return;
        devs.push(dev);
    });

    if (devs.length == 0)
        throw new Error('No more devices to upgrade!');

    devs.sort((a, b) => { return a.ip.localeCompare(b.ip); });
    devs.forEach(dev => { console.log(dev._id, dev.ip, dev.version, dev.model); });
    dev = devs[0]; // TODO: index 0
//throw new Error('bail!');
    saved_keys.forEach(key => {
        let value = dev[key];
        if (value)
            saved_config[key] = dev[key];
    });

    let ts = dateformat(new Date(), 'yymmddhhMM');
    fs.writeFileSync(`logs/${dev.ip}-${ts}.json`, JSON.stringify(saved_config));

    // console.log(dev);
    console.log('Off wlangroup:', wlangroup_off);
    console.log('saved:', saved_config);
    console.log('Will upgrade', dev.model, dev.ip);
    write('Disabling WiFi...');
    return request.put({
        url: `${base}:8443/api/s/${site}/rest/device/${dev._id}`, jar, headers, json: true,
        body: {
            wlan_overrides: [],
            wlangroup_id_na: wlangroup_off,
            wlangroup_id_ng: wlangroup_off,
        },
    });
})
.then(res => {
    console.log();
    return Q.delay(1000); // TODO: Make longer
})
.then(() => {
    wait_for_connected = () => {
        return request({ url: `${base}:8443/api/s/${site}/stat/device`, jar })
        .then(res => {
            res = JSON.parse(res).data;
            let updated_dev = _.find(res, { _id: dev._id });
            if (updated_dev.state != 1) {
                write('.');
                return Q.delay(5000).then(wait_for_connected);
            }
        });
    };
    return wait_for_connected();
})
.then(() => {
    write('Rebooting AP...');

    let reboot_ap = () => {
        return request.post({
            url: `${base}:8443/api/s/${site}/cmd/devmgr/restart`, jar, headers, json: true,
            body: { mac: dev.mac, reboot_type: 'hard' },
        })
        .catch(err => {
            if (err.statusCode == 500) {
                write('!');
                return Q.delay(20000).then(reboot_ap);
            } else throw err;
        });
    };
})
.then(() => {
    return wait_for_connected();
})
.then(res => {
    return Q.delay(1000);
})
.then(() => {
    console.log();
    let upgrade_model;
    _.forEach(upgrade_models, (model, models) => {
        if (dev.model.match(models))
            upgrade_model = model;
    });
    if (!upgrade_model)
        throw new Error(`Bad model: ${dev.model}`);

    write('Upgrading AP...');
    return request.post({
        url: `${base}:8443/api/s/${site}/cmd/devmgr`, jar, headers, json: true,
        body: {
            cmd: 'upgrade-external',
            mac: dev.mac,
            url: `http://dl.ubnt-ut.com/${upgrade_model}-${desired_version}.bin`,
        },
    })
    .catch(err => {
        if (err.statusCode != 500)
            throw err;

        write('\nUpgrade got error 500, but this is usually non-fatal...');
    });
})
.then(res => {
    return wait_for_connected();
})
.then(() => {
    console.log();
    console.log('Upgraded!');
    console.log('Restoring config...');
    return request.put({
        url: `${base}:8443/api/s/${site}/rest/device/${dev._id}`, jar, headers, json: true,
        body: saved_config,
    });
})
.catch(err => {
    process.exitCode(1);
    throw err;
});
