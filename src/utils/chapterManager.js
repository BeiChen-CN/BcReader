import file from '@system.file';
import router from '@system.router';
import runAsyncFunc from '../utils/runAsyncFunc.js';

const bookIndexCache = new Map();
const chapterChunkCache = new Map();
const availableChaptersCache = new Map();
const CACHE_EXPIRY = 5 * 60 * 1000;
const CHAPTERS_PER_FILE = 100;

async function checkVersion(bookName) {
    const newListUri = `internal://files/books/${bookName}/lindex.txt`;
    try {
        await runAsyncFunc(file.access, { uri: newListUri });
        return 'new';
    } catch (e) {
        return 'none';
    }
}

async function handleOldVersion(bookName) {
    router.push({
        uri: '/pages/confirm',
        params: {
            action: 'deleteBook',
            title: "不兼容格式",
            subText: "此书籍使用了旧的索引格式，必须删除后重新同步才能阅读。",
            confirmText: `需要删除数据`,
            cPath: 'internal://files/books/' + bookName
        }
    });
}

async function loadBookIndex(bookName) {
    const cached = bookIndexCache.get(bookName);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return cached.index;
    }

    const indexUri = `internal://files/books/${bookName}/lindex.txt`;
    try {
        const data = await runAsyncFunc(file.readText, { uri: indexUri });
        const lines = data.text.split('\n');
        const totalChapters = parseInt(lines[0], 10) || 0;
        const syncedChapters = parseInt(lines[1], 10) || 0;
        const ranges = lines.slice(2).filter(Boolean).map(line => {
            const [start, end] = line.split(',').map(Number);
            return { start, end };
        });

        const bookIndex = { totalChapters, syncedChapters, ranges };
        bookIndexCache.set(bookName, {
            index: bookIndex,
            timestamp: Date.now()
        });
        return bookIndex;
    } catch (error) {
        throw new Error(`Failed to load book index for ${bookName}: ${error.message}`);
    }
}

async function loadChapterChunk(bookName, chunkIndex) {
    const cacheKey = `${bookName}_${chunkIndex}`;
    const cached = chapterChunkCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return cached.chapters;
    }

    const chunkUri = `internal://files/books/${bookName}/indexes/${chunkIndex}.txt`;
    try {
        const data = await runAsyncFunc(file.readText, { uri: chunkUri });
        const chapters = parseChapterList(data.text);
        chapterChunkCache.set(cacheKey, {
            chapters,
            timestamp: Date.now()
        });
        return chapters;
    } catch (error) {
        return [];
    }
}

function parseChapterList(text) {
    if (!text) return [];
    
    const lines = text.split('\n');
    const chapterMap = new Map();
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split('\t');
        if (parts.length >= 2) {
            const index = parseInt(parts[0], 10);
            const name = parts[1];
            const wordCount = parts.length >= 3 ? parseInt(parts[2], 10) || 0 : 0;
            
            if (!isNaN(index) && name) {
                chapterMap.set(index, { index, name, wordCount });
            }
        }
    }
    
    const chapters = Array.from(chapterMap.values());
    chapters.sort((a, b) => a.index - b.index);
    
    return chapters;
}

async function getAllAvailableChapters(bookName) {
    const cached = availableChaptersCache.get(bookName);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return cached.chapters;
    }

    const indexesUri = `internal://files/books/${bookName}/indexes/`;
    let allChapters = [];
    try {
        const res = await runAsyncFunc(file.list, { uri: indexesUri });
        const files = res.fileList.filter(f => f.uri.endsWith('.txt'));
        
        const promises = files.map(f => runAsyncFunc(file.readText, { uri: f.uri }));
        const results = await Promise.all(promises);
        
        for (const result of results) {
            const chapters = parseChapterList(result.text);
            allChapters.push(...chapters);
        }
    } catch(e) {
        return [];
    }
    
    allChapters.sort((a, b) => a.index - b.index);
    availableChaptersCache.set(bookName, {
        chapters: allChapters,
        timestamp: Date.now()
    });
    return allChapters;
}

