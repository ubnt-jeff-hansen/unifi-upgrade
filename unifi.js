let process = require('process');
let request = require('request-promise');
let _ = require('lodash');

class unifi {
    constructor(config) {
        this.config = config;
        this.request = request;
    }
    login() {
        if (!this.config.tls_check_cert)
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        let { username, password, base } = this.config;

        this.params = { jar: request.jar(), json: true };

        return this.post({
            url: `/api/login`,
            body: { username, password, remember: false, strict: true },
        })
        .then(res => {
            let csrf = this.params.jar.getCookieString(base).replace(/.*csrf_token=([0-9A-Za-z]+).*/, '$1');
            this.params.headers = { 'X-Csrf-Token': csrf };
        });
    }
    formUrl(params) { params.url = `${this.config.base}${params.url}`; }
    put(params) { this.formUrl(params); return request.put(_.extend(params, this.params)); };
    get(params) { this.formUrl(params); return request.get(_.extend(params, this.params)); };
    post(params) { this.formUrl(params); return request.post(_.extend(params, this.params)); };
};

module.exports = unifi;
