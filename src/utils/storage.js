import file from '@system.file' 

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

function loadIfNeeded(callback) {
    if (global.__storage_cache__ !== null) {
        callback(global.__storage_cache__);
        return;
    }

    if (global.__storage_loading__) {
        global.__storage_callbacks__.push(callback);
        return;
    }

    global.__storage_loading__ = true;
    global.__storage_callbacks__.push(callback);

    file.readText({
        uri: fileSavedPath,
        success: function(data) {
            try {
                global.__storage_cache__ = JSON.parse(data.text);
                if (global.__storage_cache__ === null || typeof global.__storage_cache__ !== 'object') {
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

function saveToFile() {
    const toWrite = (global.__storage_cache__ && typeof global.__storage_cache__ === 'object') ? global.__storage_cache__ : {};
    try {
        file.writeText({
            uri: fileSavedPath,
            text: JSON.stringify(toWrite)
        });
    } catch (e) {
        console.error("Storage save error:", e);
    }
}

function get(param){
    loadIfNeeded(data => {
        const safeData = (data && typeof data === 'object') ? data : {};
        const key = param && param.key;
        let str = (key !== undefined) ? safeData[key] : undefined;
        if (str === undefined && param && param.default !== undefined) {
            str = param.default;
        }
        if (str === undefined) {
            str = '';
        }
        if (param && param.success) {
            param.success(str);
        }
        if (param && param.complete) {
            param.complete();
        }
    });
}

function save(data, param){
    loadIfNeeded(() => {
        const newData = (data && typeof data === 'object') ? data : {};
        global.__storage_cache__ = newData;
        saveToFile();
        
        if (param && param.success) {
            param.success();
        }
        if (param && param.complete) {
            param.complete();
        }
    });
}

function set(param){
    loadIfNeeded(data => {
        const safeData = (data && typeof data === 'object') ? data : {};
        const oldValue = safeData[param.key];
        if (oldValue !== param.value) {
            safeData[param.key] = param.value;
            global.__storage_cache__ = safeData;
            saveToFile();
        }
        if (param && param.success) {
            param.success();
        }
        if (param && param.complete) {
            param.complete();
        }
    });
}

function clear(param){
    global.__storage_cache__ = {};
    saveToFile();
    
    if (param && param.success) param.success();
    if (param && param.complete) param.complete();
}

function del(param){
    loadIfNeeded(data => {
        if (param.key in data) {
            delete data[param.key];
            global.__storage_cache__ = data;
            saveToFile();
        }
        if(param.success) {
            param.success();
        }
        if(param.complete) {
            param.complete();
        }
    });
}

export default { get, set, clear, delete: del, save };
