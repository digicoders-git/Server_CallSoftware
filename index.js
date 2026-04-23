const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const AdmZip   = require('adm-zip');
const { parse } = require('csv-parse/sync');
const { connectDB, User, Student, Prompt, Campaign, CallLog } = require('./database');

const app    = express();
const port   = process.env.PORT || 5001;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const OBD_BASE_URL = 'https://obd3api.expressivr.com';

let currentToken  = null;
let currentUserId = null;

// Restore session from MongoDB on server start
const restoreSession = async () => {
    try {
        // First try DB
        const user = await User.findOne().sort({ last_login: -1 });
        if (user && user.obd_token) {
            currentToken  = user.obd_token;
            currentUserId = user.obd_user_id;
            console.log(`Session restored for userId: ${currentUserId}`);
            return;
        }
        // If no token in DB, auto-login with env credentials
        await autoLogin();
    } catch (e) { 
        console.error('Session restore error:', e.message);
        await autoLogin();
    }
};

const autoLogin = async () => {
    try {
        const username = process.env.OBD_USERNAME || 'DigiCoders';
        const password = process.env.OBD_PASSWORD || '123456789';
        const response = await axios.post(`${OBD_BASE_URL}/api/obd/login`, { username, password });
        const { token, userid } = response.data;
        currentToken  = token;
        currentUserId = userid;
        await User.findOneAndUpdate(
            { username },
            { username, obd_token: token, obd_user_id: userid, last_login: new Date() },
            { upsert: true, new: true }
        );
        console.log(`Auto-login successful for userId: ${currentUserId}`);
    } catch (e) {
        console.error('Auto-login failed:', e.message);
    }
};

// ── 1. Login ─────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${OBD_BASE_URL}/api/obd/login`, { username, password });
        const { token, userid } = response.data;

        currentToken  = token;
        currentUserId = userid;

        await User.findOneAndUpdate(
            { username },
            { username, obd_token: token, obd_user_id: userid, last_login: new Date() },
            { upsert: true, new: true }
        );

        res.json(response.data);
    } catch (error) {
        console.error('Login error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: 'Login failed' });
    }
});

