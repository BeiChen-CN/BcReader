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
    
    async startTransfer({ filename, total, wordCount }) {
        try {
            this.totalChapters = total;
            this.receivedChapters = 0;
            
            if (!filename || !filename.trim()) {
                this.send({ type: "error", message: "Filename is empty or invalid.", count: 0 });
                this.callback({ msg: "error", error: "Filename is empty or invalid." });
                return;
            }

            this.currentBookName = filename;
            this.currentBookDir = Date.now().toString();
            this.callback({ msg: "start", total, filename: filename });

            try {
                await runAsyncFunc(file.mkdir, { uri: this.baseUri });
            } catch (e) {
            }

            const bookUri = this.baseUri + this.currentBookDir;
            const bookInfoUri = bookUri + '/book_info.json';
            const listUri = bookUri + '/list.txt';

            try {
                await runAsyncFunc(file.rmdir, { uri: bookUri, recursive: true });
            } catch (e) {
            }
            await runAsyncFunc(file.mkdir, { uri: bookUri });

            const bookInfo = {
                name: filename,
                chapterCount: total + 1,
                wordCount: wordCount
            };
            await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });
            await runAsyncFunc(file.writeText, { uri: listUri, text: '' });

            const bookshelfUri = this.baseUri + 'bookshelf.json';
            let bookshelf = [];
            try {
                const data = await runAsyncFunc(file.readText, { uri: bookshelfUri });
                bookshelf = JSON.parse(data.text);
            } catch (e) {
            }
            
            bookshelf = bookshelf.filter(b => b.name !== filename);
            bookshelf.push({ name: filename, dirName: this.currentBookDir, chapterCount: total + 1, wordCount: wordCount });
            await runAsyncFunc(file.writeText, { uri: bookshelfUri, text: JSON.stringify(bookshelf) });

            this.send({ type: "ready", count: 0, usage: await this.getUsage() });
        } catch (error) {
            this.send({ type: "error", message: `Start transfer failed: ${error.message || 'unknown error'}`, count: 0 });
            this.callback({ msg: "error", error: `Start transfer failed: ${error.message || 'unknown error'}` });
        }
    }

    async saveChapter(payload) {
        try {
            const { count, data } = payload;
            const chapterData = JSON.parse(data);

            if (count !== this.receivedChapters) {
                this.send({ type: "error", message: "package count error", count: this.receivedChapters });
                return;
            }

            const chapterContent = chapterData.content;
            const chapterFileName = `${chapterData.index}.txt`;
            const chapterUri = `${this.baseUri}${this.currentBookDir}/${chapterFileName}`;

            await runAsyncFunc(file.writeArrayBuffer, {
                uri: chapterUri,
                buffer: str2abWrite(chapterContent)
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

            this.receivedChapters++;
            this.callback({ msg: "next", progress: count / this.totalChapters, filename: this.currentBookName });

            if (count == this.totalChapters) {
                this.send({ type: "success", message: "transfer success", count: this.receivedChapters });
                this.currentBookName = "";
                this.currentBookDir = "";
                this.callback({ msg: "success" });
            } else {
                await this.send({ type: "next", message: count + " success", count: this.receivedChapters });
            }
            
            if(count % 10 == 0) global.runGC();
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