function clearCache(bookName) {
    if (bookName) {
        bookIndexCache.delete(bookName);
        availableChaptersCache.delete(bookName);
        for (const key of chapterChunkCache.keys()) {
            if (key.startsWith(bookName + '_')) {
                chapterChunkCache.delete(key);
            }
        }
    } else {
        bookIndexCache.clear();
        chapterChunkCache.clear();
        availableChaptersCache.clear();
    }
}

async function getChapterPage(bookName, page = 0, pageSize = 8) {
    const version = await checkVersion(bookName);
    if (version === 'none') {
        return { chapters: [], totalPages: 0, currentPage: 0, totalChapters: 0 };
    }

    const allChapters = await getAllAvailableChapters(bookName);
    const totalChapters = allChapters.length;

    if (totalChapters === 0) {
         return { chapters: [], totalPages: 0, currentPage: 0, totalChapters: 0 };
    }

    const totalPages = Math.ceil(totalChapters / pageSize) || 1;
    const safePage = Math.max(0, Math.min(page, totalPages - 1));

    const start = safePage * pageSize;
    const end = start + pageSize;
    const pageChapters = allChapters.slice(start, end);
    
    return {
        chapters: pageChapters,
        totalPages,
        currentPage: safePage,
        totalChapters,
    };
}async function getChapterByIndex(bookName, chapterIndex) {
    const chunkIndex = Math.floor(chapterIndex / CHAPTERS_PER_FILE) + 1;
    const chunk = await loadChapterChunk(bookName, chunkIndex);
    return chunk.find(ch => ch.index === chapterIndex) || null;
}

async function getTotalChapters(bookName) {
    const version = await checkVersion(bookName);
    if (version === 'none') {
        return 0;
    }
    try {
        const bookIndex = await loadBookIndex(bookName);
        return bookIndex.totalChapters;
    } catch (e) {
        return 0;
    }
}

async function getSyncedChapters(bookName) {
    const version = await checkVersion(bookName);
    if (version === 'none') {
        return 0;
    }
    try {
        const bookIndex = await loadBookIndex(bookName);
        return bookIndex.syncedChapters;
    } catch (e) {
        return 0;
    }
}

async function deleteChapter(bookName, chapterIndex) {
    try {
        const contentUri = `internal://files/books/${bookName}/content/${chapterIndex}.txt`;
        try {
            await runAsyncFunc(file.delete, { uri: contentUri });
        } catch (e) {
        }

        const chunkIndex = Math.floor(chapterIndex / CHAPTERS_PER_FILE) + 1;
        const chunkUri = `internal://files/books/${bookName}/indexes/${chunkIndex}.txt`;
        
        try {
            const chunkData = await runAsyncFunc(file.readText, { uri: chunkUri });
            const lines = chunkData.text.split('\n');
            const filteredLines = lines.filter(line => {
                const trimmed = line.trim();
                if (!trimmed) return false;
                const parts = trimmed.split('\t');
                if (parts.length >= 2) {
                    const index = parseInt(parts[0], 10);
                    return index !== chapterIndex;
                }
                return true;
            });
            
            if (filteredLines.length > 0) {
                const newContent = filteredLines.join('\n') + '\n';
                await runAsyncFunc(file.writeText, { 
                    uri: chunkUri, 
                    text: newContent 
                });
            } else {
                try {
                    await runAsyncFunc(file.delete, { uri: chunkUri });
                } catch (e) {
                }
            }
        } catch (e) {
        }

        return true;
    } catch (error) {
        throw new Error(`Failed to delete chapter ${chapterIndex}: ${error.message}`);
    }
}

export default {
    checkVersion,
    handleOldVersion,
    clearCache,
    getChapterPage,
    getChapterByIndex,
    loadBookIndex,
    getTotalChapters,
    getSyncedChapters,
    getAllAvailableChapters,
    deleteChapter
};
