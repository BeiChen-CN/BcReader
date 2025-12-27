import file from '@system.file' 

let storageCache = null;
const fileSavedPath = 'internal://files/books/storage-api/savedFile';

function loadIfNeeded(callback) {
    if (storageCache !== null) {
        callback(storageCache);
        return;
    }
    file.readText({
        uri: fileSavedPath,
        success: function(data) {
            try {
                storageCache = JSON.parse(data.text);
                if (storageCache === null || typeof storageCache !== 'object') {
                    storageCache = {};
                }
            } catch (e) {
                storageCache = {};
            }
            callback(storageCache);
        },
        fail: function() {
            storageCache = {};
            callback(storageCache);
        }
    });
}

function saveToFile() {
    const toWrite = (storageCache && typeof storageCache === 'object') ? storageCache : {};
    try {
        file.writeText({
            uri: fileSavedPath,
            text: JSON.stringify(toWrite)
        });
    } catch (e) {
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

function save(data,param){
    const newData = (data && typeof data === 'object') ? data : {};
    const dataStr = JSON.stringify(newData);
    const cacheStr = (storageCache && typeof storageCache === 'object') ? JSON.stringify(storageCache) : '{}';
    if (dataStr !== cacheStr) {
        storageCache = newData;
        saveToFile();
    }
    if (param && param.success) {
        param.success();
    }
    if (param && param.complete) {
        param.complete();
    }
}

function set(param){
    loadIfNeeded(data => {
        const safeData = (data && typeof data === 'object') ? data : {};
        const oldValue = safeData[param.key];
        if (oldValue !== param.value) {
            safeData[param.key] = param.value;
            storageCache = safeData;
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
    if (storageCache !== null && Object.keys(storageCache).length > 0) {
        storageCache = {};
        saveToFile();
    } else {
        storageCache = {};
    }
    if (param && param.success) param.success();
    if (param && param.complete) param.complete();
}

function del(param){
    loadIfNeeded(data => {
        if (param.key in data) {
            delete data[param.key];
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