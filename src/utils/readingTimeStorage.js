import storage from '../utils/storage.js';

const READING_TIME_KEY = 'EBOOK_READING_TIME_DATA';

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
    const result = await storagePromise('get', { key: 'EBOOK_READING_TIME_RECORDING' });
    if (result.status === 'success' && result.data !== undefined && result.data !== '') {
        return result.data === 'true';
    }
    return true;
}

async function getAllReadingTime() {
    const result = await storagePromise('get', { key: READING_TIME_KEY });
    if (result.status === 'success' && result.data) {
        try {
            return JSON.parse(result.data);
        } catch (e) {
            return {};
        }
    }
    return {};
}

async function saveReadingTime(readingTimeData) {
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

    try {
        const readingTimeData = await getAllReadingTime();
        if (!readingTimeData[bookName]) {
            readingTimeData[bookName] = {
                totalSeconds: 0,
                sessions: [],
                lastReadDate: null,
                firstReadDate: null
            };
        }
        readingTimeData[bookName].currentSessionStart = Date.now();
        await saveReadingTime(readingTimeData);
    } catch (e) {}
}

async function recordReadingEnd(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    try {
        const readingTimeData = await getAllReadingTime();
        const bookData = readingTimeData[bookName];

        if (!bookData || !bookData.currentSessionStart) return;

        const startTime = bookData.currentSessionStart;
        const endTime = Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);

        if (duration < 10) {
            delete bookData.currentSessionStart;
        } else {
            bookData.totalSeconds = (bookData.totalSeconds || 0) + duration;
            const session = {
                startTime: startTime,
                endTime: endTime,
                duration: duration,
                date: new Date(startTime).toISOString().split('T')[0]
            };

            if (!bookData.sessions) bookData.sessions = [];
            bookData.sessions.push(session);
            bookData.lastReadDate = session.date;
            if (!bookData.firstReadDate) bookData.firstReadDate = session.date;
            
            delete bookData.currentSessionStart;
        }
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
    getReadingTime,
    getAllBooksReadingTime: getAllReadingTime,
    saveReadingTime,
    formatDuration,
    calculateGlobalStats,
    calculateBookStats,
    clearAllReadingTime
};
