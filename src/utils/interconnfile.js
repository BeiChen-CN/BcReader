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
    partialChapterContent = "";
    currentSavingChapterIndex = -1;

    constructor({ addListener, send, setEventListener }) {
        const onmessage = (data) => {
            const { stat, ...payload } = data;
            switch (stat) {
                case "startTransfer":
                    this.startTransfer(payload);
                    break;
                case "d":
                    this.saveChapter(payload);
                    break;
                case "cancel":
                    this.send({ type: "cancel" });
                    this.currentBookName = "";
                    this.currentBookDir = "";
                    this.callback({ msg: "cancel" });
                    break;
                case "get_book_status":
                    this.getBookStatus(payload);
                    break;
            }
        }
        addListener(onmessage);
        this.send = send;
        setEventListener((event) => {
            if (event !== 'open') {
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

    async getBookStatus({ filename }) {
        const sanitizedDirName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const listUri = `${this.baseUri}${sanitizedDirName}/list.txt`;
        let chapterCount = 0;
        try {
            const data = await runAsyncFunc(file.readText, { uri: listUri });
            chapterCount = data.text.split('\n').filter(Boolean).length;
        } catch (e) {
            chapterCount = 0;
        }
        this.send({ type: "book_status", chapterCount: chapterCount });
    }
    
    async startTransfer({ filename, total, wordCount, startFrom = 0 }) {
        try {
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "Filename is empty or invalid.", count: 0 });
                this.callback({ msg: "error", error: "Filename is empty or invalid." });
                return;
            }

            const sanitizedDirName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
            this.currentBookName = filename;
            this.currentBookDir = sanitizedDirName;
            this.totalChapters = total;
            this.receivedChapters = startFrom;

            this.callback({ msg: "start", total, filename: filename });

            const bookUri = this.baseUri + this.currentBookDir;
            const bookInfoUri = bookUri + '/book_info.json';
            const listUri = bookUri + '/list.txt';
            const bookshelfUri = this.baseUri + 'bookshelf.json';

            if (startFrom === 0) {
                try { await runAsyncFunc(file.rmdir, { uri: bookUri, recursive: true }); } catch (e) {}
                await runAsyncFunc(file.mkdir, { uri: bookUri });
                await runAsyncFunc(file.writeText, { uri: listUri, text: '' });
            }

            const bookInfo = { name: filename, chapterCount: total, wordCount: wordCount };
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
            } else {
                bookshelf.push({ name: filename, dirName: this.currentBookDir, chapterCount: total, wordCount: wordCount, progress: 0 });
            }
            await runAsyncFunc(file.writeText, { uri: bookshelfUri, text: JSON.stringify(bookshelf) });

            this.send({ type: "ready", count: startFrom, usage: await this.getUsage() });
        } catch (error) {
            this.send({ type: "error", message: `Start transfer failed: ${error.message || 'unknown error'}`, count: 0 });
            this.callback({ msg: "error", error: `Start transfer failed: ${error.message || 'unknown error'}` });
        }
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
                if (count !== this.receivedChapters) {
                    this.send({ type: "next", message: "package count error", count: this.receivedChapters });
                    return;
                }
                this.partialChapterContent = chapterData.content;
                this.currentSavingChapterIndex = chapterData.index;
            } else {
                if (this.currentSavingChapterIndex !== chapterData.index) {
                    this.send({ type: "error", message: "chunk chapter index mismatch", count: this.receivedChapters });
                    return;
                }
                this.partialChapterContent += chapterData.content;
            }
            
            const chunkProgress = (chapterData.chunkNum + 1) / chapterData.totalChunks;
            const overallProgress = (count + chunkProgress) / (this.totalChapters);
            this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

            if (isLastChunk) {
                const chapterFileName = `${chapterData.index}.txt`;
                const chapterUri = `${this.baseUri}${this.currentBookDir}/${chapterFileName}`;

                await runAsyncFunc(file.writeArrayBuffer, {
                    uri: chapterUri,
                    buffer: str2abWrite(this.partialChapterContent)
                });

                const chapterMeta = {
                    index: chapterData.index,
                    name: chapterData.name,
                    wordCount: chapterData.wordCount
                };
                const listUri = `${this.baseUri}${this.currentBookDir}/list.txt`;
                await runAsyncFunc(file.writeText, {
                    uri: listUri,
                    text: JSON.stringify(chapterMeta) + '\n',
                    append: true
                });

                this.partialChapterContent = "";
                this.currentSavingChapterIndex = -1;
                this.receivedChapters++;

                if (count >= this.totalChapters - 1) {
                    this.send({ type: "success", message: "transfer success", count: this.receivedChapters });
                    this.currentBookName = "";
                    this.currentBookDir = "";
                    this.callback({ msg: "success" });
                } else {
                    await this.send({ type: "next", message: count + " success", count: this.receivedChapters });
                }
                
                if(count % 10 == 0) global.runGC();
            } else {
                await this.send({ type: "next_chunk" });
            }
        } catch (error) {
            this.send({ type: "error", message: `Save chapter failed: ${error.message || 'unknown error'}`, count: this.receivedChapters });
            this.callback({ msg: "error", progress: error.message });
        }
    }

    setCallback(callback) {
        this.callback = callback;
    }
    callback(msg) {  }
}
