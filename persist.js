const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'musicbot';

console.log(`[persist] MONGODB_URI=${MONGODB_URI ? 'موجود' : 'غائب'} | GIST=${GIST_TOKEN && GIST_ID ? 'مفعّل' : 'غائب'} | DB=${MONGODB_DB}`);

let lastStorageError = '';

function lastError() {
    return lastStorageError;
}

let mongoClient = null;

async function getDb() {
    if (!MONGODB_URI) {
        lastStorageError = 'متغير MONGODB_URI فارغ في persist.js';
        return null;
    }
    try {
        if (!mongoClient) {
            mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
        }
        await mongoClient.connect();
        return mongoClient.db(MONGODB_DB);
    } catch (e) {
        lastStorageError = 'فشل الاتصال بـ MongoDB: ' + (e.message || e);
        console.error(lastStorageError);
        return null;
    }
}

async function downloadFromDb() {
    const db = await getDb();
    if (!db) return null;
    try {
        const doc = await db.collection('state').findOne({ _id: 'main' });
        if (doc) return { config: doc.config || {}, bots: doc.bots || [] };
        return { config: {}, bots: [] };
    } catch (e) {
        lastStorageError = 'فشل قراءة MongoDB: ' + (e.message || e);
        console.error(lastStorageError);
        return null;
    }
}

async function uploadToDb(configData, botsData) {
    const db = await getDb();
    if (!db) return false;
    try {
        await db.collection('state').updateOne(
            { _id: 'main' },
            { $set: { config: configData, bots: botsData, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log('تم الحفظ في MongoDB.');
        return true;
    } catch (e) {
        console.error('فشل الحفظ في MongoDB:', e.message);
        return false;
    }
}

function gistEnabled() {
    return !!GIST_TOKEN && !!GIST_ID;
}

async function downloadState() {
    if (MONGODB_URI) {
        const r = await downloadFromDb();
        if (r) return r;
        console.log('MongoDB غير متاح في الوقت الحالي، أنتقل إلى Gist.');
    }
    if (!gistEnabled()) return null;
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { Authorization: `Bearer ${GIST_TOKEN}`, 'User-Agent': 'music-bot' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gist = await res.json();
        const files = gist.files || {};
        const config = files['config.json'] ? JSON.parse(files['config.json'].content) : {};
        const bots = files['bots.json'] ? JSON.parse(files['bots.json'].content) : [];
        return { config, bots };
    } catch (e) {
        console.error('فشل تنزيل الحالة من Gist:', e.message);
        return null;
    }
}

async function uploadState(configData, botsData) {
    if (MONGODB_URI) {
        const ok = await uploadToDb(configData, botsData);
        if (ok) return true;
    }
    if (!gistEnabled()) return false;
    try {
        const body = {
            files: {
                'config.json': { content: JSON.stringify(configData, null, 2) },
                'bots.json': { content: JSON.stringify(botsData, null, 2) },
            },
        };
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${GIST_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'music-bot',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('تم حفظ الحالة في Gist.');
        return true;
} catch (e) {
        lastStorageError = 'فشل الحفظ في MongoDB: ' + (e.message || e);
        console.error(lastStorageError);
        return false;
    }
}

module.exports = { downloadState, uploadState, gistEnabled, lastError };