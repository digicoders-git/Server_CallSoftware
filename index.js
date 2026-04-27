const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const axios     = require('axios');
const FormData  = require('form-data');
const AdmZip    = require('adm-zip');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { parse } = require('csv-parse/sync');
const XLSX      = require('xlsx');
const { connectDB, User, Student, CallLog, AdminUser, Assignment, Remark } = require('./database');

const app    = express();
const PORT   = process.env.PORT || 5001;
const upload = multer({ storage: multer.memoryStorage() });
const JWT_SECRET = process.env.JWT_SECRET || 'digicoders_secret_2024';

app.use(cors({ origin: ['https://client-call-software.vercel.app', 'http://localhost:5173'], credentials: true }));
app.use(express.json());

const OBD_BASE_URL = 'https://obd3api.expressivr.com';
let currentToken = null, currentUserId = null;

// ── Auth Middleware ───────────────────────────────────
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminOnly = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
};

// ── OBD Session ───────────────────────────────────────
const restoreSession = async () => {
    try {
        const user = await User.findOne().sort({ last_login: -1 });
        if (user?.obd_token) { currentToken = user.obd_token; currentUserId = user.obd_user_id; return; }
        await autoLogin();
    } catch (e) { await autoLogin(); }
};

const autoLogin = async () => {
    try {
        const r = await axios.post(`${OBD_BASE_URL}/api/obd/login`, {
            username: process.env.OBD_USERNAME || 'DigiCoders',
            password: process.env.OBD_PASSWORD || '123456789'
        });
        currentToken = r.data.token; currentUserId = r.data.userid;
        await User.findOneAndUpdate({ username: 'DigiCoders' }, { username: 'DigiCoders', obd_token: currentToken, obd_user_id: currentUserId, last_login: new Date() }, { upsert: true });
        console.log('OBD auto-login OK');
    } catch (e) { console.error('OBD login failed:', e.message); }
};

// ══════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════

// Admin/User Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await AdminUser.findOne({ username, is_active: true });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ id: user._id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, username: user.username, role: user.role, name: user.name } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// OBD Login (for OBD API access)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${OBD_BASE_URL}/api/obd/login`, { username, password });
        currentToken = response.data.token; currentUserId = response.data.userid;
        await User.findOneAndUpdate({ username }, { username, obd_token: currentToken, obd_user_id: currentUserId, last_login: new Date() }, { upsert: true });
        res.json(response.data);
    } catch (e) { res.status(500).json({ error: 'OBD Login failed' }); }
});

// ══════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════

