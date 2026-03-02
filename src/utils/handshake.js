import interconn from './interconn.js';
import { versionCode } from "../manifest.json";
import router from '@system.router';

const MIN_PHONE_VERSION = 126201;
const MIN_PHONE_VERSION_NAME = "V26.2.1";
const type = "__hs__"
const TIMEOUT = 15000;

export default class InterHandshake extends interconn {
    promise = null;
    resolve = null;
    timeout = null;
    handshaked = false;

    constructor() {
        super();
        this.conn.onmessage = ({ data }) => {
            clearTimeout(this.timeout);
            this.timeout = setTimeout(() => {
                this.promise = this.resolve = null;
                this.handshaked = false;
            }, TIMEOUT);
            const { tag, ...payload } = JSON.parse(data);
            if (this.callbacks[tag]) {
                this.callbacks[tag](payload);
            }
        }
        
        this.addListener(type, ({ count, version }) => {
            if ((version && version < MIN_PHONE_VERSION) || !version) {
                const currentVersion = version || '未知';
                return router.replace({
                    uri: 'pages/confirm',
                    params: {
                        action: 'versionError',
                        title: '版本不兼容',
                        confirmText: '手机端版本过低',
                        subText: `当前版本：${currentVersion}\n所需版本：${MIN_PHONE_VERSION_NAME}\n请升级手机端后再使用本小程序`,
                    }
                });
            }
            if (count > 0) {
                this.handshaked = true;
                if (this.promise) {
                    this.resolve();
                    this.resolve = null;
                } else {
                    this.promise = Promise.resolve();
                    this.callback();
                }
            }
            if (count++ < 2) super.send(type, { count, version: versionCode });
        });

        this.addEventListener((e) => {
            if (e !== "open") {
                this.resolve = null;
                this.promise = null;
                this.handshaked = false;
                clearTimeout(this.timeout);
                return;
            }
            this.handshaked = false;
            this.promise = this._newPromise();
        });
    }

    async send(...args) {
        if (!this.promise) {
            this.promise = this._newPromise();
        }
        await this.promise;
        return await super.send(...args);
    }

    setHandshakeListener(callback) {
        this.callback = callback;
    }

    callback = () => { }

    get connected() { return this.handshaked; }

    _newPromise() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.promise = this.resolve = null;
                this.handshaked = false;
                reject(new Error("timeout"));
            }, TIMEOUT);
            
            this.resolve = () => {
                clearTimeout(timeout);
                resolve();
            };
            super.send(type, { count: 0, version: versionCode });
        });
    }
}
