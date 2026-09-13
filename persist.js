// أُزيل نظام التخزين البعيد (MongoDB/Gist) نهائيًا حسب طلب المستخدم.
// الحفظ الآن محلي فقط داخل bots.json — بسيط ويشتغل بدون أي خدمة خارجية.

const fs = require('fs');
const path = require('path');

const BOTS_FILE = path.join(__dirname, 'bots.json');

function loadLocalBots() {
    try {
        return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveLocalBots(bots) {
    try {
        fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
        return true;
    } catch (e) {
        console.error('فشل حفظ bots.json:', e.message);
        return false;
    }
}

module.exports = {
    downloadState: async () => null,
    uploadState: async () => false,
    gistEnabled: () => false,
    lastError: () => '',
    loadLocalBots,
    saveLocalBots,
};