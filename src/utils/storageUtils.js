export function getReservedStorage(product) {
    if (!product) return 0;
    if (product === "REDMI Watch 6") return 120 * 1024 * 1024;
    if (product === "REDMI Watch 5") return 120 * 1024 * 1024;
    if (product === "Xiaomi Smart Band 9") return 64 * 1024 * 1024;
    if (product === "Xiaomi Smart Band 9 Pro") return 64 * 1024 * 1024;
    if (product === "Xiaomi Smart Band 8 Pro") return 84 * 1024 * 1024;
    if (product === "o65m") return 1024 * 1024 * 1024;
    if (product && product.includes("Xiaomi Smart Band 10")) return 90 * 1024 * 1024;
    return 0;
}

export function calculateStorageInfo(totalStorage, availableStorage, product) {
    const reservedStorage = getReservedStorage(product);
    const usedStorage = totalStorage - availableStorage;
    const actualAvailable = totalStorage - reservedStorage - usedStorage;
    return {
        totalStorage,
        availableStorage,
        reservedStorage,
        usedStorage,
        actualAvailable
    };
}

export function isStorageLow(actualAvailable) {
    return actualAvailable < 2 * 1024 * 1024;
}

