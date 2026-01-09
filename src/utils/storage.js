import file from '@system.file';

const fileSavedPath = 'internal://files/books/storage-api/savedFile';

if (typeof global.__storage_cache__ === 'undefined') {
    global.__storage_cache__ = null;
}
if (typeof global.__storage_loading__ === 'undefined') {
    global.__storage_loading__ = false;
}
if (typeof global.__storage_callbacks__ === 'undefined') {
    global.__storage_callbacks__ = [];
}

function processCallbacks() {
    global.__storage_loading__ = false;
    const callbacks = global.__storage_callbacks__;
    global.__storage_callbacks__ = [];
    callbacks.forEach(cb => {
        try {
            cb(global.__storage_cache__);
        } catch (e) {
            console.error("Storage callback error:", e);
        }
    });
}

function loadIfNeeded(callback) {
    if (global.__storage_cache__ !== null) {
        callback(global.__storage_cache__);
        return;
    }

    global.__storage_callbacks__.push(callback);
    if (global.__storage_loading__) return;

    global.__storage_loading__ = true;

    file.readText({
        uri: fileSavedPath,
        success: function(data) {
            try {
                global.__storage_cache__ = JSON.parse(data.text) || {};
                if (typeof global.__storage_cache__ !== 'object') {
                    global.__storage_cache__ = {};
                }
            } catch (e) {
                global.__storage_cache__ = {};
            }
            processCallbacks();
        },
        fail: function() {
            global.__storage_cache__ = {};
            processCallbacks();
        }
    });
}

function saveToFile() {
    const toWrite = (global.__storage_cache__ && typeof global.__storage_cache__ === 'object') ? global.__storage_cache__ : {};
    file.writeText({
        uri: fileSavedPath,
        text: JSON.stringify(toWrite)
    });
}

function get(param = {}) {
    loadIfNeeded(data => {
        const key = param.key;
        let val = (data && key !== undefined) ? data[key] : undefined;
        if (val === undefined) {
            val = param.default !== undefined ? param.default : '';
        }
        if (param.success) param.success(val);
        if (param.complete) param.complete();
    });
}

function set(param = {}) {
    loadIfNeeded(data => {
        const safeData = data || {};
        if (safeData[param.key] !== param.value) {
            safeData[param.key] = param.value;
            global.__storage_cache__ = safeData;
            saveToFile();
        }
        if (param.success) param.success();
        if (param.complete) param.complete();
    });
}

function save(data, param = {}) {
    loadIfNeeded(() => {
        global.__storage_cache__ = (data && typeof data === 'object') ? data : {};
        saveToFile();
        if (param.success) param.success();
        if (param.complete) param.complete();
    });
}

function clear(param = {}) {
    global.__storage_cache__ = {};
    saveToFile();
    if (param.success) param.success();
    if (param.complete) param.complete();
}

function del(param = {}) {
    loadIfNeeded(data => {
        if (data && param.key in data) {
            delete data[param.key];
            global.__storage_cache__ = data;
            saveToFile();
        }
        if (param.success) param.success();
        if (param.complete) param.complete();
    });
}

export default { get, set, clear, delete: del, save };
