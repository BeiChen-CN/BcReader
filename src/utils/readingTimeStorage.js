import storage from '../utils/storage.js';

const READING_TIME_KEY = 'EBOOK_READING_TIME_DATA';

const sessionStartTimes = {};
const lastSavedTimes = {};
let readingTimeCache = null;
let recordingEnabledCache = null;

function storagePromise(method, params = {}) {
    return new Promise((resolve) => {
        storage[method]({
            ...params,
            success: (data) => resolve({ status: 'success', data }),
            fail: (data, code) => resolve({ status: 'fail', code })
        });
    });
}

async function isReadingTimeRecordingEnabled() {
    if (recordingEnabledCache !== null) {
        return recordingEnabledCache;
    }
    const result = await storagePromise('get', { key: 'EBOOK_READING_TIME_RECORDING' });
    if (result.status === 'success' && result.data !== undefined && result.data !== '') {
        recordingEnabledCache = result.data === 'true';
    } else {
        recordingEnabledCache = true;
    }
    return recordingEnabledCache;
}

async function getAllReadingTime() {
    if (readingTimeCache !== null) {
        return readingTimeCache;
    }
    const result = await storagePromise('get', { key: READING_TIME_KEY });
    if (result.status === 'success' && result.data) {
        try {
            readingTimeCache = JSON.parse(result.data);
            return readingTimeCache;
        } catch (e) {
            readingTimeCache = {};
            return readingTimeCache;
        }
    }
    readingTimeCache = {};
    return readingTimeCache;
}

async function saveReadingTime(readingTimeData) {
    readingTimeCache = readingTimeData;
    return new Promise((resolve, reject) => {
        storage.set({
            key: READING_TIME_KEY,
            value: JSON.stringify(readingTimeData),
            success: () => resolve(),
            fail: () => reject()
        });
    });
}

async function recordReadingStart(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;
    if (sessionStartTimes[bookName] && lastSavedTimes[bookName]) return;
    const now = Date.now();
    sessionStartTimes[bookName] = now;
    lastSavedTimes[bookName] = now;
}

async function saveCurrentSession(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    const startTime = sessionStartTimes[bookName];
    const lastSavedTime = lastSavedTimes[bookName];
    if (!startTime || !lastSavedTime) return;

    const now = Date.now();
    const duration = Math.floor((now - lastSavedTime) / 1000);

    if (duration < 10) return;

    try {
        const readingTimeData = await getAllReadingTime();
        let bookData = readingTimeData[bookName];

        if (!bookData) {
            bookData = {
                totalSeconds: 0,
                sessions: [],
                lastReadDate: null,
                firstReadDate: null
            };
            readingTimeData[bookName] = bookData;
        }

        bookData.totalSeconds = (bookData.totalSeconds || 0) + duration;
        const sessionDate = new Date(lastSavedTime).toISOString().split('T')[0];
        const session = {
            startTime: lastSavedTime,
            endTime: now,
            duration: duration,
            date: sessionDate
        };

        if (!bookData.sessions) bookData.sessions = [];
        bookData.sessions.push(session);
        bookData.lastReadDate = sessionDate;
        if (!bookData.firstReadDate) bookData.firstReadDate = sessionDate;

        lastSavedTimes[bookName] = now;
        await saveReadingTime(readingTimeData);
    } catch (e) {}
}

async function recordReadingEnd(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    const startTime = sessionStartTimes[bookName];
    const lastSavedTime = lastSavedTimes[bookName];
    if (!startTime || !lastSavedTime) {
        delete sessionStartTimes[bookName];
        delete lastSavedTimes[bookName];
        return;
    }

    const endTime = Date.now();
    const remainingDuration = Math.floor((endTime - lastSavedTime) / 1000);

    delete sessionStartTimes[bookName];
    delete lastSavedTimes[bookName];

    if (remainingDuration < 10) return;

    try {
        const readingTimeData = await getAllReadingTime();
        let bookData = readingTimeData[bookName];

        if (!bookData) {
            bookData = {
                totalSeconds: 0,
                sessions: [],
                lastReadDate: null,
                firstReadDate: null
            };
            readingTimeData[bookName] = bookData;
        }

        bookData.totalSeconds = (bookData.totalSeconds || 0) + remainingDuration;
        const sessionDate = new Date(lastSavedTime).toISOString().split('T')[0];
        const session = {
            startTime: lastSavedTime,
            endTime: endTime,
            duration: remainingDuration,
            date: sessionDate
        };

        if (!bookData.sessions) bookData.sessions = [];
        bookData.sessions.push(session);
        bookData.lastReadDate = sessionDate;
        if (!bookData.firstReadDate) bookData.firstReadDate = sessionDate;

        await saveReadingTime(readingTimeData);
    } catch (e) {}
}

