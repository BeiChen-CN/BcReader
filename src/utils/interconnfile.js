import file from "@system.file";
import storage from '../common/storage.js';
import runAsyncFunc from "./runAsyncFunc";
import str2abWrite from "./str2abWrite";

export default class interconnfile {
    static "__interconnModule__" = true;
    static name = 'file';
    baseUri = 'internal://files/books/';
    currentBookName = "";
    currentBookDir = "";
    totalChapters = 0;
    receivedChapters = 0;
    partialChapterContent = [];
    currentSavingChapterIndex = -1;
    currentChapterMeta = null;
    isCoverOnly = false;
    
    pendingChapterMetas = [];
    BATCH_WRITE_SIZE = 10;

    constructor({ addListener, send, setEventListener }) {
        this.partialCoverData = [];
        this.totalCoverChunks = 0;
        
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
                            console.error('Failed to flush pending metas on cancel:', e);
                        });
                    }
                    this.send({ type: "cancel" });
                    this.currentBookName = "";
                    this.currentBookDir = "";
                    this.pendingChapterMetas = [];
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
            }
        }
        addListener(onmessage);
        this.send = send;
        setEventListener((event) => {
            if (event !== 'open') {
                if (this.pendingChapterMetas && this.pendingChapterMetas.length > 0) {
                    this.flushPendingChapterMetas().catch(e => {
                        console.error('Failed to flush pending metas on disconnect:', e);
                    });
                }
                this.currentBookName = "";
                this.currentBookDir = "";
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

    generateDirName(filename) {
        let hash = 0;
        for (let i = 0; i < filename.length; i++) {
            const char = filename.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        const hashStr = Math.abs(hash).toString(36);
        
        const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const truncated = sanitized.substring(0, 30);
        return `${truncated}_${hashStr}`;
    }

    async getBookStatus({ filename }) {
        
        try {
            await runAsyncFunc(file.access, { uri: this.baseUri });
        } catch (e) {
            this.send({ type: "book_status", syncedChapters: [], hasCover: false });
            return;
        }
        
        const sanitizedDirName = this.generateDirName(filename);
        const listUri = `${this.baseUri}${sanitizedDirName}/list.txt`;
        const coverUri = `${this.baseUri}${sanitizedDirName}/cover.jpg`;
        let syncedChapterIndices = [];
        let hasCover = false;
        
        try {
            const data = await runAsyncFunc(file.readText, { uri: listUri });
            const lines = data.text.split('\n').filter(Boolean);
            
            const indexSet = new Set();
            for (const line of lines) {
                try {
                    const chapterMeta = JSON.parse(line);
                    if (chapterMeta.index !== null && chapterMeta.index !== undefined) {
                        indexSet.add(chapterMeta.index);
                    }
                } catch (e) {
                    
                }
            }
            syncedChapterIndices = Array.from(indexSet);
        } catch (e) {
            syncedChapterIndices = [];
        }
        
        try {
            await runAsyncFunc(file.access, { uri: coverUri });
            hasCover = true;
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
            
            
            const coverUri = bookUri + '/cover.jpg';
            try {
                await runAsyncFunc(file.access, { uri: coverUri });
                await runAsyncFunc(file.delete, { uri: coverUri });
            } catch (e) {
                
            }
            
            this.partialCoverData = [];
            this.totalCoverChunks = 0;
            this.currentBookCoverUri = coverUri;
            
            console.log(`Cover-only transfer initialized: ${coverUri}`);
            this.send({ type: "cover_ready" });
        } catch (error) {
            this.send({ type: "error", message: `Start cover transfer failed: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    async startTransfer({ filename, total, wordCount, startFrom = 0, hasCover = false }) {
        try {
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "Filename is empty or invalid.", count: 0 });
                this.callback({ msg: "error", error: "Filename is empty or invalid." });
                return;
            }

            const sanitizedDirName = this.generateDirName(filename);
            this.currentBookName = filename;
            this.currentBookDir = sanitizedDirName;
            this.totalChapters = total;
            this.receivedChapters = startFrom;
            this.pendingChapterMetas = [];

            this.callback({ msg: "start", total, filename: filename });

            
            try {
                await runAsyncFunc(file.access, { uri: this.baseUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: this.baseUri, recursive: true });
            }

            const bookUri = this.baseUri + this.currentBookDir;
            const bookInfoUri = bookUri + '/book_info.json';
            const listUri = bookUri + '/list.txt';
            const coverUri = bookUri + '/cover.jpg';
            const contentUri = bookUri + '/content';
            const bookshelfUri = this.baseUri + 'bookshelf.json';

            if (startFrom === 0) {
                let progress = null;
                try {
                    const progressUri = bookUri + '/progress.json';
                    const data = await runAsyncFunc(file.readText, { uri: progressUri });
                    progress = data.text;
                } catch(e) { /* no progress file, that's ok */ }

                try { await runAsyncFunc(file.rmdir, { uri: bookUri, recursive: true }); } catch (e) {}
                await runAsyncFunc(file.mkdir, { uri: bookUri });
                
                if (progress) {
                    const progressUri = bookUri + '/progress.json';
                    await runAsyncFunc(file.writeText, { uri: progressUri, text: progress });
                }

                await runAsyncFunc(file.writeText, { uri: listUri, text: '' });
            } else {
                
                try {
                    await runAsyncFunc(file.access, { uri: bookUri });
                } catch (e) {
                    
                    await runAsyncFunc(file.mkdir, { uri: bookUri });
                    await runAsyncFunc(file.writeText, { uri: listUri, text: '' });
                    this.receivedChapters = 0;
                }
                
                
                try {
                    const listData = await runAsyncFunc(file.readText, { uri: listUri });
                    const existingChapters = listData.text.split('\n').filter(Boolean);
                    this.receivedChapters = existingChapters.length;
                } catch (e) {
                    
                    await runAsyncFunc(file.writeText, { uri: listUri, text: '' });
                    this.receivedChapters = 0;
                }
            }

            
            try {
                await runAsyncFunc(file.access, { uri: contentUri });
            } catch (e) {
                await runAsyncFunc(file.mkdir, { uri: contentUri });
            }

            
            if (hasCover) {
                this.partialCoverData = [];
                this.totalCoverChunks = 0;
                this.currentBookCoverUri = coverUri;
                console.log(`Cover transfer initialized: ${coverUri}`);
            }

            const bookInfo = { name: filename, chapterCount: total, wordCount: wordCount, hasCover: hasCover };
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            
            let bookshelf = [];
            try {
                const data = await runAsyncFunc(file.readText, { uri: bookshelfUri });
                bookshelf = JSON.parse(data.text);
            } catch (e) {}

            const existingBookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
            if (existingBookIndex > -1) {
                bookshelf[existingBookIndex].name = filename;
                bookshelf[existingBookIndex].chapterCount = total;
                bookshelf[existingBookIndex].wordCount = wordCount;
                bookshelf[existingBookIndex].hasCover = hasCover;
            } else {
                bookshelf.push({ name: filename, dirName: this.currentBookDir, chapterCount: total, wordCount: wordCount, progress: 0, hasCover: hasCover });
            }
            await runAsyncFunc(file.writeText, { uri: bookshelfUri, text: JSON.stringify(bookshelf) });

            this.send({ type: "ready", count: startFrom, usage: await this.getUsage() });
        } catch (error) {
            this.send({ type: "error", message: `Start transfer failed: ${error.message || 'unknown error'}`, count: 0 });
            this.callback({ msg: "error", error: `Start transfer failed: ${error.message || 'unknown error'}` });
        }
    }

    async saveCoverChunk({ chunkIndex, totalChunks, data }) {
        try {
            
            if (!this.currentBookCoverUri) {
                console.error('Cover URI not initialized');
                this.send({ type: "error", message: "Cover transfer not initialized", count: 0 });
                return;
            }
            
            
            if (chunkIndex === 0 || this.totalCoverChunks === 0 || this.totalCoverChunks !== totalChunks) {
                this.partialCoverData = [];
                this.totalCoverChunks = totalChunks;
                console.log(`Starting/Restarting cover image transfer: ${totalChunks} chunks`);
            }
            
            
            const expectedIndex = this.partialCoverData.length;
            if (chunkIndex !== expectedIndex) {
                console.error(`Cover chunk index mismatch: expected ${expectedIndex}, got ${chunkIndex}`);
                
                if (chunkIndex === 0) {
                    console.log('Restarting cover transfer from chunk 0');
                    this.partialCoverData = [];
                    this.totalCoverChunks = totalChunks;
                } else {
                    this.partialCoverData = [];
                    this.totalCoverChunks = 0;
                    this.currentBookCoverUri = null;
                    this.send({ type: "error", message: "Cover chunk index mismatch", count: 0 });
                    return;
                }
            }
            
            this.partialCoverData.push(data);
            
            await this.send({ type: "cover_chunk_received" });
        } catch (error) {
            this.send({ type: "error", message: `Save cover chunk failed: ${error.message || 'unknown error'}`, count: 0 });
            this.callback({ msg: "error", error: `Save cover chunk failed: ${error.message || 'unknown error'}` });
        }
    }

    async completeCoverTransfer() {
        try {
            if (!this.currentBookCoverUri || this.partialCoverData.length === 0) {
                this.send({ type: "error", message: "No cover data to save", count: 0 });
                return;
            }
            
            console.log(`Saving cover image: ${this.partialCoverData.length} chunks`);
            
            const fullCoverBase64 = this.partialCoverData.join('');
            
            this.partialCoverData = [];
            this.totalCoverChunks = 0;
            
            const coverBytes = this.base64ToArrayBuffer(fullCoverBase64);
            
            await runAsyncFunc(file.writeArrayBuffer, { 
                uri: this.currentBookCoverUri, 
                buffer: new Uint8Array(coverBytes)
            });
            
            console.log(`Cover image saved successfully: ${coverBytes.byteLength} bytes`);
            
            await this.updateCoverStatus(true);
            
            this.currentBookCoverUri = null;
        
            if (typeof global !== 'undefined' && typeof global.runGC === 'function') {
                global.runGC();
            }
            
            this.send({ type: "cover_saved" });
            
            if (this.isCoverOnly) {
                this.callback({ msg: "success" });
                this.currentBookName = "";
                this.currentBookDir = "";
            }
        } catch (error) {
            console.error('Failed to complete cover transfer:', error);
            this.partialCoverData = [];
            this.totalCoverChunks = 0;
            this.currentBookCoverUri = null;
            this.send({ type: "error", message: `Complete cover transfer failed: ${error.message || 'unknown error'}`, count: 0 });
            this.callback({ msg: "error", error: `Complete cover transfer failed: ${error.message || 'unknown error'}` });
        }
    }

    async updateCoverStatus(hasCover) {
        const bookUri = this.baseUri + this.currentBookDir;
        const bookInfoUri = bookUri + '/book_info.json';
        const bookshelfUri = this.baseUri + 'bookshelf.json';
        
        try {
            let bookInfo = {};
            try {
                const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
                bookInfo = JSON.parse(bookInfoData.text);
            } catch(e) { /* file might not exist */ }
            bookInfo.hasCover = hasCover;
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            
            let bookshelf = [];
            try {
                const bookshelfData = await runAsyncFunc(file.readText, { uri: bookshelfUri });
                bookshelf = JSON.parse(bookshelfData.text);
            } catch (e) { /* file might not exist */ }
            const bookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
            if (bookIndex > -1) {
                bookshelf[bookIndex].hasCover = hasCover;
                await runAsyncFunc(file.writeText, { uri: bookshelfUri, text: JSON.stringify(bookshelf) });
            }
        } catch (e) {
            console.error('Failed to update cover status:', e);
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
                console.error('Invalid base64 character found');
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

    async saveChapter(payload) {
        try {
            const { count, data } = payload;
            const chapterData = JSON.parse(data);

            const isFirstChunk = chapterData.chunkNum === 0;
            const isLastChunk = chapterData.chunkNum === chapterData.totalChunks - 1;

            if (isFirstChunk) {
                
                if (count < this.receivedChapters) {
                    await this.send({ type: "next", message: "duplicate chapter", count: this.receivedChapters });
                    return;
                }
                
                if (count > this.receivedChapters) {
                    this.receivedChapters = count;
                }
                if (count !== this.receivedChapters) {
                    this.send({ type: "next", message: "package count error", count: this.receivedChapters });
                    return;
                }
                this.partialChapterContent = [chapterData.content];
                this.currentSavingChapterIndex = chapterData.index;
            } else {
                if (this.currentSavingChapterIndex !== chapterData.index) {
                    this.send({ type: "error", message: "chunk chapter index mismatch", count: this.receivedChapters });
                    return;
                }
                this.partialChapterContent.push(chapterData.content);
            }
            
            const chunkProgress = (chapterData.chunkNum + 1) / chapterData.totalChunks;
            const overallProgress = (count + chunkProgress) / (this.totalChapters);
            this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

            if (isLastChunk) {
                const chapterFileName = `${chapterData.index}.txt`;
                const chapterUri = `${this.baseUri}${this.currentBookDir}/content/${chapterFileName}`;

                
                const fullContent = this.partialChapterContent.join('');
                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: chapterUri,
                    buffer: str2abWrite(fullContent)
                });

                
                this.partialChapterContent = [];

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
        } catch (error) {
            this.send({ type: "error", message: `Save chapter failed: ${error.message || 'unknown error'}`, count: this.receivedChapters });
            this.callback({ msg: "error", progress: error.message });
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
            this.receivedChapters++;
            
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
            this.send({ type: "error", message: `Complete chapter transfer failed: ${error.message || 'unknown error'}`, count: this.receivedChapters });
            this.callback({ msg: "error", error: `Complete chapter transfer failed: ${error.message || 'unknown error'}` });
        }
    }
    
    async flushPendingChapterMetas() {
        if (this.pendingChapterMetas.length === 0) return;
        
        const listUri = `${this.baseUri}${this.currentBookDir}/list.txt`;
        
        try {
            const metaLines = this.pendingChapterMetas.map(meta => JSON.stringify(meta)).join('\n') + '\n';
            
            let existingContent = '';
            try {
                const listData = await runAsyncFunc(file.readText, { uri: listUri });
                existingContent = listData.text;
            } catch (e) {
                existingContent = '';
            }
            
            await runAsyncFunc(file.writeText, {
                uri: listUri,
                text: existingContent + metaLines
            });
            
            this.pendingChapterMetas = [];
        } catch (error) {
            console.error('Failed to flush chapter metas:', error);
            throw error;
        }
    }

    async handleTransferComplete() {
        try {
            if (this.pendingChapterMetas.length > 0) {
                await this.flushPendingChapterMetas();
            }
            
            this.partialCoverData = [];
            this.totalCoverChunks = 0;
            this.currentBookCoverUri = null;
            this.partialChapterContent = [];
            this.currentSavingChapterIndex = -1;
            this.currentChapterMeta = null;
            this.pendingChapterMetas = [];
            this.currentBookName = "";
            this.currentBookDir = "";
            
            if (typeof global !== 'undefined' && typeof global.runGC === 'function') {
                global.runGC();
            }
            
            this.send({ type: "transfer_finished" });
            
            this.callback({ msg: "success" });
        } catch (error) {
            console.error('Failed to handle transfer complete:', error);
            this.send({ type: "error", message: `Handle transfer complete failed: ${error.message || 'unknown error'}`, count: 0 });
        }
    }

    setCallback(callback) {
        this.callback = callback;
    }
    callback(msg) {  }
}
