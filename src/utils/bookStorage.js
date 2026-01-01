import file from '@system.file';
import runAsyncFunc from '../utils/runAsyncFunc.js';
import router from '@system.router';

const BOOKSHELF_URI = 'internal://files/books/bookshelf.json';
const BOOKSHELF_VERSION = 3;

let bookshelfCache = null;

async function loadBookshelf() {
    if (bookshelfCache) {
        return JSON.parse(JSON.stringify(bookshelfCache));
    }
    
    try {
        const data = await runAsyncFunc(file.readText, { uri: BOOKSHELF_URI });
        const parsedData = JSON.parse(data.text);

        if (Array.isArray(parsedData) || !parsedData.version || parsedData.version < BOOKSHELF_VERSION) {
            router.replace({
                uri: '/pages/help',
                params: {
                    title: '格式不兼容',
                    content: '书架存储格式已更新且旧数据不再兼容。为防止卡死，请卸载后重装小程序再重新同步书籍。'
                }
            });
            return { version: BOOKSHELF_VERSION, books: [] };
        }
        bookshelfCache = parsedData;
        return JSON.parse(JSON.stringify(parsedData));
    } catch (e) {
        const defaultData = { version: BOOKSHELF_VERSION, books: [] };
        bookshelfCache = defaultData;
        return JSON.parse(JSON.stringify(defaultData));
    }
}

async function saveBookshelf(bookshelfData) {
    try {
        bookshelfCache = JSON.parse(JSON.stringify(bookshelfData));
        await runAsyncFunc(file.writeText, {
            uri: BOOKSHELF_URI,
            text: JSON.stringify(bookshelfData),
        });
    } catch (e) {
        throw e; 
    }
}

async function get(bookDirName) {
    const bookshelf = await loadBookshelf();
    const book = bookshelf.books.find(b => b.dirName === bookDirName);
    const progress = book?.progress || { chapterIndex: null, offsetInChapter: 0, scrollOffset: 0 };
    
    const result = JSON.parse(JSON.stringify(progress));
    if (result.chapterIndex === undefined || result.chapterIndex === null) {
        result.chapterIndex = null;
    }
    if (typeof result.offsetInChapter !== 'number' || isNaN(result.offsetInChapter)) {
        result.offsetInChapter = 0;
    }
    if (typeof result.scrollOffset !== 'number' || isNaN(result.scrollOffset)) {
        result.scrollOffset = 0;
    }
    
    delete result.bookmarks;
    return result;
}

async function set(bookDirName, progressData) {
    const bookshelf = await loadBookshelf();
    const bookIndex = bookshelf.books.findIndex(b => b.dirName === bookDirName);
    
    if (bookIndex !== -1) {
        if (!bookshelf.books[bookIndex].progress) {
            bookshelf.books[bookIndex].progress = {};
        }
        
        const { bookmarks, ...progressWithoutBookmarks } = progressData;
        const cleanProgress = {};
        if (progressWithoutBookmarks.chapterIndex !== undefined && progressWithoutBookmarks.chapterIndex !== null) {
            cleanProgress.chapterIndex = parseInt(progressWithoutBookmarks.chapterIndex);
            if (isNaN(cleanProgress.chapterIndex)) {
                cleanProgress.chapterIndex = null;
            }
        } else {
            cleanProgress.chapterIndex = null;
        }
        
        (function() {
            const rawOffset = progressWithoutBookmarks.offsetInChapter;
            let offset = 0;
            if (typeof rawOffset === 'number') {
                offset = Math.max(0, Math.floor(rawOffset));
            } else if (typeof rawOffset === 'string') {
                const parsed = parseInt(rawOffset, 10);
                offset = isNaN(parsed) ? 0 : Math.max(0, parsed);
            } else {
                offset = 0;
            }
            if (offset % 2 === 1) offset = Math.max(0, offset - 1);
            cleanProgress.offsetInChapter = offset;
        })();
        
        cleanProgress.scrollOffset = typeof progressWithoutBookmarks.scrollOffset === 'number' 
            ? Math.max(0, Math.floor(progressWithoutBookmarks.scrollOffset)) 
            : 0;
        Object.keys(progressWithoutBookmarks).forEach(key => {
            if (!['chapterIndex', 'offsetInChapter', 'scrollOffset'].includes(key)) {
                cleanProgress[key] = progressWithoutBookmarks[key];
            }
        });
        
        Object.assign(bookshelf.books[bookIndex].progress, cleanProgress);
        
        await saveBookshelf(bookshelf);
    }
}

async function getBookmarks(bookDirName) {
    const bookshelf = await loadBookshelf();
    const book = bookshelf.books?.find(b => b.dirName === bookDirName);
    const bookmarks = book?.progress?.bookmarks || [];
    
    return JSON.parse(JSON.stringify(bookmarks));
}

async function setBookmarks(bookDirName, bookmarks) {
    const bookshelf = await loadBookshelf();
    
    const bookIndex = bookshelf.books?.findIndex(b => b.dirName === bookDirName);
    if (bookIndex !== -1) {
        if (!bookshelf.books[bookIndex].progress) {
            bookshelf.books[bookIndex].progress = {};
        }
        
        bookshelf.books[bookIndex].progress.bookmarks = JSON.parse(JSON.stringify(bookmarks));
        bookshelf.books[bookIndex].progress.lastReadTimestamp = Date.now();
        
        await saveBookshelf(bookshelf);
    }
}

async function getBooks() {
    const bookshelf = await loadBookshelf();
    return JSON.parse(JSON.stringify(bookshelf.books || []));
}

async function updateBooks(newBooks) {
    const bookshelf = await loadBookshelf();
    bookshelf.books = newBooks;
    await saveBookshelf(bookshelf);
}

async function removeBook(dirName) {
    const bookshelf = await loadBookshelf();
    const initialLength = bookshelf.books.length;
    bookshelf.books = bookshelf.books.filter(b => b.dirName !== dirName);
    if (bookshelf.books.length < initialLength) {
        await saveBookshelf(bookshelf);
    }
}

export default { get, set, getBooks, updateBooks, removeBook, load: loadBookshelf, getBookmarks, setBookmarks };