async function getReadingTime(bookName) {
    if (!bookName) return null;
    try {
        const data = await getAllReadingTime();
        return data[bookName] || null;
    } catch (e) {
        return null;
    }
}

function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0分钟';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
    }
    if (minutes > 0) return `${minutes}分钟`;
    return `${secs}秒`;
}

function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

function getWeekStartDate() {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}

function calculateStatsCore(sessions, totalSecondsOverride) {
    const today = getTodayDateString();
    const weekStart = getWeekStartDate();
    
    let totalSeconds = totalSecondsOverride !== undefined ? totalSecondsOverride : 0;
    let todaySeconds = 0;
    let weekSeconds = 0;
    let maxDailySeconds = 0;
    const dailyTotals = {};
    const totalDays = new Set();
    
    let firstDate = null;
    let lastDate = null;

    if (sessions && sessions.length > 0) {
        const calcTotal = totalSecondsOverride === undefined;
        
        sessions.forEach(session => {
            const date = session.date;
            if (!date) return;
            
            if (calcTotal) totalSeconds += (session.duration || 0);
            
            totalDays.add(date);
            dailyTotals[date] = (dailyTotals[date] || 0) + (session.duration || 0);

            if (date === today) todaySeconds += (session.duration || 0);
            if (date >= weekStart) weekSeconds += (session.duration || 0);
            
            if (!firstDate || date < firstDate) firstDate = date;
            if (!lastDate || date > lastDate) lastDate = date;
        });
    }

    Object.values(dailyTotals).forEach(val => {
        if (val > maxDailySeconds) maxDailySeconds = val;
    });

    let totalWeeks = 1;
    if (firstDate && lastDate) {
        const first = new Date(firstDate);
        const last = new Date(lastDate);
        const daysDiff = Math.ceil((last - first) / (1000 * 60 * 60 * 24)) + 1;
        totalWeeks = Math.ceil(daysDiff / 7) || 1;
    }

    const totalDaysCount = totalDays.size || 1;

    return {
        totalSeconds,
        totalDays: totalDays.size,
        todaySeconds,
        weekSeconds,
        averageDailySeconds: Math.floor(totalSeconds / totalDaysCount),
        averageWeekSeconds: Math.floor(totalSeconds / totalWeeks),
        maxDailySeconds,
        firstDate,
        lastDate,
        sessionCount: sessions.length
    };
}

function calculateGlobalStats(allBooksData) {
    let allSessions = [];
    let combinedTotalSeconds = 0;

    Object.values(allBooksData).forEach(bookData => {
        if (bookData.totalSeconds) combinedTotalSeconds += bookData.totalSeconds;
        if (bookData.sessions && bookData.sessions.length > 0) {
            allSessions = allSessions.concat(bookData.sessions);
        }
    });

    return calculateStatsCore(allSessions, combinedTotalSeconds);
}

function calculateBookStats(bookData) {
    if (!bookData) return calculateStatsCore([]);
    
    const stats = calculateStatsCore(bookData.sessions || [], bookData.totalSeconds);
    
    stats.firstReadDate = bookData.firstReadDate || '';
    stats.lastReadDate = bookData.lastReadDate || '';
    return stats;
}

async function clearAllReadingTime() {
    readingTimeCache = {};
    Object.keys(sessionStartTimes).forEach(key => delete sessionStartTimes[key]);
    Object.keys(lastSavedTimes).forEach(key => delete lastSavedTimes[key]);
    return new Promise((resolve, reject) => {
        storage.set({
            key: READING_TIME_KEY,
            value: JSON.stringify({}),
            success: () => resolve(),
            fail: () => reject()
        });
    });
}

export default {
    recordReadingStart,
    recordReadingEnd,
    saveCurrentSession,
    getReadingTime,
    getAllBooksReadingTime: getAllReadingTime,
    saveReadingTime,
    formatDuration,
    calculateGlobalStats,
    calculateBookStats,
    clearAllReadingTime
};
