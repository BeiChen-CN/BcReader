import storage from '../utils/storage.js'

const READING_TIME_KEY = 'EBOOK_READING_TIME_DATA';

async function isReadingTimeRecordingEnabled() {
    return new Promise((resolve) => {
        storage.get({
            key: 'EBOOK_READING_TIME_RECORDING',
            success: (data) => {
                if (data !== undefined && data !== '') {
                    resolve(data === 'true');
                } else {
                    resolve(true);
                }
            },
            fail: () => {
                resolve(true);
            }
        });
    });
}

async function getAllReadingTime() {
    return new Promise((resolve) => {
        storage.get({
            key: READING_TIME_KEY,
            success: (data) => {
                try {
                    const readingTimeData = data ? JSON.parse(data) : {};
                    resolve(readingTimeData);
                } catch (e) {
                    resolve({});
                }
            },
            fail: () => {
                resolve({});
            }
        });
    });
}async function saveReadingTime(readingTimeData) {
    return new Promise((resolve, reject) => {
        storage.set({
            key: READING_TIME_KEY,
            value: JSON.stringify(readingTimeData),
            success: () => resolve(),
            fail: () => reject()
        });
    });
}async function recordReadingStart(bookName) {
    if (!bookName) return;
    
    const isEnabled = await isReadingTimeRecordingEnabled();
    if (!isEnabled) return;
    
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
    } catch (e) {
        
    }
}async function recordReadingEnd(bookName) {
    if (!bookName) return;
    
    const isEnabled = await isReadingTimeRecordingEnabled();
    if (!isEnabled) return;
    
    try {
        const readingTimeData = await getAllReadingTime();
        
        if (!readingTimeData[bookName] || !readingTimeData[bookName].currentSessionStart) {
            return;
        }
        
        const startTime = readingTimeData[bookName].currentSessionStart;
        const endTime = Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);
        if (duration < 10) {
            delete readingTimeData[bookName].currentSessionStart;
            await saveReadingTime(readingTimeData);
            return;
        } 
        readingTimeData[bookName].totalSeconds = (readingTimeData[bookName].totalSeconds || 0) + duration;
        const session = {
            startTime: startTime,
            endTime: endTime,
            duration: duration,
            date: new Date(startTime).toISOString().split('T')[0] 
        };
        
        if (!readingTimeData[bookName].sessions) {
            readingTimeData[bookName].sessions = [];
        }
        
        readingTimeData[bookName].sessions.push(session);
        readingTimeData[bookName].lastReadDate = session.date;
        if (!readingTimeData[bookName].firstReadDate) {
            readingTimeData[bookName].firstReadDate = session.date;
        }
        delete readingTimeData[bookName].currentSessionStart;
        
        await saveReadingTime(readingTimeData);
    } catch (e) {
        
    }
}async function getReadingTime(bookName) {
    if (!bookName) return null;
    
    try {
        const readingTimeData = await getAllReadingTime();
        return readingTimeData[bookName] || null;
    } catch (e) {
        return null;
    }
}async function getAllBooksReadingTime() {
    try {
        return await getAllReadingTime();
    } catch (e) {
        return {};
    }
}function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0分钟';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        if (minutes > 0) {
            return `${hours}小时${minutes}分钟`;
        } else {
            return `${hours}小时`;
        }
    } else if (minutes > 0) {
        return `${minutes}分钟`;
    } else {
        return `${secs}秒`;
    }
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


