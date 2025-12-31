import file from "@system.file";
import device from "@system.device";
import runAsyncFunc from "./runAsyncFunc";
import str2abWrite from "./str2abWrite";
import bookStorage from '../utils/bookStorage.js';

export default class interconnfile {
    static "__interconnModule__" = true;
    static name = 'file';
    baseUri = 'internal://files/books/';
    currentBookName = "";
    currentBookDir = "";
    totalChapters = 0;
    receivedChapters = 0;
    currentSavingChapterIndex = -1;
    currentChapterMeta = null;
    isCoverOnly = false;
    syncedChapterIndices = new Set();
    
    pendingChapterMetas = [];
    BATCH_WRITE_SIZE = 10;
    CHAPTERS_PER_FILE = 100;
    lindexContent = null; 

    constructor({ addListener, send, setEventListener }) {
        const onmessage = async (data) => {
            const { stat, ...payload } = data;
            switch (stat) {
                case "startTransfer":
                    this.isCoverOnly = false;
                    this.startTransfer(payload);
                    break;
                case "start_cover_transfer":
                    this.isCoverOnly = true;
                    this.startCoverTransfer(payload);
                    break;
                case "d":
                    this.saveChapter(payload);
                    break;
                case "chapter_complete":
                    this.completeChapterTransfer(payload);
                    break;
                case "transfer_complete":
                    this.handleTransferComplete();
                    break;
                case "cancel":
                    if (this.pendingChapterMetas && this.pendingChapterMetas.length > 0) {
                        await this.flushPendingChapterMetas().catch(e => {
                            
                        });
                    }
                    this.send({ type: "cancel" });
                    this.currentBookName = "";
                    this.currentBookDir = "";
                    this.pendingChapterMetas = [];
                    this.lindexContent = null;
                    this.callback({ msg: "cancel" });
                    break;
                case "get_book_status":
                    this.getBookStatus(payload);
                    break;
                case "cover_chunk":
                    this.saveCoverChunk(payload);
                    break;
                case "cover_transfer_complete":
                    this.completeCoverTransfer();
                    break;
                case "update_book_info":
                    this.updateBookInfo(payload);
                    break;
                case "get_reading_data":
                    this.getReadingData(payload);
                    break;
                case "set_reading_data":
                    this.setReadingData(payload);
                    break;
                case "set_batch_reading_data":
                    this.setBatchReadingData(payload);
                    break;
                case "delete_chapters":
                    this.deleteChapters(payload);
                    break;
                case "get_storage_info":
                    this.getStorageInfo();
                    break;
            }
        }
        addListener(onmessage);
        this.send = send;
        setEventListener((event) => {
            if (event !== 'open') {
                if (this.pendingChapterMetas && this.pendingChapterMetas.length > 0) {
                    this.flushPendingChapterMetas().catch(e => {
                        
                    });
                }
                this.currentBookName = "";
                this.currentBookDir = "";
                this.lindexContent = null;
                this.callback({ msg: "error", error: event, filename: this.currentBookName });
            }
        })
    }

    async getUsage() {
        try {
            const { fileList } = await runAsyncFunc(file.list, { uri: this.baseUri });
            let usage = 0;
            for (const item of fileList) {
                if (item.type === 'dir') {
                    try {
                        const dirStat = await runAsyncFunc(file.stat, { uri: item.uri });
                        usage += dirStat.size;
                    } catch (e) {
                    }
                } else {
                    usage += item.length;
                }
            }
            return usage;
        } catch (error) {
            return 0;
        }
    }

    async clearCache() {
        try {
            const tempCoverUri = this.baseUri + 'temp_cover.jpg';
            try {
                await runAsyncFunc(file.delete, { uri: tempCoverUri });
            } catch (e) {}
            
        } catch (error) {
        }
    }

