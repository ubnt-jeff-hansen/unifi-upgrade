#!/usr/bin/env node

let Unifi = require('./unifi');
let fs = require('fs');

let config = require('./config.json');
let unifi = new Unifi(config);
let { site } = config;

unifi.login()
.then(() => {
  return unifi.get({ url: `/api/s/${site}/stat/device` })
})
.then((res) => {
  let devices = res.data;
  fs.writeFileSync(`${site}-config.json`, JSON.stringify(devices));
  console.log('Saved.');
});