function calculateGlobalStats(allBooksData) {
    const today = getTodayDateString();
    const weekStart = getWeekStartDate();
    
    let totalSeconds = 0;
    let totalDays = new Set();
    let todaySeconds = 0;
    let weekSeconds = 0;
    let dailyTotals = {}; 
    let allSessions = [];
    
    Object.keys(allBooksData).forEach(bookName => {
        const bookData = allBooksData[bookName];
        if (bookData.totalSeconds) {
            totalSeconds += bookData.totalSeconds;
        }
        if (bookData.sessions && bookData.sessions.length > 0) {
            allSessions = allSessions.concat(bookData.sessions);
            
            bookData.sessions.forEach(session => {
                const date = session.date;
                if (date) {
                    totalDays.add(date);
                    
                    
                    if (!dailyTotals[date]) {
                        dailyTotals[date] = 0;
                    }
                    dailyTotals[date] += session.duration || 0;
                    
                    
                    if (date === today) {
                        todaySeconds += session.duration || 0;
                    }
                    
                    
                    if (date >= weekStart) {
                        weekSeconds += session.duration || 0;
                    }
                }
            });
        }
    });
    
    
    const totalDaysCount = totalDays.size || 1;
    const averageDailySeconds = Math.floor(totalSeconds / totalDaysCount);
    
    
    const firstDate = allSessions.length > 0 ? 
        allSessions.reduce((min, s) => s.date < min ? s.date : min, allSessions[0].date) : null;
    const lastDate = allSessions.length > 0 ? 
        allSessions.reduce((max, s) => s.date > max ? s.date : max, allSessions[0].date) : null;
    
    let totalWeeks = 1;
    if (firstDate && lastDate) {
        const first = new Date(firstDate);
        const last = new Date(lastDate);
        const daysDiff = Math.ceil((last - first) / (1000 * 60 * 60 * 24)) + 1;
        totalWeeks = Math.ceil(daysDiff / 7) || 1;
    }
    const averageWeekSeconds = Math.floor(totalSeconds / totalWeeks);
    
    
    let maxDailySeconds = 0;
    Object.keys(dailyTotals).forEach(date => {
        if (dailyTotals[date] > maxDailySeconds) {
            maxDailySeconds = dailyTotals[date];
        }
    });
    
    return {
        totalSeconds,
        totalDays: totalDays.size,
        todaySeconds,
        averageDailySeconds,
        weekSeconds,
        averageWeekSeconds,
        maxDailySeconds
    };
}


function calculateBookStats(bookData) {
    if (!bookData || !bookData.sessions || bookData.sessions.length === 0) {
        return {
            totalSeconds: 0,
            totalDays: 0,
            todaySeconds: 0,
            averageDailySeconds: 0,
            weekSeconds: 0,
            averageWeekSeconds: 0,
            firstReadDate: '',
            lastReadDate: '',
            sessionCount: 0
        };
    }
    
    const today = getTodayDateString();
    const weekStart = getWeekStartDate();
    
    let totalDays = new Set();
    let todaySeconds = 0;
    let weekSeconds = 0;
    let dailyTotals = {};
    
    bookData.sessions.forEach(session => {
        const date = session.date;
        if (date) {
            totalDays.add(date);
            
            if (!dailyTotals[date]) {
                dailyTotals[date] = 0;
            }
            dailyTotals[date] += session.duration || 0;
            
            if (date === today) {
                todaySeconds += session.duration || 0;
            }
            
            if (date >= weekStart) {
                weekSeconds += session.duration || 0;
            }
        }
    });
    
    const totalDaysCount = totalDays.size || 1;
    const averageDailySeconds = Math.floor((bookData.totalSeconds || 0) / totalDaysCount);
    
    
    const firstDate = bookData.firstReadDate;
    const lastDate = bookData.lastReadDate;
    let totalWeeks = 1;
    if (firstDate && lastDate) {
        const first = new Date(firstDate);
        const last = new Date(lastDate);
        const daysDiff = Math.ceil((last - first) / (1000 * 60 * 60 * 24)) + 1;
        totalWeeks = Math.ceil(daysDiff / 7) || 1;
    }
    const averageWeekSeconds = Math.floor((bookData.totalSeconds || 0) / totalWeeks);
    
    return {
        totalSeconds: bookData.totalSeconds || 0,
        totalDays: totalDays.size,
        todaySeconds,
        averageDailySeconds,
        weekSeconds,
        averageWeekSeconds,
        firstReadDate: bookData.firstReadDate || '',
        lastReadDate: bookData.lastReadDate || '',
        sessionCount: bookData.sessions.length
    };
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
    getAllBooksReadingTime,
    saveReadingTime,
    formatDuration,
    calculateGlobalStats,
    calculateBookStats,
    clearAllReadingTime
};
