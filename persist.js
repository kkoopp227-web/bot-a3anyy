const fs = require('fs');
const path = require('path');

const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';

function gistEnabled() {
    return !!GIST_TOKEN && !!GIST_ID;
}

async function downloadState() {
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
        console.error('فشل رفع الحالة إلى Gist:', e.message);
        return false;
    }
}

module.exports = { downloadState, uploadState, gistEnabled };