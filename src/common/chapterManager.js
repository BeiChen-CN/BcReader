import file from '@system.file';

const chapterCache = new Map();
const CACHE_EXPIRY = 5 * 60 * 1000;

/**
 * 解析章节列表
 * @param {string} bookName - 书籍目录名
 * @returns {Promise<Array>} 章节数组
 */
async function loadChapterList(bookName) {
    const cached = chapterCache.get(bookName);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return [...cached.chapters];
    }
    
    const listUri = `internal://files/books/${bookName}/list.txt`;
    
    try {
        const data = await new Promise((resolve, reject) => {
            file.readText({
                uri: listUri,
                success: resolve,
                fail: reject
            });
        });
        
        const chapters = parseChapterList(data.text);
        
        chapterCache.set(bookName, {
            chapters,
            timestamp: Date.now()
        });
        
        return chapters;
    } catch (error) {
        console.error(`Failed to load chapter list for ${bookName}:`, error);
        throw error;
    }
}

/**
 * 章节列表解析
 * @param {string} text - list.txt的文本内容
 * @returns {Array} 章节数组
 */
function parseChapterList(text) {
    if (!text) return [];
    
    const lines = text.split('\n');
    const chapterMap = new Map();
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
            const chapter = JSON.parse(line);
            if (chapter && typeof chapter.index === 'number' && chapter.name) {
                chapterMap.set(chapter.index, chapter);
            }
        } catch (e) {
            // 忽略解析失败的行
            continue;
        }
    }
    
    const chapters = Array.from(chapterMap.values());
    chapters.sort((a, b) => a.index - b.index);
    
    return chapters;
}

/**
 * 清除指定书籍的缓存
 * @param {string} bookName - 书籍目录名
 */
function clearCache(bookName) {
    if (bookName) {
        chapterCache.delete(bookName);
    } else {
        chapterCache.clear();
    }
}

/**
 * 预加载章节列表（后台异步）
 * @param {string} bookName - 书籍目录名
 */
function preloadChapterList(bookName) {
    setTimeout(() => {
        loadChapterList(bookName).catch(e => {
            // 不影响正常流程
        });
    }, 0);
}

/**
 * 批量获取章节（用于分页）
 * @param {string} bookName - 书籍目录名
 * @param {number} page - 页码（从0开始）
 * @param {number} pageSize - 每页数量
 * @returns {Promise<Object>} {chapters, totalPages, currentPage}
 */
async function getChapterPage(bookName, page = 0, pageSize = 8) {
    const allChapters = await loadChapterList(bookName);
    const totalPages = Math.ceil(allChapters.length / pageSize) || 1;
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    
    const start = safePage * pageSize;
    const end = start + pageSize;
    const chapters = allChapters.slice(start, end);
    
    return {
        chapters,
        totalPages,
        currentPage: safePage,
        totalChapters: allChapters.length
    };
}

/**
 * 根据章节索引查找章节信息
 * @param {string} bookName - 书籍目录名
 * @param {number} chapterIndex - 章节索引
 * @returns {Promise<Object|null>} 章节对象
 */
async function getChapterByIndex(bookName, chapterIndex) {
    const chapters = await loadChapterList(bookName);
    return chapters.find(ch => ch.index === chapterIndex) || null;
}

export default {
    loadChapterList,
    parseChapterList,
    clearCache,
    preloadChapterList,
    getChapterPage,
    getChapterByIndex
};

