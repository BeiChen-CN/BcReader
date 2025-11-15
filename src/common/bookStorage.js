import file from '@system.file';
import runAsyncFunc from '../utils/runAsyncFunc.js';
import router from '@system.router';

const BOOKSHELF_URI = 'internal://files/books/bookshelf.json';
const BOOKSHELF_VERSION = 2;

let bookshelfCache = null;
let isDirty = false;

async function load() {
    if (bookshelfCache === null) {
        try {
            const data = await runAsyncFunc(file.readText, { uri: BOOKSHELF_URI });
            const parsedData = JSON.parse(data.text);
            if (Array.isArray(parsedData) || !parsedData.version || parsedData.version < BOOKSHELF_VERSION) {
                router.replace({
                    uri: '/pages/confirm',
                    params: {
                        action: 'clearBookshelf',
                        title: '格式不兼容',
                        confirmText: '需要清空书架',
                        subText: '书架存储格式已更新，旧数据不再兼容。请清空书架后重新同步书籍。'
                    }
                });
                bookshelfCache = { version: BOOKSHELF_VERSION, books: [] };
                throw new Error("Incompatible bookshelf version");
            }
            bookshelfCache = parsedData;
        } catch (e) {
            if (e.message !== "Incompatible bookshelf version") {
                bookshelfCache = { version: BOOKSHELF_VERSION, books: [] };
            }
        }
    }
}

async function save() {
    if (!isDirty || bookshelfCache === null) return;

    try {
        await runAsyncFunc(file.writeText, {
            uri: BOOKSHELF_URI,
            text: JSON.stringify(bookshelfCache),
        });
        isDirty = false;
    } catch (e) {
    }
}

async function get(bookDirName) {
    await load();
    const book = bookshelfCache.books.find(b => b.dirName === bookDirName);
    return book?.progress || { chapterIndex: null, offsetInChapter: 0, scrollOffset: 0, bookmarks: [] };
}

async function set(bookDirName, progressData) {
    await load();
    const bookIndex = bookshelfCache.books.findIndex(b => b.dirName === bookDirName);
    if (bookIndex !== -1) {
        if (!bookshelfCache.books[bookIndex].progress) {
            bookshelfCache.books[bookIndex].progress = {};
        }
        Object.assign(bookshelfCache.books[bookIndex].progress, progressData);
        isDirty = true;
        await save();
    }
}

async function getBooks() {
    try {
        const data = await runAsyncFunc(file.readText, { uri: BOOKSHELF_URI });
        const parsedData = JSON.parse(data.text);
        if (Array.isArray(parsedData) || !parsedData.version || parsedData.version < BOOKSHELF_VERSION) {
            bookshelfCache = { version: BOOKSHELF_VERSION, books: [] };
        } else {
            bookshelfCache = parsedData;
        }
    } catch (e) {
        bookshelfCache = { version: BOOKSHELF_VERSION, books: [] };
    }
    return JSON.parse(JSON.stringify(bookshelfCache.books || []));
}

async function updateBooks(newBooks) {
    if (!bookshelfCache) {
        bookshelfCache = { version: BOOKSHELF_VERSION, books: [] };
    }
    bookshelfCache.books = newBooks;
    isDirty = true;
    await save();
}

async function removeBook(dirName) {
    await load();
    const initialLength = bookshelfCache.books.length;
    bookshelfCache.books = bookshelfCache.books.filter(b => b.dirName !== dirName);
    if (bookshelfCache.books.length < initialLength) {
        isDirty = true;
        await save();
    }
}

export default { get, set, getBooks, updateBooks, removeBook, load };
