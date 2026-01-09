import file from '@system.file';
import runAsyncFunc from '../utils/runAsyncFunc.js';
import router from '@system.router';

const BOOKSHELF_URI = 'internal://files/books/bookshelf.json';
const BOOKSHELF_VERSION = 3;
const DEFAULT_DATA = { version: BOOKSHELF_VERSION, books: [] };

if (typeof global.__bookshelf_cache__ === 'undefined') {
    global.__bookshelf_cache__ = null;
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

async function loadBookshelf() {
    if (global.__bookshelf_cache__) {
        return clone(global.__bookshelf_cache__);
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
            return clone(DEFAULT_DATA);
        }
        global.__bookshelf_cache__ = parsedData;
        return clone(parsedData);
    } catch (e) {
        global.__bookshelf_cache__ = clone(DEFAULT_DATA);
        return clone(DEFAULT_DATA);
    }
}

async function saveBookshelf(bookshelfData) {
    global.__bookshelf_cache__ = clone(bookshelfData);
    await runAsyncFunc(file.writeText, {
        uri: BOOKSHELF_URI,
        text: JSON.stringify(bookshelfData),
    });
}

async function get(bookDirName) {
    const bookshelf = await loadBookshelf();
    const book = bookshelf.books.find(b => b.dirName === bookDirName);
    
    const progress = book?.progress || {};
    const result = {
        chapterIndex: progress.chapterIndex ?? null,
        offsetInChapter: (typeof progress.offsetInChapter === 'number' && !isNaN(progress.offsetInChapter)) ? progress.offsetInChapter : 0,
        scrollOffset: (typeof progress.scrollOffset === 'number' && !isNaN(progress.scrollOffset)) ? progress.scrollOffset : 0
    };

    return result;
}

async function set(bookDirName, progressData) {
    const bookshelf = await loadBookshelf();
    const bookIndex = bookshelf.books.findIndex(b => b.dirName === bookDirName);

    if (bookIndex !== -1) {
        const book = bookshelf.books[bookIndex];
        if (!book.progress) {
            book.progress = {};
        }

        const { bookmarks, ...newProgress } = progressData;
        const cleanProgress = {};

        if (newProgress.chapterIndex != null) {
            const cIdx = parseInt(newProgress.chapterIndex);
            cleanProgress.chapterIndex = isNaN(cIdx) ? null : cIdx;
        } else {
            cleanProgress.chapterIndex = null;
        }

        let offset = 0;
        const rawOffset = newProgress.offsetInChapter;
        if (typeof rawOffset === 'number') {
            offset = Math.max(0, Math.floor(rawOffset));
        } else if (typeof rawOffset === 'string') {
            const parsed = parseInt(rawOffset, 10);
            offset = isNaN(parsed) ? 0 : Math.max(0, parsed);
        }
        if (offset % 2 === 1) offset = Math.max(0, offset - 1);
        cleanProgress.offsetInChapter = offset;

        cleanProgress.scrollOffset = typeof newProgress.scrollOffset === 'number'
            ? Math.max(0, Math.floor(newProgress.scrollOffset))
            : 0;

        Object.keys(newProgress).forEach(key => {
            if (!['chapterIndex', 'offsetInChapter', 'scrollOffset'].includes(key)) {
                cleanProgress[key] = newProgress[key];
            }
        });

        Object.assign(book.progress, cleanProgress);
        await saveBookshelf(bookshelf);
    }
}

async function getBookmarks(bookDirName) {
    const bookshelf = await loadBookshelf();
    const book = bookshelf.books?.find(b => b.dirName === bookDirName);
    return clone(book?.progress?.bookmarks || []);
}

async function setBookmarks(bookDirName, bookmarks) {
    const bookshelf = await loadBookshelf();
    const bookIndex = bookshelf.books?.findIndex(b => b.dirName === bookDirName);

    if (bookIndex !== -1) {
        const book = bookshelf.books[bookIndex];
        if (!book.progress) {
            book.progress = {};
        }
        book.progress.bookmarks = clone(bookmarks);
        book.progress.lastReadTimestamp = Date.now();
        
        await saveBookshelf(bookshelf);
    }
}

async function getBooks() {
    const bookshelf = await loadBookshelf();
    return clone(bookshelf.books || []);
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