// ── 2. Voice File Upload ──────────────────────────────
app.post('/api/upload-prompt', upload.single('waveFile'), async (req, res) => {
    if (!currentToken) return res.status(401).json({ error: 'Not authenticated' });

    const { fileName, promptCategory, fileType } = req.body;
    const form = new FormData();
    form.append('waveFile', req.file.buffer, { filename: req.file.originalname });
    form.append('userId',         currentUserId);
    form.append('fileName',       fileName);
    form.append('promptCategory', promptCategory);
    form.append('fileType',       fileType);

    try {
        const response = await axios.post(`${OBD_BASE_URL}/api/obd/promptupload`, form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${currentToken}` }
        });

        await Prompt.create({
            obd_prompt_id: response.data.promptId,
            file_name:     fileName,
            category:      promptCategory,
            status:        'PENDING_APPROVAL'
        });

        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: 'Upload failed' });
    }
});

// ── 3. Webhook Receiver ───────────────────────────────
app.post('/api/webhook/obd', async (req, res) => {
    const data = req.body;
    console.log('OBD Webhook:', JSON.stringify(data));

    const campaignId = data.campaignId || data.campaign_id || data.CampaignId || '';
    const phone      = data.phone      || data.Phone      || data.mobile      || '';
    const status     = (data.status    || data.Status     || data.callStatus  || 'UNKNOWN').toUpperCase();
    const dtmf       = data.dtmf       || data.Dtmf       || data.DTMF        || null;
    const duration   = parseInt(data.duration || data.Duration || 0);

    try {
        await CallLog.create({ campaign_id: campaignId, phone, status, dtmf, duration });
    } catch (e) { console.error('Webhook DB error:', e.message); }

    res.json({ message: 'ok' });
});

// ── 4. Students ───────────────────────────────────────
app.get('/api/students', async (req, res) => {
    try {
        const students = await Student.find().sort({ _id: -1 });
        res.json(students);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', async (req, res) => {
    const { name, phone } = req.body;
    try {
        const student = await Student.create({ name, phone });
        res.json(student);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. Call Logs from DB ──────────────────────────────
app.get('/api/logs', async (req, res) => {
    try {
        const logs = await CallLog.find().sort({ timestamp: -1 });
        res.json(logs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 6. Call Data from OBD Reports ────────────────────
app.get('/api/call-data', async (req, res) => {
    if (!currentToken || !currentUserId) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const campRes = await axios.get(`${OBD_BASE_URL}/api/obd/campaign/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000
        });
        const allCampaigns = Array.isArray(campRes.data) ? campRes.data : [];

        // Step 2: Get existing reports
        const dlRes = await axios.get(`${OBD_BASE_URL}/api/obd/report/download/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000
        });
        const existingReports = Array.isArray(dlRes.data) ? dlRes.data : [];
        const reportedIds = new Set(existingReports.map(r => String(r.campaignId)));

        // Step 3: Auto-generate reports for campaigns that don't have one
        for (const camp of allCampaigns) {
            if (!reportedIds.has(String(camp.campaignId))) {
                try {
                    await axios.post(`${OBD_BASE_URL}/api/obd/report/generate`,
                        { campaignId: camp.campaignId, reportType: 'full' },
                        { headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 10000 }
                    );
                    console.log(`Report generated for campaign: ${camp.campaignId}`);
                } catch(e) { console.error('Report gen error:', e.message); }
            }
        }

        // Step 4: Re-fetch reports after generation — keep only latest per campaign
        const dlRes2 = await axios.get(`${OBD_BASE_URL}/api/obd/report/download/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000
        });
        const allReports = Array.isArray(dlRes2.data) ? dlRes2.data.filter(r => r.status === '2' && r.reportUrl && r.reportUrl !== 'no_data' && r.reportUrl.startsWith('http')) : [];
        
        // Keep only latest report per campaign
        const latestReports = Object.values(
            allReports.reduce((acc, r) => {
                if (!acc[r.campaignId] || new Date(r.reqDate) > new Date(acc[r.campaignId].reqDate)) {
                    acc[r.campaignId] = r;
                }
                return acc;
            }, {})
        );
        const reports = latestReports;
        let allRows = [];

        for (const report of reports) {
            try {
                const zipRes = await axios.get(report.reportUrl, { responseType: 'arraybuffer', timeout: 15000 });
                const zip = new AdmZip(Buffer.from(zipRes.data));

                for (const entry of zip.getEntries()) {
                    if (!entry.entryName.endsWith('.csv')) continue;
                    const rows = parse(entry.getData().toString('utf8'), { columns: true, skip_empty_lines: true });
                    rows.forEach(row => {
                        if (!row.bni) return; // skip empty phone
                        allRows.push({
                            campaignId:  row.camp_id || '',
                            campaignName: report.campaignName || '',
                            phone:       row.bni || '',
                            status:      (row.answer_status || '').toUpperCase(),
                            dtmf:        row.dtmf || row.dtmf_sequence || null,
                            duration:    parseInt(row.billing_duration || row.patch_duration || 0),
                            timestamp:   row.end_time || row.start_time || '',
                            agentNumber: row.agent_number || '',
                            hangupCause: row.hangup_cause || '',
                            cli:         row.cli || ''
                        });
                    });
                }
            } catch (e) { console.error('zip error:', e.message); }
        }

        const unique = allRows
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json(unique);
    } catch (error) {
        res.status(500).json({ error: 'Failed', details: error.message });
    }
});

// ── 7. Live Campaigns from OBD ────────────────────────
app.get('/api/campaigns', async (req, res) => {
    if (!currentToken || !currentUserId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const response = await axios.get(`${OBD_BASE_URL}/api/obd/campaign/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` },
            timeout: 15000
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// Auto-refresh token every 12 hours
setInterval(async () => {
    console.log('Auto-refreshing OBD token...');
    await autoLogin();
}, 12 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────
connectDB().then(async () => {
    await restoreSession();
    const PORT = process.env.PORT || 5001;
    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