// Create user
app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
    const { username, password, name } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        const user = await AdminUser.create({ username, password: hashed, name, role: 'user' });
        res.json({ id: user._id, username: user.username, name: user.name, role: user.role });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all users
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
    try {
        const users = await AdminUser.find({ role: 'user' }, '-password').sort({ created_at: -1 });
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete user
app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
    try {
        await AdminUser.findByIdAndDelete(req.params.id);
        await Assignment.deleteMany({ assigned_to: req.params.id });
        res.json({ message: 'User deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign records to user
app.post('/api/admin/assign', auth, adminOnly, async (req, res) => {
    const { userId, count, filters } = req.body;
    try {
        // Get already assigned call_log_ids
        const assigned = await Assignment.distinct('call_log_id');

        // Build filter for unassigned records
        const filter = { _id: { $nin: assigned } };
        if (filters?.campaignId) filter.campaign_id = filters.campaignId;
        if (filters?.status) filter.status = filters.status;
        if (filters?.startDate || filters?.endDate) {
            filter.timestamp = {};
            if (filters.startDate) filter.timestamp.$gte = new Date(filters.startDate + 'T00:00:00');
            if (filters.endDate)   filter.timestamp.$lte = new Date(filters.endDate + 'T23:59:59');
        }

        const records = await CallLog.find(filter).limit(count || 800);
        if (!records.length) return res.status(400).json({ error: 'No unassigned records available' });

        const assignments = records.map(r => ({
            call_log_id:   r._id,
            assigned_to:   userId,
            assigned_by:   req.user.id,
            phone:         r.phone,
            campaign_id:   r.campaign_id,
            campaign_name: r.campaign_name
        }));

        await Assignment.insertMany(assignments, { ordered: false });
        res.json({ assigned: assignments.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get assignment stats per user
app.get('/api/admin/assignments', auth, adminOnly, async (req, res) => {
    try {
        const stats = await Assignment.aggregate([
            { $group: { _id: '$assigned_to', count: { $sum: 1 } } },
            { $lookup: { from: 'adminusers', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { $project: { userId: '$_id', name: '$user.name', username: '$user.username', count: 1 } }
        ]);
        res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete remark (admin)
app.delete('/api/admin/remarks/:id', auth, adminOnly, async (req, res) => {
    try {
        await Remark.findByIdAndDelete(req.params.id);
        res.json({ message: 'Remark deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all remarks (admin)
app.get('/api/admin/remarks', auth, adminOnly, async (req, res) => {
    try {
        const remarks = await Remark.find().sort({ created_at: -1 }).populate('call_log_id', 'phone campaign_name');
        res.json(remarks);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════════════════

// Get assigned data for logged-in user
app.get('/api/user/data', auth, async (req, res) => {
    try {
        const { startDate, endDate, status, dtmf } = req.query;

        const assignments = await Assignment.find({ assigned_to: req.user.id }).select('call_log_id');
        const ids = assignments.map(a => a.call_log_id);

        const filter = { _id: { $in: ids } };
        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate + 'T00:00:00');
            if (endDate)   filter.timestamp.$lte = new Date(endDate + 'T23:59:59');
        }
        if (status) filter.status = status;
        if (dtmf === 'NONE') filter.dtmf = null;
        else if (dtmf) filter.dtmf = dtmf;

        const logs = await CallLog.find(filter).sort({ timestamp: -1 });

        // Get remarks for these logs
        const logIds = logs.map(l => l._id);
        const remarks = await Remark.find({ call_log_id: { $in: logIds } });
        const remarkMap = {};
        remarks.forEach(r => { remarkMap[r.call_log_id.toString()] = r; });

        const result = logs.map(l => ({
            _id:          l._id,
            campaignId:   l.campaign_id,
            campaignName: l.campaign_name,
            phone:        l.phone,
            status:       l.status,
            dtmf:         l.dtmf,
            duration:     l.duration,
            timestamp:    l.timestamp,
            agentNumber:  l.agent_number,
            hangupCause:  l.hangup_cause,
            remark:       remarkMap[l._id.toString()] || null
        }));

        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/Update remark
app.post('/api/user/remark', auth, async (req, res) => {
    const { call_log_id, remark, call_done } = req.body;
    try {
        const existing = await Remark.findOne({ call_log_id, user_id: req.user.id });
        if (existing) {
            existing.remark = remark; existing.call_done = call_done;
            await existing.save();
            return res.json(existing);
        }
        const r = await Remark.create({ call_log_id, user_id: req.user.id, user_name: req.user.name, remark, call_done });
        res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// CALL DATA (Admin sees all, User sees assigned)
// ══════════════════════════════════════════════════════
app.get('/api/call-data', auth, async (req, res) => {
    try {
        const { startDate, endDate, campaignId, status, dtmf } = req.query;

        let filter = {};

        // If user role, only show assigned records
        if (req.user.role === 'user') {
            const assignments = await Assignment.find({ assigned_to: req.user.id }).select('call_log_id');
            filter._id = { $in: assignments.map(a => a.call_log_id) };
        }

        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate + 'T00:00:00');
            if (endDate)   filter.timestamp.$lte = new Date(endDate + 'T23:59:59');
        }
        if (campaignId) filter.campaign_id = campaignId;
        if (status) filter.status = status;

        const logs = await CallLog.find(filter).sort({ timestamp: -1 });

        // Get remarks
        const logIds = logs.map(l => l._id);
        const remarks = await Remark.find({ call_log_id: { $in: logIds } });
        const remarkMap = {};
        remarks.forEach(r => { remarkMap[r.call_log_id.toString()] = r; });

        const result = logs.map(l => ({
            _id:          l._id,
            campaignId:   l.campaign_id,
            campaignName: l.campaign_name,
            phone:        l.phone,
            status:       l.status,
            dtmf:         l.dtmf,
            duration:     l.duration,
            timestamp:    l.timestamp,
            agentNumber:  l.agent_number,
            hangupCause:  l.hangup_cause,
            remark:       remarkMap[l._id.toString()] || null
        }));

        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// CAMPAIGNS
// ══════════════════════════════════════════════════════
app.get('/api/campaigns', async (req, res) => {
    if (!currentToken || !currentUserId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const r = await axios.get(`${OBD_BASE_URL}/api/obd/campaign/${currentUserId}`, { headers: { 'Authorization': `Bearer ${currentToken}` }, timeout: 15000 });
        res.json(r.data);
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ══════════════════════════════════════════════════════
// IMPORT CSV/EXCEL
// ══════════════════════════════════════════════════════
app.post('/api/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        let rows = [];
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        if (ext === 'csv') {
            rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });
        } else {
            const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        }
        if (!rows.length) return res.status(400).json({ error: 'File is empty' });

        const docs = rows.map(row => {
            const r = {};
            Object.keys(row).forEach(k => { r[k.toLowerCase().trim()] = row[k]; });
            return {
                campaign_id:   String(r.camp_id || r.campaign_id || ''),
                campaign_name: String(r.campaign_name || ''),
                phone:         String(r.bni || r.phone || r.mobile || ''),
                status:        String(r.answer_status || r.status || '').toUpperCase(),
                dtmf:          String(r.dtmf || r.dtmf_sequence || '') || null,
                duration:      parseInt(r.billing_duration || r.duration || 0),
                timestamp:     r.end_time ? new Date(r.end_time) : new Date(),
                agent_number:  String(r.agent_number || ''),
                hangup_cause:  String(r.hangup_cause || ''),
                cli:           String(r.cli || '')
            };
        }).filter(d => d.phone);

        if (!docs.length) return res.status(400).json({ error: 'No valid records' });

        let inserted = 0;
        for (let i = 0; i < docs.length; i += 500) {
            const result = await CallLog.insertMany(docs.slice(i, i + 500), { ordered: false }).catch(e => e.insertedDocs || []);
            inserted += Array.isArray(result) ? result.length : (result.length || 0);
        }
        res.json({ success: true, total: rows.length, inserted });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// WEBHOOK & CLEAR
// ══════════════════════════════════════════════════════
app.post('/api/webhook/obd', async (req, res) => {
    const d = req.body;
    try {
        await CallLog.create({ campaign_id: d.campaignId || '', phone: d.phone || '', status: (d.status || 'UNKNOWN').toUpperCase(), dtmf: d.dtmf || null, duration: parseInt(d.duration || 0) });
    } catch (e) {}
    res.json({ message: 'ok' });
});

app.delete('/api/clear-data', async (req, res) => {
    try { await CallLog.deleteMany({}); res.json({ message: 'Cleared' }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// KEEP ALIVE & TOKEN REFRESH
// ══════════════════════════════════════════════════════
setInterval(() => axios.get('https://server-callsoftware-i3m3.onrender.com/api/campaigns').catch(() => {}), 10 * 60 * 1000);
setInterval(() => autoLogin(), 12 * 60 * 60 * 1000);

// ══════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════
connectDB().then(async () => {
    await restoreSession();

    // Create default admin if not exists
    const adminExists = await AdminUser.findOne({ role: 'admin' });
    if (!adminExists) {
        const hashed = await bcrypt.hash('admin@123', 10);
        await AdminUser.create({ username: 'admin', password: hashed, name: 'Admin', role: 'admin' });
        console.log('Default admin created: admin / admin@123');
    }

    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}).catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
