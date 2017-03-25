#!/usr/bin/env node

let process = require('process');

let request = require('request-promise');
let Q = require('q');
let fs = require('fs');
let _ = require('lodash');
let dateformat = require('dateformat');
let desired_version = '3.7.49';
let desired_version_regex = /3\.7\.49\..*/;
let write = function () { process.stdout.write.apply(process.stdout, arguments) };

let Unifi = require('./unifi');

let config = require('./config.json');
let wlangroup_off;
let wait_for_connected;
let site = config.site;

let saved_keys = [ 'wlangroup_id_na', 'wlangroup_id_ng', 'wlan_overrides' ];
let saved_config = {};
let dev;
let saved_devs;
try {
    saved_devs = require(`./${config.site}-config.json`);
} catch (e) {}

let upgrade_models = {
    '^(U7PG2|U7LR)$': 'uap2',
    '^(U7P)$': 'uappro',
    '^(BZ2|BZ2LR|U2IW|U7O)$': 'uap',
    '^(U7E|U7Ev2)$': 'uapac',
};

try { fs.mkdirSync('logs'); } catch (e) {}

let unifi = new Unifi(config);

unifi.login()
.then(res => {
    return unifi.get({ url: `/api/s/${site}/rest/wlangroup` })
})
.then(res => {
    res = res.data;
    _.forEach(res, wlangroup => {
        if (wlangroup.name == 'Off')
            wlangroup_off = wlangroup._id;
    });

    if (!wlangroup_off)
        throw new Error('No Off wlangroup');

    return unifi.get({ url: `/api/s/${site}/stat/device` });
})
.then(res => {
    res = res.data;
    let devs = [];
    _.forEach(res, dev => {
        if (!dev.adopted || dev.state == 0 || dev.model.match(/US.*/) ||
            dev.version.match(desired_version_regex) ||
            _.indexOf(config.skip_devices, dev.ip) >= 0) return;
        devs.push(dev);
    });

    if (devs.length == 0)
        throw new Error('No more devices to upgrade!');

    devs.sort((a, b) => { return a.ip.localeCompare(b.ip); });
    devs.forEach(dev => { console.log(dev._id, dev.ip, dev.version, dev.model); });
    dev = devs[0];

    let dev_cfg = dev;
    if (saved_devs) {
        dev_cfg = _.find(saved_devs, { ip: dev.ip });
        if (dev_cfg) console.log(`Using saved config from ${site}-config.json`);
        else dev_cfg = dev;
    }

    saved_keys.forEach(key => {
        let value = dev_cfg[key];
        if (value)
            saved_config[key] = dev_cfg[key];
    });

    let ts = dateformat(new Date(), 'yymmddhhMM');
    fs.writeFileSync(`logs/${dev.ip}-${ts}.json`, JSON.stringify(saved_config));

    console.log('Off wlangroup:', wlangroup_off);
    console.log('Saved config:', saved_config);
    console.log('Will upgrade', dev.model, dev.ip);

    write('Disabling WiFi...');
    return unifi.put({
        url: `/api/s/${site}/rest/device/${dev._id}`,
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
        return unifi.get({ url: `/api/s/${site}/stat/device` })
        .then(res => {
            res = res.data;
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
        return unifi.post({
            url: `/api/s/${site}/cmd/devmgr/restart`,
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
    return unifi.post({
        url: `/api/s/${site}/cmd/devmgr`,
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
    console.log('\nUpgraded!\nRestoring config...');
    return unifi.put({
        url: `/api/s/${site}/rest/device/${dev._id}`,
        body: saved_config,
    });
})
.catch(err => {
    process.exitCode = 1;
    throw err;
});
