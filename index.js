var soap = require('soap');
var cookie = require('soap-cookie');
var constants = require('constants');

var DEFAULT_RECONNECT_LIMIT = 10;
var DEFAULT_TIMEOUT = 2 * 60 * 1000;

function Client(options = {}) {
    this.status = 'disconnected';
    this.reconnectCount = 0;
    this.reconnectLimit = Number.isFinite(options.reconnectLimit) ? options.reconnectLimit : DEFAULT_RECONNECT_LIMIT;
    this.timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT;

    let sslVerify = typeof options.sslVerify !== 'undefined' ? options.sslVerify : false;

    if (sslVerify) {
        this.clientOpts = {};
    } else {
        this.clientOpts = {
            rejectUnauthorized: false,
            strictSSL: false,
            secureOptions: constants.SSL_OP_NO_TLSv1_2
        }; // recommendation by noap-soap
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // need for self-signed certs

    this.connectionInfo = {
        host: options.host,
        user: options.username,
        password: options.password,
        sslVerify: sslVerify
    };

    this.loginArgs = {
        userName: this.connectionInfo.user,
        password: this.connectionInfo.password
    };

    this.uri = `https://${this.connectionInfo.host}/sdk/vimService.wsdl`;
}

Client.prototype.connect = function () {
    if (this.status !== 'disconnected') {
        return Promise.resolve();
    }

    this.status = 'connecting';

    return new Promise((resolve, reject) => {
        soap.createClient(this.uri, this.clientOpts, (err, client) => {
            if (err) {
                return reject(err);
            }

            this.client = client;
            this.client.setEndpoint(`https://${this.connectionInfo.host}/sdk/vimService.wsdl`);
            return resolve(client);
        });
    })
    .then(() => {
        return this.runCommand('RetrieveServiceContent', {
            _this: 'ServiceInstance'
        });
    })
    .then(result => {
        if (!result) {
            this.status = 'disconnected';
            return Promise.reject();
        }

        this.serviceContent = result.returnval;
        this.sessionManager = this.serviceContent.sessionManager;

        let loginArgs = Object.assign({
            _this: this.sessionManager
        }, this.loginArgs);

        return this.runCommand('Login', loginArgs);
    })
    .then(result => {
        this.authCookie = new cookie(this.client.lastResponseHeaders);
        this.client.setSecurity(this.authCookie);

        this.userName = result.returnval.userName;
        this.fullName = result.returnval.fullName;
        this.session = result.returnval;
        this.reconnectCount = 0;

        this.status = 'ready';

        return this.session;
    })
    .catch(err => {
        this.status = 'disconnected';
        return Promise.reject(err);
    });
};

Client.prototype.close = function () {
    if (this.status === 'ready') {
        return this.runCommand('Logout', {
            _this: this.sessionManager
        });
    } else {
        this.status = 'disconnected';
    }
};

Client.prototype.runCommand = function (command, arguments) {
    let args;
    if (!arguments || arguments === null) {
        args = {};
    } else {
        args = arguments;
    }
    if (this.status === 'ready' || this.status === 'connecting') {
        return new Promise((resolve, reject) => {
            this.client.VimService.VimPort[command](args, (err, result, raw, soapHeader) => {
                if (err) {
                    let errState = this.soapErrorHandler(err);
                    if (!errState && this.status === 'disconnected') {
                        return this.runCommand(command, args)
                            .then(result => resolve(result))
                            .catch(err => reject(err));
                    } else if (errState) {
                        return reject(errState);
                    }
                }

                if (command === 'Logout') {
                    this.status = 'disconnected';
                }

                return resolve(result);
            }, { timeout: this.timeout });
        });
    } else if (this.status === 'disconnected') {
        return this.connect()
            .then(() => {
                return this.runCommand(command, args);
            });
    } else {
        return Promise.reject(new Error(`invalid connection state ${this.status} for host ${this.connectionInfo.host}`));
    }
};

Client.prototype.soapErrorHandler = function (err, command, args) {
    if (!err) {
        err = { body: 'general error' };
    }

    if (err.body && err.body.match(/session is not authenticated/)) {
        this.status = 'disconnected';
        if (this.reconnectCount < this.reconnectLimit) {
            this.reconnectCount++;
            return;
        }
    }

    return err;
}

module.exports.Client = Client;