    generateDirName(filename) {
        let hash = 0;
        if (filename.length === 0) return '00000000';
        for (let i = 0; i < filename.length; i++) {
            const char = filename.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        const hex = (hash >>> 0).toString(16).padStart(8, '0');
        return hex;
    }

    generateCoverFileName() {
        const randomStr = Math.random().toString(36).substring(2, 10);
        return `cover_${randomStr}.jpg`;
    }

    async getBookStatus({ filename }) {
        try {
            await runAsyncFunc(file.access, { uri: this.baseUri });
        } catch (e) {
            this.send({ type: "book_status", syncedChapters: [], hasCover: false });
            return;
        }

        const sanitizedDirName = this.generateDirName(filename);
        const lindexUri = `${this.baseUri}${sanitizedDirName}/lindex.txt`;
        const indexesDirUri = `${this.baseUri}${sanitizedDirName}/indexes/`;
        const bookInfoUri = `${this.baseUri}${sanitizedDirName}/book_info.json`;
        let syncedChapterIndices = [];
        let hasCover = false;

        try {
            const lindexData = await runAsyncFunc(file.readText, { uri: lindexUri });
            const lines = lindexData.text.split('\n');
            const totalChapters = parseInt(lines[0], 10);
            
            if (isNaN(totalChapters)) {
                 throw new Error("Invalid lindex.txt format");
            }
            
            const numChunks = Math.ceil(totalChapters / this.CHAPTERS_PER_FILE);
            const indexSet = new Set();

            for (let i = 1; i <= numChunks; i++) {
                const chunkUri = `${indexesDirUri}${i}.txt`;
                try {
                    const chunkData = await runAsyncFunc(file.readText, { uri: chunkUri });
                    const chapterLines = chunkData.text.split('\n').filter(Boolean);
                    for (const line of chapterLines) {
                        const parts = line.split('\t');
                        if (parts.length >= 2) {
                            const index = parseInt(parts[0], 10);
                            if (!isNaN(index)) {
                                indexSet.add(index);
                            }
                        }
                    }
                } catch(e) {}
            }
            syncedChapterIndices = Array.from(indexSet);

        } catch (e) {
            syncedChapterIndices = [];
        }

        try {
            const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
            const bookInfo = JSON.parse(bookInfoData.text);
            if (bookInfo.coverFileName) {
                const coverUri = `${this.baseUri}${sanitizedDirName}/${bookInfo.coverFileName}`;
                await runAsyncFunc(file.access, { uri: coverUri });
                hasCover = true;
            }
        } catch (e) {
            hasCover = false;
        }

        this.send({ type: "book_status", syncedChapters: syncedChapterIndices, hasCover: hasCover });
        syncedChapterIndices = null;
    }
    
    async startCoverTransfer({ filename }) {
        try {
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "Filename is empty.", count: 0 });
                return;
            }
            this.currentBookName = filename;
            this.currentBookDir = this.generateDirName(filename);
            try {
                await runAsyncFunc(file.access, { uri: this.baseUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: this.baseUri, recursive: true });
            }

            const bookUri = this.baseUri + this.currentBookDir;
            
            try {
                await runAsyncFunc(file.access, { uri: bookUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: bookUri });
            }
            
            const bookInfoUri = bookUri + '/book_info.json';
            let bookInfo = {};
            try {
                const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                bookInfo = JSON.parse(bookInfoData.text);
                if (bookInfo.coverFileName) {
                    const oldCoverUri = bookUri + '/' + bookInfo.coverFileName;
                    await runAsyncFunc(file.delete, { uri: oldCoverUri });
                }
            } catch (e) {}
    
            const newCoverFileName = this.generateCoverFileName();
            bookInfo.coverFileName = newCoverFileName;
            bookInfo.hasCover = true;
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
    
            const bookshelf = await bookStorage.getBooks();
            const bookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
            if (bookIndex > -1) {
                bookshelf[bookIndex].coverFileName = newCoverFileName;
                bookshelf[bookIndex].hasCover = true;
                await bookStorage.updateBooks(bookshelf);
            }
            
            this.currentBookCoverUri = bookUri + '/' + newCoverFileName;
            
