const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const AdmZip   = require('adm-zip');
const { parse } = require('csv-parse/sync');
const XLSX     = require('xlsx');
const { connectDB, User, Student, Prompt, Campaign, CallLog } = require('./database');

const app    = express();
const port   = process.env.PORT || 5001;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const OBD_BASE_URL = 'https://obd3api.expressivr.com';

let currentToken  = null;
let currentUserId = null;

// ── Session Management ────────────────────────────────
const restoreSession = async () => {
    try {
        const user = await User.findOne().sort({ last_login: -1 });
        if (user && user.obd_token) {
            currentToken  = user.obd_token;
            currentUserId = user.obd_user_id;
            console.log(`Session restored for userId: ${currentUserId}`);
            return;
        }
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

// ── Core: Sync OBD reports to MongoDB ────────────────
const syncReportsToDb = async () => {
    if (!currentToken || !currentUserId) return { synced: 0, error: 'Not authenticated' };

    try {
        // Step 1: Get all campaigns
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

        // Step 4: Re-fetch reports — prefer full over dtmf, latest per campaign
        const dlRes2 = await axios.get(`${OBD_BASE_URL}/api/obd/report/download/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000
        });
        const allReports = Array.isArray(dlRes2.data)
            ? dlRes2.data.filter(r => 
                r.status === '2' && 
                r.reportUrl && 
                r.reportUrl !== 'no_data' && 
                r.reportUrl.startsWith('http') &&
                r.reportUrl.includes('_full') // only full reports
              )
            : [];

        const latestReports = Object.values(
            allReports.reduce((acc, r) => {
                const existing = acc[r.campaignId];
                if (!existing) { acc[r.campaignId] = r; return acc; }
                const isFull = r.reportUrl.includes('_full');
                const existingFull = existing.reportUrl.includes('_full');
                if (isFull && !existingFull) { acc[r.campaignId] = r; return acc; }
                if (!isFull && existingFull) return acc;
                if (new Date(r.reqDate) > new Date(existing.reqDate)) acc[r.campaignId] = r;
                return acc;
            }, {})
        );

        // Step 5: Download ZIP, parse CSV, save to MongoDB
        let totalSynced = 0;

        for (const report of latestReports) {
            try {
                const zipRes = await axios.get(report.reportUrl, { responseType: 'arraybuffer', timeout: 30000 });
                const zip = new AdmZip(Buffer.from(zipRes.data));

                for (const entry of zip.getEntries()) {
                    if (!entry.entryName.endsWith('.csv')) continue;
                    const rows = parse(entry.getData().toString('utf8'), { columns: true, skip_empty_lines: true });

                    // Delete existing records for this campaign before re-inserting
                    await CallLog.deleteMany({ campaign_id: String(report.campaignId) });

                    const docs = [];
                    rows.forEach(row => {
                        if (!row.bni) return;
                        const status = (row.answer_status || '').toUpperCase();
                        if (['INITIATED', 'RINGING'].includes(status)) return;
                        docs.push({
                            campaign_id:   row.camp_id || String(report.campaignId),
                            campaign_name: report.campaignName || '',
                            phone:         row.bni,
                            status,
                            dtmf:          row.dtmf || row.dtmf_sequence || null,
                            duration:      parseInt(row.billing_duration || row.patch_duration || 0),
                            timestamp:     new Date(row.end_time || row.start_time || Date.now()),
                            agent_number:  row.agent_number || '',
                            hangup_cause:  row.hangup_cause || '',
                            cli:           row.cli || ''
                        });
                    });

                    if (docs.length > 0) {
                        // Insert in batches of 500 to avoid memory issues
                        const BATCH = 500;
                        for (let i = 0; i < docs.length; i += BATCH) {
                            const batch = docs.slice(i, i + BATCH);
                            try {
                                const result = await CallLog.insertMany(batch, { ordered: false });
                                totalSynced += result.length;
                            } catch(insertErr) {
                                const inserted = insertErr.insertedDocs?.length || 0;
                                totalSynced += inserted;
                                console.log(`Batch insert partial: ${inserted}/${batch.length}`);
                            }
                        }
                        console.log(`Synced ${docs.length} records for campaign ${report.campaignId}`);
                    }
                }
            } catch (e) { console.error(`Sync error for ${report.campaignId}:`, e.message); }
        }

        return { synced: totalSynced };
    } catch (e) {
        console.error('syncReportsToDb error:', e.message);
        return { error: e.message };
    }
};

// ── 1. Login ──────────────────────────────────────────
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
        res.status(error.response?.status || 500).json({ error: 'Login failed' });
    }
});

// ── 2. Sync OBD → MongoDB (manual trigger) ───────────
app.post("/api/sync", (req, res) => {
    res.json({ message: "Sync started in background" });
    syncReportsToDb().then(r => console.log("Sync complete:", JSON.stringify(r))).catch(e => console.error("Sync error:", e.message));
});

// ── 3. Webhook Receiver ───────────────────────────────
app.post('/api/webhook/obd', async (req, res) => {
    const data = req.body;
    const campaignId = data.campaignId || data.campaign_id || '';
    const phone      = data.phone || data.Phone || data.mobile || '';
    const status     = (data.status || data.callStatus || 'UNKNOWN').toUpperCase();
    const dtmf       = data.dtmf || data.DTMF || null;
    const duration   = parseInt(data.duration || 0);
    try {
        await CallLog.create({ campaign_id: campaignId, phone, status, dtmf, duration });
    } catch (e) { console.error('Webhook DB error:', e.message); }
    res.json({ message: 'ok' });
});

// ── 4. Import Excel/CSV ──────────────────────────────
app.post('/api/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) return res.status(400).json({ error: 'File is empty' });

        // Map columns flexibly
        const docs = rows.map(row => {
            const keys = Object.keys(row).reduce((acc, k) => { acc[k.toLowerCase().replace(/[^a-z0-9]/g,'')] = row[k]; return acc; }, {});
            return {
                campaign_id:   String(keys.campid || keys.campaignid || keys.campaign_id || ''),
                campaign_name: String(keys.campaignname || keys.campaign_name || keys.campaignname || ''),
                phone:         String(keys.bni || keys.phone || keys.mobile || keys.number || ''),
                status:        String(keys.answerstatus || keys.status || keys.answer_status || '').toUpperCase(),
                dtmf:          String(keys.dtmf || keys.dtmfsequence || '') || null,
                duration:      parseInt(keys.billingduration || keys.duration || keys.billing_duration || 0),
                timestamp:     keys.endtime || keys.end_time || keys.timestamp ? new Date(keys.endtime || keys.end_time || keys.timestamp) : new Date(),
                agent_number:  String(keys.agentnumber || keys.agent_number || ''),
                hangup_cause:  String(keys.hangupcause || keys.hangup_cause || ''),
                cli:           String(keys.cli || '')
            };
        }).filter(d => d.phone && !['INITIATED','RINGING'].includes(d.status));

        if (docs.length === 0) return res.status(400).json({ error: 'No valid records found' });

        // Insert in batches
        let inserted = 0;
        const BATCH = 500;
        for (let i = 0; i < docs.length; i += BATCH) {
            const result = await CallLog.insertMany(docs.slice(i, i + BATCH), { ordered: false }).catch(e => e.insertedDocs || []);
            inserted += Array.isArray(result) ? result.length : result.length || 0;
        }

        res.json({ success: true, total: rows.length, inserted });
    } catch (e) {
        console.error('Import error:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ── 4. Import CSV/Excel ───────────────────────────────
app.post("/api/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
        let rows = [];
        const ext = req.file.originalname.split(".").pop().toLowerCase();
        if (ext === "csv") {
            rows = parse(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true });
        } else {
            const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        }
        if (!rows.length) return res.status(400).json({ error: "File is empty" });
        const docs = rows.map(row => {
            const r = {};
            Object.keys(row).forEach(k => { r[k.toLowerCase().trim()] = row[k]; });
            const status = String(r.answer_status || r.status || "").toUpperCase();
            return { campaign_id: String(r.camp_id || r.campaign_id || ""), campaign_name: String(r.campaign_name || ""), phone: String(r.bni || r.phone || r.mobile || ""), status, dtmf: String(r.dtmf || r.dtmf_sequence || "") || null, duration: parseInt(r.billing_duration || r.duration || 0), timestamp: r.end_time ? new Date(r.end_time) : new Date(), agent_number: String(r.agent_number || ""), hangup_cause: String(r.hangup_cause || ""), cli: String(r.cli || "") };
        }).filter(d => d.phone && !["INITIATED","RINGING"].includes(d.status));
        if (!docs.length) return res.status(400).json({ error: "No valid records found" });
        let inserted = 0;
        for (let i = 0; i < docs.length; i += 500) {
            const result = await CallLog.insertMany(docs.slice(i, i + 500), { ordered: false }).catch(e => e.insertedDocs || []);
            inserted += Array.isArray(result) ? result.length : (result.length || 0);
        }
        res.json({ success: true, total: rows.length, inserted });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── 5. Students ───────────────────────────────────────
app.get('/api/students', async (req, res) => {
    try {
        res.json(await Student.find().sort({ _id: -1 }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', async (req, res) => {
    try {
        res.json(await Student.create(req.body));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. Call Data from MongoDB ─────────────────────────
app.get('/api/call-data', async (req, res) => {
    try {
        const { startDate, endDate, campaignId } = req.query;
        const filter = {};

        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate + 'T00:00:00');
            if (endDate)   filter.timestamp.$lte = new Date(endDate + 'T23:59:59');
        }

        if (campaignId) filter.campaign_id = campaignId;

        const logs = await CallLog.find(filter).sort({ timestamp: -1 });

        const result = logs.map(l => ({
            campaignId:   l.campaign_id,
            campaignName: l.campaign_name,
            phone:        l.phone,
            status:       l.status,
            dtmf:         l.dtmf,
            duration:     l.duration,
            timestamp:    l.timestamp,
            agentNumber:  l.agent_number,
            hangupCause:  l.hangup_cause,
            cli:          l.cli
        }));

        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 6. Live Campaigns from OBD ────────────────────────
app.get('/api/campaigns', async (req, res) => {
    if (!currentToken || !currentUserId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const response = await axios.get(`${OBD_BASE_URL}/api/obd/campaign/${currentUserId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// ── 7. Clear all call logs ────────────────────────────
app.delete('/api/clear-data', async (req, res) => {
    try {
        await CallLog.deleteMany({});
        res.json({ message: 'All call logs cleared' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-refresh token every 12 hours ────────────────
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
