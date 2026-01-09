import file from "@system.file";
import device from "@system.device";
import runAsyncFunc from "./runAsyncFunc";
import str2abWrite from "./str2abWrite";
import bookStorage from '../utils/bookStorage.js';
import readingTimeStorage from '../utils/readingTimeStorage.js';
import chapterManager from '../utils/chapterManager.js';
import { calculateStorageInfo } from '../utils/storageUtils.js';

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
    currentBookCoverUri = null;

    pendingChapterMetas = [];
    BATCH_WRITE_SIZE = 10;
    CHAPTERS_PER_FILE = 100;
    lindexContent = null;

    constructor({ addListener, send, setEventListener }) {
        this.send = send;
        const onmessage = async (data) => {
            const { stat, ...payload } = data;
            switch (stat) {
                case "startTransfer":
                    this.isCoverOnly = false;
                    await this.startTransfer(payload);
                    break;
                case "start_cover_transfer":
                    this.isCoverOnly = true;
                    await this.startCoverTransfer(payload);
                    break;
                case "d":
                    await this.saveChapter(payload);
                    break;
                case "chapter_complete":
                    await this.completeChapterTransfer(payload);
                    break;
                case "transfer_complete":
                    await this.handleTransferComplete();
                    break;
                case "cancel":
                    await this.handleCancel();
                    break;
                case "get_book_status":
                    await this.getBookStatus(payload);
                    break;
                case "cover_chunk":
                    await this.saveCoverChunk(payload);
                    break;
                case "cover_transfer_complete":
                    await this.completeCoverTransfer();
                    break;
                case "update_book_info":
                    await this.updateBookInfo(payload);
                    break;
                case "get_reading_data":
                    await this.getReadingData(payload);
                    break;
                case "set_reading_data":
                    await this.setReadingData(payload);
                    break;
                case "set_batch_reading_data":
                    await this.setBatchReadingData(payload);
                    break;
                case "delete_chapters":
                    await this.deleteChapters(payload);
                    break;
                case "get_storage_info":
                    await this.getStorageInfo();
                    break;
            }
        };
        addListener(onmessage);
        
        setEventListener((event) => {
            if (event !== 'open') {
                if (this.pendingChapterMetas.length > 0) {
                    this.flushPendingChapterMetas().catch(() => {});
                }
                this.resetState();
                this.callback({ msg: "error", error: event, filename: this.currentBookName });
            }
        });
    }

    resetState() {
        this.currentBookName = "";
        this.currentBookDir = "";
        this.lindexContent = null;
        this.pendingChapterMetas = [];
        this.currentBookCoverUri = null;
        this.currentChapterMeta = null;
        this.currentSavingChapterIndex = -1;
    }

    async handleCancel() {
        if (this.pendingChapterMetas.length > 0) {
            await this.flushPendingChapterMetas().catch(() => {});
        }
        this.send({ type: "cancel" });
        this.resetState();
        this.callback({ msg: "cancel" });
    }

    async ensureDir(uri) {
        try {
            await runAsyncFunc(file.access, { uri });
        } catch (e) {
            await runAsyncFunc(file.mkdir, { uri, recursive: true });
        }
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
                    } catch (e) {}
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
            await runAsyncFunc(file.delete, { uri: this.baseUri + 'temp_cover.jpg' });
        } catch (e) {}
    }

    generateDirName(filename) {
        let hash = 0;
        if (!filename || filename.length === 0) return '00000000';
        for (let i = 0; i < filename.length; i++) {
            hash = ((hash << 5) - hash) + filename.charCodeAt(i);
            hash = hash & hash;
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    generateCoverFileName() {
        return `cover_${Math.random().toString(36).substring(2, 10)}.jpg`;
    }

    async getBookStatus({ filename }) {
        try {
            await runAsyncFunc(file.access, { uri: this.baseUri });
        } catch (e) {
            this.send({ type: "book_status", syncedChapters: [], hasCover: false });
            return;
        }

        const sanitizedDirName = this.generateDirName(filename);
        const bookDir = `${this.baseUri}${sanitizedDirName}`;
        let syncedChapterIndices = [];
        let hasCover = false;

        try {
            const lindexData = await runAsyncFunc(file.readText, { uri: `${bookDir}/lindex.txt` });
            const totalChapters = parseInt(lindexData.text.split('\n')[0], 10);
            
            if (!isNaN(totalChapters)) {
                const numChunks = Math.ceil(totalChapters / this.CHAPTERS_PER_FILE);
                const indexSet = new Set();
                const indexesDirUri = `${bookDir}/indexes/`;

                for (let i = 1; i <= numChunks; i++) {
                    try {
                        const chunkData = await runAsyncFunc(file.readText, { uri: `${indexesDirUri}${i}.txt` });
                        chunkData.text.split('\n').forEach(line => {
                            if (!line) return;
                            const idx = parseInt(line.split('\t')[0], 10);
                            if (!isNaN(idx)) indexSet.add(idx);
                        });
                    } catch(e) {}
                }
                syncedChapterIndices = Array.from(indexSet);
            }
        } catch (e) {}

        try {
            const bookInfoData = await runAsyncFunc(file.readText, { uri: `${bookDir}/book_info.json` });
            const bookInfo = JSON.parse(bookInfoData.text);
            if (bookInfo.coverFileName) {
                await runAsyncFunc(file.access, { uri: `${bookDir}/${bookInfo.coverFileName}` });
                hasCover = true;
            }
        } catch (e) {
            hasCover = false;
        }

        this.send({ type: "book_status", syncedChapters: syncedChapterIndices, hasCover });
    }
    
    async startCoverTransfer({ filename }) {
        try {
            if (!filename || !filename.trim()) {
                throw new Error("Filename is empty.");
            }
            this.currentBookName = filename;
            this.currentBookDir = this.generateDirName(filename);
            await this.ensureDir(this.baseUri);
            
            const bookUri = this.baseUri + this.currentBookDir;
            await this.ensureDir(bookUri);
            
            const bookInfoUri = bookUri + '/book_info.json';
            let bookInfo = {};
            try {
                const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                bookInfo = JSON.parse(bookInfoData.text);
                if (bookInfo.coverFileName) {
                    await runAsyncFunc(file.delete, { uri: bookUri + '/' + bookInfo.coverFileName }).catch(()=>{});
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
            this.send({ type: "error", message: `Start cover transfer failed: ${error.message}`, count: 0 });
        }
    }

    async rebuildSyncedIndices() {
        this.syncedChapterIndices.clear();
        const indexesDirUri = `${this.baseUri}${this.currentBookDir}/indexes/`;
        try {
             const { fileList } = await runAsyncFunc(file.list, { uri: indexesDirUri });
             if (fileList) {
                 for (const f of fileList) {
                     if (!f.uri.endsWith('.txt')) continue;
                     try {
                         const text = await runAsyncFunc(file.readText, { uri: f.uri });
                         text.text.split('\n').forEach(line => {
                             if (!line.trim()) return;
                             const index = parseInt(line.split('\t')[0], 10);
                             if (!isNaN(index)) this.syncedChapterIndices.add(index);
                         });
                     } catch(e) {}
                 }
             }
        } catch (e) {}
        this.receivedChapters = this.syncedChapterIndices.size;
    }

    async startTransfer({ filename, total, wordCount, startFrom = 0, hasCover = false, author, summary, bookStatus, category, localCategory }) {
        try {
            if (!filename || !filename.trim()) throw new Error("文件名为空或无效");

            await this.clearCache();

            this.currentBookName = filename;
            this.currentBookDir = this.generateDirName(filename);
            this.totalChapters = total;
            this.receivedChapters = startFrom;
            this.pendingChapterMetas = [];
            this.lindexContent = null;
            this.syncedChapterIndices.clear();

            this.callback({ msg: "start", total, filename });
            await this.ensureDir(this.baseUri);

            const bookUri = this.baseUri + this.currentBookDir;
            const bookInfoUri = bookUri + '/book_info.json';
            const lindexUri = bookUri + '/lindex.txt';
            
            let coverFileName = hasCover ? this.generateCoverFileName() : null;

            let isNewBook = true;
            try {
                await runAsyncFunc(file.access, { uri: bookUri });
                isNewBook = false;
            } catch(e) {}

            if (startFrom === 0 && !isNewBook) {
                try {
                    await this.rebuildSyncedIndices();
                    this.lindexContent = this.generateLindexContent(total, this.receivedChapters);
                    
                    await runAsyncFunc(file.delete, { uri: lindexUri }).catch(()=>{});
                    await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
                    
                    const bookshelf = await bookStorage.getBooks();
                    const existingBookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
                    
                    let oldCoverFileName = null;
                    if (existingBookIndex > -1) {
                        oldCoverFileName = bookshelf[existingBookIndex].coverFileName;
                    } else {
                        try {
                            const oldInfo = JSON.parse((await runAsyncFunc(file.readText, { uri: bookInfoUri })).text);
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
                        progress: existingBookIndex > -1 ? bookshelf[existingBookIndex].progress : {},
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
                if (existingBook) existingProgress = existingBook.progress;

                await runAsyncFunc(file.rmdir, { uri: bookUri, recursive: true }).catch(()=>{});
                await runAsyncFunc(file.mkdir, { uri: bookUri });
                await runAsyncFunc(file.mkdir, { uri: bookUri + '/indexes' });
                
                this.lindexContent = this.generateLindexContent(total, 0);
                await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
                
                this.syncedChapterIndices.clear();

                const bookshelfAfterClear = bookshelf.filter(b => b.dirName !== this.currentBookDir);
                bookshelfAfterClear.push({
                    name: filename,
                    dirName: this.currentBookDir,
                    chapterCount: total,
                    wordCount: wordCount,
                    hasCover: hasCover,
                    coverFileName: coverFileName,
                    progress: existingProgress || {},
                    localCategory: localCategory
                });
                await bookStorage.updateBooks(bookshelfAfterClear);
            } else if (startFrom > 0) {
                try {
                    const bookInfo = JSON.parse((await runAsyncFunc(file.readText, { uri: bookInfoUri })).text);
                    if (bookInfo.coverFileName) coverFileName = bookInfo.coverFileName;
                    if (bookInfo.hasCover && !hasCover) hasCover = true;

                    await this.rebuildSyncedIndices();

                    const lindexData = await runAsyncFunc(file.readText, { uri: lindexUri });
                    let lines = lindexData.text.split('\n');
                    lines[0] = total.toString();
                    lines[1] = this.receivedChapters.toString();
                    this.lindexContent = lines.join('\n');
                    
                    await runAsyncFunc(file.delete, { uri: lindexUri }).catch(()=>{});
                    await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });

                } catch (e) {
                    return this.startTransfer({ filename, total, wordCount, startFrom: 0, hasCover, author, summary, bookStatus, category, localCategory });
                }
            }
            
            await this.ensureDir(bookUri + '/content');
            
            if (hasCover && coverFileName) {
                this.currentBookCoverUri = bookUri + '/' + coverFileName;
            }

            const bookInfo = { 
                name: filename, 
                chapterCount: total, 
                wordCount, 
                hasCover,
                coverFileName,
                author,
                summary,
                bookStatus,
                category,
                localCategory
            };
            await runAsyncFunc(file.delete, { uri: bookInfoUri }).catch(()=>{});
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            
            this.send({ type: "ready", count: startFrom, usage: await this.getUsage() });
        } catch (error) {
            this.handleError(error, "开始传输失败");
        }
    }

    generateLindexContent(total, received) {
        let content = `${total}\n${received}\n`;
        const numChunks = Math.ceil(total / this.CHAPTERS_PER_FILE);
        for (let i = 0; i < numChunks; i++) {
            const start = i * this.CHAPTERS_PER_FILE;
            const end = Math.min(start + this.CHAPTERS_PER_FILE - 1, total - 1);
            content += `${start},${end}\n`;
        }
        return content;
    }

    handleError(error, context) {
        const errorMsg = error.message || '未知错误';
        let displayMsg = `${context}: ${errorMsg}`;
        if (errorMsg.match(/space|disk|full|storage|1300/i)) {
            displayMsg = "存储空间不足";
        }
        this.send({ type: "error", message: displayMsg, count: 0 });
        this.callback({ msg: "error", error: displayMsg });
    }

    async saveCoverChunk({ chunkIndex, data }) {
        try {
            if (!this.currentBookCoverUri) {
                throw new Error("封面传输未初始化");
            }
            if (chunkIndex === 0) {
                await runAsyncFunc(file.delete, { uri: this.currentBookCoverUri }).catch(()=>{});
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
            this.handleError(error, "保存封面分块失败");
        }
    }

    async completeCoverTransfer() {
        try {
            if (!this.currentBookCoverUri) throw new Error("没有封面数据");
            this.currentBookCoverUri = null;
            this.send({ type: "cover_saved" });
            
            if (this.isCoverOnly) {
                this.callback({ msg: "success" });
                this.resetState();
            }
            global.runGC();
        } catch (error) {
            this.currentBookCoverUri = null;
            this.handleError(error, "完成封面传输失败");
        }
    }

    async updateBookInfo({ filename, author, summary, bookStatus, category, localCategory }) {
        try {
            if (!filename || !filename.trim()) throw new Error("文件名无效");

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
                bookInfo = JSON.parse((await runAsyncFunc(file.readText, { uri: bookInfoUri })).text);
            } catch (e) {}

            if (author != null) bookInfo.author = author;
            if (summary != null) bookInfo.summary = summary;
            if (bookStatus != null) bookInfo.bookStatus = bookStatus;
            if (category != null) bookInfo.category = category;
            if (localCategory !== undefined) bookInfo.localCategory = localCategory;
            
            if ((!bookInfo.localCategory) && bookInfo.category) {
                bookInfo.localCategory = bookInfo.category;
            }

            await runAsyncFunc(file.delete, { uri: bookInfoUri }).catch(()=>{});
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });

            try {
                const allBooks = await bookStorage.getBooks();
                const bookIndex = allBooks.findIndex(b => b.dirName === sanitizedDirName);
                if (bookIndex !== -1) {
                    allBooks[bookIndex].localCategory = bookInfo.localCategory || null;
                    await bookStorage.updateBooks(allBooks);
                }
            } catch (e) {}

            this.send({ type: "book_info_updated" });
            this.callback({ msg: "book_info_updated", filename });
        } catch (error) {
            this.handleError(error, "更新书籍信息失败");
        }
    }

    base64ToArrayBuffer(base64) {
        base64 = base64.replace(/[\s\r\n]/g, '');
        const len = base64.length;
        if (len === 0) return new ArrayBuffer(0);
        
        const b64lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let paddingCount = 0;
        if (base64.charAt(len - 1) === '=') paddingCount++;
        if (base64.charAt(len - 2) === '=') paddingCount++;
        
        const bufferLength = (len * 3 / 4) - paddingCount;
        const bytes = new Uint8Array(bufferLength);
        
        let p = 0;
        for (let i = 0; i < len; i += 4) {
            const encoded1 = b64lookup.indexOf(base64[i]);
            const encoded2 = b64lookup.indexOf(base64[i + 1]);
            const encoded3 = b64lookup.indexOf(base64[i + 2]);
            const encoded4 = b64lookup.indexOf(base64[i + 3]);
            
            if (encoded1 < 0 || encoded2 < 0) continue;
            
            bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
            if (encoded3 !== -1 && encoded3 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
            }
            if (encoded4 !== -1 && encoded4 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
            }
        }
        return bytes.buffer;
    }

    async saveChapter(payload) {
        try {
            const { count, data } = payload;
            const chapterData = JSON.parse(data);

            const isFirstChunk = chapterData.chunkNum === 0;
            const isLastChunk = chapterData.chunkNum === chapterData.totalChunks - 1;
            const chapterUri = `${this.baseUri}${this.currentBookDir}/content/${chapterData.index}.txt`;

            const buffer = str2abWrite(chapterData.content);

            if (isFirstChunk) {
                this.currentSavingChapterIndex = chapterData.index;
                await runAsyncFunc(file.writeArrayBuffer, { uri: chapterUri, buffer, append: false });
            } else {
                if (this.currentSavingChapterIndex !== chapterData.index) {
                    this.send({ type: "error", message: "章节分块索引不匹配", count: this.receivedChapters });
                    return;
                }
                await runAsyncFunc(file.writeArrayBuffer, { uri: chapterUri, buffer, append: true });
            }
            
            const overallProgress = (count + ((chapterData.chunkNum + 1) / chapterData.totalChunks)) / this.totalChapters;
            this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

            if (isLastChunk) {
                this.currentChapterMeta = {
                    index: chapterData.index,
                    name: chapterData.name,
                    wordCount: chapterData.wordCount
                };
                await this.send({ type: "chapter_chunk_complete" });
                if(count % 10 === 0) global.runGC();
            } else {
                await this.send({ type: "next_chunk" });
            }
        } catch (error) {
            this.handleError(error, "保存章节失败");
        }
    }

    async completeChapterTransfer({ count }) {
        try {
            if (!this.currentChapterMeta) {
                this.send({ type: "error", message: "无章节数据", count: this.receivedChapters });
                return;
            }
            
            this.pendingChapterMetas.push(this.currentChapterMeta);
            this.currentChapterMeta = null;
            this.currentSavingChapterIndex = -1;
            this.syncedChapterIndices.add(count);
            this.receivedChapters = this.syncedChapterIndices.size;
            
            if (this.pendingChapterMetas.length >= this.BATCH_WRITE_SIZE || this.receivedChapters >= this.totalChapters) {
                await this.flushPendingChapterMetas();
            }
            
            await this.send({ 
                type: "chapter_saved", 
                count: this.receivedChapters,
                syncedCount: this.receivedChapters,
                totalCount: this.totalChapters,
                progress: (this.receivedChapters / this.totalChapters) * 100
            });
        } catch (error) {
            this.handleError(error, "完成章节传输失败");
        }
    }
    
    async flushPendingChapterMetas() {
        if (this.pendingChapterMetas.length === 0) return;

        const metasByChunk = new Map();
        for (const meta of this.pendingChapterMetas) {
            const chunkIndex = Math.floor(meta.index / this.CHAPTERS_PER_FILE) + 1;
            if (!metasByChunk.has(chunkIndex)) metasByChunk.set(chunkIndex, []);
            metasByChunk.get(chunkIndex).push(meta);
        }

        try {
            for (const [chunkIndex, metas] of metasByChunk) {
                const chunkUri = `${this.baseUri}${this.currentBookDir}/indexes/${chunkIndex}.txt`;
                let existingContent = "";
                try {
                    existingContent = (await runAsyncFunc(file.readText, { uri: chunkUri })).text;
                } catch(e) {}

                const existingMap = new Map();
                existingContent.split('\n').forEach(line => {
                    if (!line.trim()) return;
                    const parts = line.split('\t');
                    if (parts.length >= 1) {
                        const idx = parseInt(parts[0], 10);
                        if (!isNaN(idx)) existingMap.set(idx, line);
                    }
                });

                metas.forEach(meta => {
                    existingMap.set(meta.index, `${meta.index}\t${meta.name}\t${meta.wordCount || 0}`);
                });

                const newContent = Array.from(existingMap.keys())
                    .sort((a,b) => a-b)
                    .map(idx => existingMap.get(idx))
                    .join('\n') + '\n';

                await runAsyncFunc(file.delete, { uri: chunkUri }).catch(()=>{});
                await runAsyncFunc(file.writeText, { uri: chunkUri, text: newContent });
            }

            const lindexUri = `${this.baseUri}${this.currentBookDir}/lindex.txt`;
            if (this.lindexContent) {
                const lines = this.lindexContent.split('\n');
                lines[0] = this.totalChapters.toString();
                lines[1] = this.syncedChapterIndices.size.toString();
                this.lindexContent = lines.join('\n');
                
                await runAsyncFunc(file.delete, { uri: lindexUri }).catch(()=>{});
                await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });
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
            this.resetState();
            global.runGC();
            this.send({ type: "transfer_finished" });
            this.callback({ msg: "success" });
        } catch (error) {
            this.send({ type: "error", message: `传输完成处理失败: ${error.message}`, count: 0 });
        }
    }

    async getReadingData({ filename }) {
        try {
            const sanitizedDirName = this.generateDirName(filename);
            let progress = null;
            let readingTime = null;
            
            try {
                const progressData = await bookStorage.get(sanitizedDirName);
                if (progressData) progress = JSON.stringify(progressData);
            } catch (e) {}

            try {
                let readingTimeData = await readingTimeStorage.getReadingTime(sanitizedDirName);
                if (!readingTimeData) readingTimeData = await readingTimeStorage.getReadingTime(filename);
                if (readingTimeData) readingTime = JSON.stringify(readingTimeData);
            } catch (e) {}
            
            this.send({ type: "reading_data", progress, readingTime });
        } catch (error) {
            this.send({ type: "reading_data", progress: null, readingTime: null });
        }
    }

    async setReadingData({ filename, progress, readingTime }) {
        try {
            const sanitizedDirName = this.generateDirName(filename);
            
            if (progress) {
                try {
                    const progressData = JSON.parse(progress);
                    await bookStorage.set(sanitizedDirName, progressData);
                } catch (e) {}
            }
            if (readingTime) {
                try {
                    const readingTimeData = JSON.parse(readingTime);
                    const allReadingTime = await readingTimeStorage.getAllBooksReadingTime();
                    allReadingTime[sanitizedDirName] = readingTimeData;
                    await readingTimeStorage.saveReadingTime(allReadingTime);
                } catch (e) {}
            }
            this.send({ type: "success", message: "阅读数据已同步", count: 0 });
        } catch (error) {
            this.send({ type: "error", message: `同步失败: ${error.message}`, count: 0 });
        }
    }

    async setBatchReadingData({ books }) {
        let successCount = 0;
        let errorCount = 0;
        
        const allReadingTime = await readingTimeStorage.getAllBooksReadingTime();
        let readingTimeUpdated = false;

        for (const book of books) {
            try {
                const sanitizedDirName = this.generateDirName(book.filename);
                if (book.progress) {
                    try {
                        await bookStorage.set(sanitizedDirName, JSON.parse(book.progress));
                    } catch (e) {}
                }
                if (book.readingTime) {
                    try {
                        allReadingTime[sanitizedDirName] = JSON.parse(book.readingTime);
                        readingTimeUpdated = true;
                    } catch (e) {}
                }
                successCount++;
            } catch (error) {
                errorCount++;
            }
        }

        if (readingTimeUpdated) {
            await readingTimeStorage.saveReadingTime(allReadingTime);
        }

        this.send({ 
            type: "success", 
            message: `批量同步完成：成功 ${successCount} 本${errorCount > 0 ? `，失败 ${errorCount} 本` : ''}`, 
            count: 0 
        });
    }

    async deleteChapters({ filename, chapterIndices }) {
        if (!Array.isArray(chapterIndices) || chapterIndices.length === 0) {
            this.send({ type: "error", message: "无效的章节索引", count: 0 });
            return;
        }

        const sanitizedDirName = this.generateDirName(filename);
        let successCount = 0;
        let errorCount = 0;
        const total = chapterIndices.length;

        for (let i = 0; i < total; i++) {
            try {
                await chapterManager.deleteChapter(sanitizedDirName, chapterIndices[i]);
                successCount++;
                this.send({ type: "progress", message: `正在删除 ${i + 1}/${total}`, count: Math.floor(((i + 1) / total) * 100) });
            } catch (error) {
                errorCount++;
            }
        }

        this.send({ 
            type: errorCount === 0 ? "success" : "error", 
            message: errorCount === 0 ? `成功删除 ${successCount} 个章节` : `删除完成：成功 ${successCount}，失败 ${errorCount}`, 
            count: successCount 
        });
    }

    async getStorageInfo() {
        try {
            const deviceInfo = await runAsyncFunc(device.getInfo);
            const totalData = await runAsyncFunc(device.getTotalStorage);
            const availData = await runAsyncFunc(device.getAvailableStorage);
            
            const storageInfo = calculateStorageInfo(
                totalData ? totalData.totalStorage : 0, 
                availData ? availData.availableStorage : 0, 
                deviceInfo ? deviceInfo.product : null
            );
            
            this.send({
                type: "storage_info",
                product: deviceInfo ? deviceInfo.product : null,
                ...storageInfo
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
    
    callback(msg) {}
}