            this.send({ type: "cover_ready" });
        } catch (error) {
            this.send({ type: "error", message: `Start cover transfer failed: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    async rebuildSyncedIndices() {
        this.syncedChapterIndices = new Set();
        const indexesDirUri = `${this.baseUri}${this.currentBookDir}/indexes/`;
        try {
             const listResult = await runAsyncFunc(file.list, { uri: indexesDirUri });
             if (listResult.fileList) {
                 for (const f of listResult.fileList) {
                     if (f.uri.endsWith('.txt')) {
                         try {
                             const text = await runAsyncFunc(file.readText, { uri: f.uri });
                             const lines = text.text.split('\n');
                             for (const line of lines) {
                                 if (!line.trim()) continue;
                                 const parts = line.split('\t');
                                 if (parts.length >= 2) {
                                     const index = parseInt(parts[0], 10);
                                     if (!isNaN(index)) {
                                         this.syncedChapterIndices.add(index);
                                     }
                                 }
                             }
                         } catch(e) {}
                     }
                 }
             }
        } catch (e) {}
        this.receivedChapters = this.syncedChapterIndices.size;
    }

    async startTransfer({ filename, total, wordCount, startFrom = 0, hasCover = false, author = null, summary = null, bookStatus = null, category = null, localCategory = null }) {
        try {
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "文件名为空或无效", count: 0 });
                this.callback({ msg: "error", error: "文件名为空或无效" });
                return;
            }

            await this.clearCache();

            const sanitizedDirName = this.generateDirName(filename);
            this.currentBookName = filename;
            this.currentBookDir = sanitizedDirName;
            this.totalChapters = total;
            this.receivedChapters = startFrom;
            this.pendingChapterMetas = [];
            this.lindexContent = null;
            this.syncedChapterIndices = new Set();

            this.callback({ msg: "start", total, filename: filename });
            
            try {
                await runAsyncFunc(file.access, { uri: this.baseUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: this.baseUri, recursive: true });
            }

            const bookUri = this.baseUri + this.currentBookDir;
            const bookInfoUri = bookUri + '/book_info.json';
            const lindexUri = bookUri + '/lindex.txt';
            const indexesUri = bookUri + '/indexes';
            const contentUri = bookUri + '/content';
            
            let coverFileName = null;
            if (hasCover) {
                coverFileName = this.generateCoverFileName();
            }

            let isNewBook = true;
            try {
                await runAsyncFunc(file.access, { uri: bookUri });
                isNewBook = false;
            } catch(e) {}

            if (startFrom === 0 && !isNewBook) {
                
                try {
                    await this.rebuildSyncedIndices();
                    this.lindexContent = `${total}\n${this.receivedChapters}\n`;
                    const numChunks = Math.ceil(total / this.CHAPTERS_PER_FILE);
                    for (let i = 0; i < numChunks; i++) {
                        const start = i * this.CHAPTERS_PER_FILE;
                        const end = Math.min(start + this.CHAPTERS_PER_FILE - 1, total - 1);
                        this.lindexContent += `${start},${end}\n`;
                    }
                    try { await runAsyncFunc(file.delete, { uri: lindexUri }); } catch(e) {}
                    await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
                    const bookshelf = await bookStorage.getBooks();
                    const existingBookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
                    let oldCoverFileName = null;
                    if (existingBookIndex > -1) {
                        oldCoverFileName = bookshelf[existingBookIndex].coverFileName;
                    } else {
                        try {
                            const oldInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                            const oldInfo = JSON.parse(oldInfoData.text);
                            oldCoverFileName = oldInfo.coverFileName;
                        } catch(e) {}
                    }

                    if (!hasCover && oldCoverFileName) {
                        coverFileName = oldCoverFileName;
                        hasCover = true;
                    }

                    const newBookEntry = {
                        name: filename,
                        dirName: this.currentBookDir,
                        chapterCount: total,
                        wordCount: wordCount,
                        hasCover: hasCover,
                        coverFileName: coverFileName,
                        progress: existingBookIndex > -1 ? bookshelf[existingBookIndex].progress : { chapterIndex: null, offsetInChapter: 0, scrollOffset: 0, bookmarks: [] },
                        localCategory: localCategory || (existingBookIndex > -1 ? bookshelf[existingBookIndex].localCategory : null)
                    };

                    if (existingBookIndex > -1) {
                        bookshelf[existingBookIndex] = newBookEntry;
                    } else {
                        bookshelf.push(newBookEntry);
                    }
                    await bookStorage.updateBooks(bookshelf);

                } catch (e) {
                    
                    isNewBook = true;
                }
            }

            if (isNewBook) {
                let existingProgress = null;
                
                const bookshelf = await bookStorage.getBooks();
                const existingBook = bookshelf.find(b => b.dirName === this.currentBookDir);
                if (existingBook) {
                    existingProgress = existingBook.progress;
                }

                try { await runAsyncFunc(file.rmdir, { uri: bookUri, recursive: true }); } catch (e) {}
                await runAsyncFunc(file.mkdir, { uri: bookUri });
                
                await runAsyncFunc(file.mkdir, { uri: indexesUri });
                const numChunks = Math.ceil(total / this.CHAPTERS_PER_FILE);
                this.lindexContent = `${total}\n0\n`;
                for (let i = 0; i < numChunks; i++) {
                    const start = i * this.CHAPTERS_PER_FILE;
                    const end = Math.min(start + this.CHAPTERS_PER_FILE - 1, total - 1);
                    this.lindexContent += `${start},${end}\n`;
                }
                
                await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
                
                this.syncedChapterIndices = new Set();

                const bookshelfAfterClear = await bookStorage.getBooks();
                const currentBookIndex = bookshelfAfterClear.findIndex(b => b.dirName === this.currentBookDir);
                if (currentBookIndex > -1) {
                    bookshelfAfterClear.splice(currentBookIndex, 1);
                }
                const newBookEntry = {
                    name: filename,
                    dirName: this.currentBookDir,
                    chapterCount: total,
                    wordCount: wordCount,
                    hasCover: hasCover,
                    coverFileName: coverFileName,
                    progress: existingProgress || { chapterIndex: null, offsetInChapter: 0, scrollOffset: 0, bookmarks: [] },
                    localCategory: localCategory
                };
                bookshelfAfterClear.push(newBookEntry);
                await bookStorage.updateBooks(bookshelfAfterClear);
            } else if (startFrom > 0) {
                
                try {
                    const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                    const bookInfo = JSON.parse(bookInfoData.text);
                    if (bookInfo.coverFileName) {
                        coverFileName = bookInfo.coverFileName;
                    }
                    if (bookInfo.hasCover && !hasCover) {
                        hasCover = true;
                    }

                    await this.rebuildSyncedIndices();

                    const lindexData = await runAsyncFunc(file.readText, { uri: lindexUri });
                    let lines = lindexData.text.split('\n');
                    lines[0] = total.toString();
                    lines[1] = this.receivedChapters.toString();
                    this.lindexContent = lines.join('\n');
                    
                    try { await runAsyncFunc(file.delete, { uri: lindexUri }); } catch (e) {}
                    await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });

                } catch (e) {
                    
                    return this.startTransfer({ filename, total, wordCount, startFrom: 0, hasCover, author, summary, bookStatus, category, localCategory });
                }
            }
            
            try {
                await runAsyncFunc(file.access, { uri: contentUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: contentUri });
            }
            
            if (hasCover && coverFileName) {
                this.currentBookCoverUri = bookUri + '/' + coverFileName;
            }

            const bookInfo = { 
                name: filename, 
                chapterCount: total, 
                wordCount: wordCount, 
                hasCover: hasCover,
                coverFileName: coverFileName,
                author: author,
                summary: summary,
                bookStatus: bookStatus,
                category: category,
                localCategory: localCategory
            };
            try { await runAsyncFunc(file.delete, { uri: bookInfoUri }); } catch(e) {}
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            
            this.send({ type: "ready", count: startFrom, usage: await this.getUsage() });
        } catch (error) {
            const errorMsg = error.message || '未知错误';
            let displayMsg = `开始传输失败: ${errorMsg}`;
            
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            
            this.send({ type: "error", message: displayMsg, count: 0 });
            this.callback({ msg: "error", error: displayMsg });
        }
    }

    async saveCoverChunk({ chunkIndex, totalChunks, data }) {
        try {
            if (!this.currentBookCoverUri) {
                this.send({ type: "error", message: "封面传输未初始化", count: 0 });
                return;
            }
            if (chunkIndex === 0) {
                try {
                    await runAsyncFunc(file.access, { uri: this.currentBookCoverUri });
                    
                    await runAsyncFunc(file.delete, { uri: this.currentBookCoverUri });
                } catch (e) {
                    
                }
            }
            
            const coverBytes = this.base64ToArrayBuffer(data);
            if (coverBytes.byteLength > 0) {
                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: this.currentBookCoverUri,
                    buffer: new Uint8Array(coverBytes),
                    append: chunkIndex > 0,
                });
            }
            await this.send({ type: "cover_chunk_received" });
        } catch (error) {
            const errorMsg = error.message || '未知错误';
            let displayMsg = `保存封面分块失败: ${errorMsg}`;
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            this.send({ type: "error", message: displayMsg, count: 0 });
            this.callback({ msg: "error", error: displayMsg });
        }
    }

    async completeCoverTransfer() {
        try {
            if (!this.currentBookCoverUri) {
                this.send({ type: "error", message: "没有封面数据可保存", count: 0 });
                return;
            }
            
            this.currentBookCoverUri = null;
        
            this.send({ type: "cover_saved" });
            
            if (this.isCoverOnly) {
                this.callback({ msg: "success" });
                this.currentBookName = "";
                this.currentBookDir = "";
            }

            global.runGC();
        } catch (error) {
            this.currentBookCoverUri = null;
            const errorMsg = error.message || '未知错误';
            let displayMsg = `完成封面传输失败: ${errorMsg}`;
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            this.send({ type: "error", message: displayMsg, count: 0 });
            this.callback({ msg: "error", error: displayMsg });
        }
    }

    async updateBookInfo({ filename, author, summary, bookStatus, category, localCategory }) {
        try {
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "文件名为空或无效", count: 0 });
                return;
            }

            const sanitizedDirName = this.generateDirName(filename);
            const bookUri = this.baseUri + sanitizedDirName;
            const bookInfoUri = bookUri + '/book_info.json';
            try {
                await runAsyncFunc(file.access, { uri: bookUri });
            } catch (e) {
                this.send({ type: "error", message: "书籍不存在", count: 0 });
                return;
            }
            let bookInfo = {};
            try {
                const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                bookInfo = JSON.parse(bookInfoData.text);
            } catch (e) {
                
            }
            if (author !== null && author !== undefined) {
                bookInfo.author = author;
            }
            if (summary !== null && summary !== undefined) {
                bookInfo.summary = summary;
            }
            if (bookStatus !== null && bookStatus !== undefined) {
                bookInfo.bookStatus = bookStatus;
            }
            if (category !== null && category !== undefined) {
                bookInfo.category = category;
            }
            if (localCategory !== undefined) {
                bookInfo.localCategory = localCategory;
            }
            if ((!bookInfo.localCategory || bookInfo.localCategory === '') && bookInfo.category) {
                bookInfo.localCategory = bookInfo.category;
            }
            try {
                await runAsyncFunc(file.delete, { uri: bookInfoUri });
            } catch (e) {
                
            }
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            try {
                const allBooks = await bookStorage.getBooks();
                const bookIndex = allBooks.findIndex(b => b.dirName === sanitizedDirName);
                if (bookIndex !== -1) {
                    allBooks[bookIndex].localCategory = bookInfo.localCategory || null;
                    await bookStorage.updateBooks(allBooks);
                }
            } catch (e) {
                console.error('Failed to update bookshelf.json:', e);
            }

            this.send({ type: "book_info_updated" });
            this.callback({ msg: "book_info_updated", filename: filename });
        } catch (error) {
            const errorMsg = error.message || '未知错误';
            let displayMsg = `更新书籍信息失败: ${errorMsg}`;
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            this.send({ type: "error", message: displayMsg, count: 0 });
            this.callback({ msg: "error", error: displayMsg });
        }
    }

    base64ToArrayBuffer(base64) {
        base64 = base64.replace(/[\s\r\n]/g, '');
        const b64lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const len = base64.length;
        let paddingCount = 0;
        if (base64.charAt(len - 1) === '=') paddingCount++;
        if (base64.charAt(len - 2) === '=') paddingCount++;
        
        const bufferLength = (len * 3 / 4) - paddingCount;
        const arraybuffer = new ArrayBuffer(bufferLength);
        const bytes = new Uint8Array(arraybuffer);
        
        let p = 0;
        for (let i = 0; i < len; i += 4) {
            const encoded1 = b64lookup.indexOf(base64.charAt(i));
            const encoded2 = b64lookup.indexOf(base64.charAt(i + 1));
            const encoded3 = b64lookup.indexOf(base64.charAt(i + 2));
            const encoded4 = b64lookup.indexOf(base64.charAt(i + 3));
            if (encoded1 === -1 || encoded2 === -1) {
                continue;
            }
            if (p < bufferLength) {
                bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
            }
            if (encoded3 !== -1 && encoded3 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
            }
            if (encoded4 !== -1 && encoded4 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
            }
        }
        
        return arraybuffer;
    }

    _strToUtf8Ab(str) {
        var s = unescape(encodeURIComponent(str));
        var b = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) {
            b[i] = s.charCodeAt(i);
        }
        return b;
    }

    async saveChapter(payload) {
        try {
            const { count, data } = payload;
            let chapterData = JSON.parse(data);

            const isFirstChunk = chapterData.chunkNum === 0;
            const isLastChunk = chapterData.chunkNum === chapterData.totalChunks - 1;
            const chapterFileName = `${chapterData.index}.txt`;
            const chapterUri = `${this.baseUri}${this.currentBookDir}/content/${chapterFileName}`;

            const buffer = str2abWrite(chapterData.content);

            if (isFirstChunk) {
                this.currentSavingChapterIndex = chapterData.index;

                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: chapterUri,
                    buffer: buffer,
                    append: false,
                });
            } else {
                if (this.currentSavingChapterIndex !== chapterData.index) {
                    this.send({ type: "error", message: "章节分块索引不匹配", count: this.receivedChapters });
                    chapterData = null;
                    return;
                }
                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: chapterUri,
                    buffer: buffer,
                    append: true,
                });
            }
            
            const chunkProgress = (chapterData.chunkNum + 1) / chapterData.totalChunks;
            const overallProgress = (count + chunkProgress) / (this.totalChapters);
            this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

            if (isLastChunk) {
                this.currentChapterMeta = {
                    index: chapterData.index,
                    name: chapterData.name,
                    wordCount: chapterData.wordCount
                };

                await this.send({ type: "chapter_chunk_complete" });
                
                if(count % 10 == 0) global.runGC();
            } else {
                await this.send({ type: "next_chunk" });
            }
            chapterData = null;
        } catch (error) {
            const errorMsg = error.message || '未知错误';
            let displayMsg = `保存章节失败: ${errorMsg}`;
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            this.send({ type: "error", message: displayMsg, count: this.receivedChapters });
            this.callback({ msg: "error", progress: displayMsg });
        }
    }

    async completeChapterTransfer(payload) {
        try {
            const { count } = payload;
            
            if (!this.currentChapterMeta) {
                this.send({ type: "error", message: "No chapter data to complete", count: this.receivedChapters });
                return;
            }
            
            this.pendingChapterMetas.push(this.currentChapterMeta);
            
            this.currentChapterMeta = null;
            this.currentSavingChapterIndex = -1;
            this.syncedChapterIndices.add(count);
            this.receivedChapters = this.syncedChapterIndices.size;
            
            const shouldFlush = (this.pendingChapterMetas.length >= this.BATCH_WRITE_SIZE) || 
                               (this.receivedChapters >= this.totalChapters);
            
            if (shouldFlush) {
                await this.flushPendingChapterMetas();
            }
            
            const progressPercent = (this.receivedChapters / this.totalChapters) * 100;
            
            await this.send({ 
                type: "chapter_saved", 
                count: this.receivedChapters,
                syncedCount: this.receivedChapters,
                totalCount: this.totalChapters,
                progress: progressPercent
            });
            
        } catch (error) {
            const errorMsg = error.message || '未知错误';
            let displayMsg = `完成章节传输失败: ${errorMsg}`;
            if (errorMsg.includes('space') || errorMsg.includes('disk') || errorMsg.includes('full') || 
                errorMsg.includes('storage') || errorMsg.includes('1300')) {
                displayMsg = "存储空间不足";
            }
            this.send({ type: "error", message: displayMsg, count: this.receivedChapters });
            this.callback({ msg: "error", error: displayMsg });
        }
    }
    
    async flushPendingChapterMetas() {
        if (this.pendingChapterMetas.length === 0) return;

        const metasByChunk = new Map();
        for (const meta of this.pendingChapterMetas) {
            const chunkIndex = Math.floor(meta.index / this.CHAPTERS_PER_FILE) + 1;
            if (!metasByChunk.has(chunkIndex)) {
                metasByChunk.set(chunkIndex, []);
            }
            metasByChunk.get(chunkIndex).push(meta);
        }

        try {
            for (const [chunkIndex, metas] of metasByChunk.entries()) {
                const chunkUri = `${this.baseUri}${this.currentBookDir}/indexes/${chunkIndex}.txt`;
                
                const metaLines = metas.map(meta => `${meta.index}\t${meta.name}\t${meta.wordCount || 0}`).join('\n') + '\n';
                const newBuffer = this._strToUtf8Ab(metaLines);

                let existingBuffer = new Uint8Array(0);
                try {
                    const existingData = await runAsyncFunc(file.readArrayBuffer, { uri: chunkUri });
                    existingBuffer = new Uint8Array(existingData.buffer);
                } catch (e) {
                }

                const finalBuffer = new Uint8Array(existingBuffer.length + newBuffer.length);
                finalBuffer.set(existingBuffer, 0);
                finalBuffer.set(newBuffer, existingBuffer.length);
                try {
                    await runAsyncFunc(file.delete, { uri: chunkUri });
                } catch (e) {
                }
                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: chunkUri,
                    buffer: finalBuffer,
                    append: false,
                });
            }

            const lindexUri = `${this.baseUri}${this.currentBookDir}/lindex.txt`;
            try {
                
                let lines;
                if (this.lindexContent) {
                    lines = this.lindexContent.split('\n');
                } else {
                    const lindexData = await runAsyncFunc(file.readText, { uri: lindexUri });
                    lines = lindexData.text.split('\n');
                }
                let currentSynced = parseInt(lines[1], 10) || 0;
                currentSynced += this.pendingChapterMetas.length;
                
                lines[0] = this.totalChapters.toString();
                lines[1] = currentSynced.toString();
                this.lindexContent = lines.join('\n');
                try {
                    await runAsyncFunc(file.delete, { uri: lindexUri });
                } catch (e) {}
                await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
            } catch (e) {
            }

            this.pendingChapterMetas = [];
        } catch (error) {
            throw error;
        }
    }

    async handleTransferComplete() {
        try {
            if (this.pendingChapterMetas.length > 0) {
                await this.flushPendingChapterMetas();
            }
            
            await this.clearCache();
            
            this.currentBookCoverUri = null;
            this.currentSavingChapterIndex = -1;
            this.currentChapterMeta = null;
            this.pendingChapterMetas = [];
            this.currentBookName = "";
            this.currentBookDir = "";
            this.lindexContent = null;
            
            global.runGC();
            
            this.send({ type: "transfer_finished" });
            
            this.callback({ msg: "success" });
        } catch (error) {
            this.send({ type: "error", message: `Handle transfer complete failed: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    async getReadingData({ filename }) {
        try {
            const bookStorage = require('../utils/bookStorage.js').default;
            const readingTimeStorage = require('../utils/readingTimeStorage.js').default;
            
            const sanitizedDirName = this.generateDirName(filename);
            let progress = null;
            let readingTime = null;
            
            try {
                const progressData = await bookStorage.get(sanitizedDirName);
                if (progressData) {
                    progress = JSON.stringify(progressData);
                }
            } catch (e) {
            }
            try {
                let readingTimeData = await readingTimeStorage.getReadingTime(sanitizedDirName);
                if (!readingTimeData) {
                    
                    readingTimeData = await readingTimeStorage.getReadingTime(filename);
                }
                if (readingTimeData) {
                    readingTime = JSON.stringify(readingTimeData);
                } else {
                    console.log(`No reading time found for filename: ${filename}, sanitizedDirName: ${sanitizedDirName}`);
                }
            } catch (e) {
                console.error('Error getting reading time:', e);
            }
            
            this.send({
                type: "reading_data",
                progress: progress,
                readingTime: readingTime
            });
        } catch (error) {
            this.send({
                type: "reading_data",
                progress: null,
                readingTime: null
            });
        }
    }

    async setReadingData({ filename, progress, readingTime }) {
        try {
            const bookStorage = require('../utils/bookStorage.js').default;
            const readingTimeStorage = require('../utils/readingTimeStorage.js').default;
            
            const sanitizedDirName = this.generateDirName(filename);
            
            if (progress) {
                try {
                    let progressData = JSON.parse(progress);
                    if (progressData && typeof progressData.offsetInChapter !== 'undefined') {
                        let o = progressData.offsetInChapter;
                        if (typeof o === 'string') {
                            o = parseInt(o, 10);
                        }
                        if (typeof o === 'number' && !isNaN(o)) {
                            o = Math.max(0, Math.floor(o));
                            if (o % 2 === 1) o = Math.max(0, o - 1);
                            progressData.offsetInChapter = o;
                        } else {
                            progressData.offsetInChapter = 0;
                        }
                    }
                    await bookStorage.set(sanitizedDirName, progressData);
                } catch (e) {
                }
            }
            if (readingTime) {
                try {
                    const readingTimeData = JSON.parse(readingTime);
                    const allReadingTime = await readingTimeStorage.getAllBooksReadingTime();
                    allReadingTime[sanitizedDirName] = readingTimeData;
                    await readingTimeStorage.saveReadingTime(allReadingTime);
                } catch (e) {
                    console.error('Failed to save reading time:', e);
                }
            }
            
            this.send({ type: "success", message: "阅读数据已同步", count: 0 });
        } catch (error) {
            this.send({ type: "error", message: `同步阅读数据失败: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    async setBatchReadingData({ books }) {
        try {
            const bookStorage = require('../utils/bookStorage.js').default;
            const readingTimeStorage = require('../utils/readingTimeStorage.js').default;
            
            let successCount = 0;
            let errorCount = 0;
            
            for (const book of books) {
                try {
                    const sanitizedDirName = this.generateDirName(book.filename);
                    
                    if (book.progress) {
                        try {
                            const progressData = JSON.parse(book.progress);
                            await bookStorage.set(sanitizedDirName, progressData);
                        } catch (e) {
                            console.error(`Failed to parse progress for ${book.filename}:`, e);
                        }
                    }
                    if (book.readingTime) {
                        try {
                            const readingTimeData = JSON.parse(book.readingTime);
                            const allReadingTime = await readingTimeStorage.getAllBooksReadingTime();
                            allReadingTime[sanitizedDirName] = readingTimeData;
                            await readingTimeStorage.saveReadingTime(allReadingTime);
                        } catch (e) {
                            console.error(`Failed to save reading time for ${book.filename}:`, e);
                        }
                    }
                    
                    successCount++;
                } catch (error) {
                    console.error(`Failed to sync ${book.filename}:`, error);
                    errorCount++;
                }
            }
            
            this.send({ 
                type: "success", 
                message: `批量同步完成：成功 ${successCount} 本${errorCount > 0 ? `，失败 ${errorCount} 本` : ''}`, 
                count: 0 
            });
        } catch (error) {
            this.send({ type: "error", message: `批量同步阅读数据失败: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    async deleteChapters({ filename, chapterIndices }) {
        try {
            const chapterManager = require('../utils/chapterManager.js').default;
            const sanitizedDirName = this.generateDirName(filename);
            
            if (!Array.isArray(chapterIndices) || chapterIndices.length === 0) {
                this.send({ type: "error", message: "无效的章节索引列表", count: 0 });
                return;
            }

            let successCount = 0;
            let errorCount = 0;
            const total = chapterIndices.length;

            for (let i = 0; i < chapterIndices.length; i++) {
                const chapterIndex = chapterIndices[i];
                try {
                    await chapterManager.deleteChapter(sanitizedDirName, chapterIndex);
                    successCount++;
                    
                    const progress = Math.floor(((i + 1) / total) * 100);
                    this.send({ 
                        type: "progress", 
                        message: `正在删除章节 ${i + 1}/${total}`, 
                        count: progress 
                    });
                } catch (error) {
                    errorCount++;
                    console.error(`Failed to delete chapter ${chapterIndex}:`, error);
                }
            }

            if (errorCount === 0) {
                this.send({ 
                    type: "success", 
                    message: `成功删除 ${successCount} 个章节`, 
                    count: successCount 
                });
            } else {
                this.send({ 
                    type: "error", 
                    message: `删除完成：成功 ${successCount} 个，失败 ${errorCount} 个`, 
                    count: successCount 
                });
            }
        } catch (error) {
            this.send({ 
                type: "error", 
                message: `删除章节失败: ${error.message || 'unknown error'}`, 
                count: 0 
            });
        }
    }

    async getStorageInfo() {
        try {
            const { calculateStorageInfo } = require('../utils/storageUtils.js');
            
            const deviceInfo = await new Promise((resolve, reject) => {
                device.getInfo({
                    success: resolve,
                    fail: reject
                });
            });
            
            const deviceProduct = deviceInfo ? deviceInfo.product : null;
            
            const totalData = await new Promise((resolve, reject) => {
                device.getTotalStorage({
                    success: resolve,
                    fail: reject
                });
            });
            
            const totalStorage = totalData && totalData.totalStorage ? totalData.totalStorage : 0;
            
            const availData = await new Promise((resolve, reject) => {
                device.getAvailableStorage({
                    success: resolve,
                    fail: reject
                });
            });
            
            const availableStorage = availData && availData.availableStorage ? availData.availableStorage : 0;
            const storageInfo = calculateStorageInfo(totalStorage, availableStorage, deviceProduct);
            
            this.send({
                type: "storage_info",
                product: deviceProduct,
                totalStorage: storageInfo.totalStorage,
                availableStorage: storageInfo.availableStorage,
                reservedStorage: storageInfo.reservedStorage,
                usedStorage: storageInfo.usedStorage,
                actualAvailable: storageInfo.actualAvailable
            });
        } catch (error) {
            this.send({
                type: "storage_info",
                product: null,
                totalStorage: 0,
                availableStorage: 0,
                reservedStorage: 0,
                usedStorage: 0,
                actualAvailable: 0
            });
        }
    }

    setCallback(callback) {
        this.callback = callback;
    }
    callback(msg) {  }
}
